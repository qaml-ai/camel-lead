import { Failure, rpc, type WorkerEnv } from "./types.ts";
import type { ProjectRoom } from "./room.ts";
import type { SharedFile, MultipartStatus } from "./sharing.ts";

/** Transfer credentials are scoped to one file and direction; normal MCP credentials cannot use this route. */
export async function transferFile(request: Request, env: WorkerEnv, room: DurableObjectStub<ProjectRoom>, project: string, id: string) {
  if (!env.FILES) throw new Failure(503, "File storage is not configured");
  if (request.method !== "GET" && request.method !== "PUT") throw new Failure(405, "Use GET or PUT");
  const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") || "")?.[1] || "";
  const mode = request.method === "PUT" ? "upload" : "download";
  const file: SharedFile = await rpc(room, "fileToken", project, id, token, mode);
  const key = `${project}/${file.id}`;
  if (mode === "upload") {
    const multipart: MultipartStatus | null = await rpc(room, "multipartStatus", id);
    const partNumber = Number(new URL(request.url).searchParams.get("partNumber"));
    if (multipart) {
      if (file.state !== "pending") throw new Failure(409, "Upload is no longer pending");
      if (!multipart.uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > multipart.partCount)
        throw new Failure(400, "Valid multipart partNumber required");
      const expected = Math.min(multipart.partSize, file.size - (partNumber - 1) * multipart.partSize);
      const length = request.headers.get("content-length");
      if (length === null) throw new Failure(411, "Content-Length is required");
      if (!/^\d+$/.test(length) || Number(length) !== expected) throw new Failure(400, "Part size does not match");
      if (!request.body) throw new Failure(400, "Part body required");
      const part = await env.FILES.resumeMultipartUpload(key, multipart.uploadId).uploadPart(partNumber, request.body);
      return Response.json(await rpc(room, "recordPart", project, id, token, part), { headers: { "Cache-Control": "no-store" } });
    }
    if (new URL(request.url).searchParams.has("partNumber")) throw new Failure(400, "Not a multipart upload");
    const length = request.headers.get("content-length");
    if (length === null) throw new Failure(411, "Content-Length is required");
    if (!/^\d+$/.test(length) || Number(length) !== file.size) throw new Failure(400, "File size does not match the prepared upload");
    // The checksum is verified by R2. Conditional creation makes concurrent uploads immutable.
    let object: R2Object | null;
    try {
      object = await env.FILES.put(key, request.body ?? new Uint8Array(), {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: file.sha256,
        httpMetadata: { contentType: file.contentType },
      });
    } catch (error) {
      if (error instanceof Error && /checksum|digest|SHA-256/i.test(error.message))
        throw new Failure(400, "File checksum does not match the prepared upload");
      throw error;
    }
    if (object && object.size !== file.size) {
      await env.FILES.delete(key);
      throw new Failure(400, "Uploaded byte count does not match the prepared upload");
    }
    if (!object) {
      const existing = await env.FILES.head(key);
      const checksum = existing?.checksums.toJSON().sha256;
      if (!existing || existing.size !== file.size || checksum !== file.sha256)
        throw new Failure(409, "File already exists with different content");
    }
    const ready = await rpc(room, "completeUpload", project, id, token);
    return Response.json(ready, { headers: { "Cache-Control": "no-store" } });
  }
  const object = await env.FILES.get(key);
  if (!object) throw new Failure(404, "File unavailable");
  return new Response(object.body, {
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase())}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ETag: object.httpEtag,
    },
  });
}
