import type { MessageDetails } from "../src/sharing.ts";
export interface Event extends Partial<MessageDetails> {
  seq: number;
  id: string;
  text: string;
  kind: string;
  requestId: string | null;
}
export class LeadClient {
  readonly url: string;
  readonly project: string;
  private token: string;
  private fetcher: typeof fetch;
  constructor(
    url: string,
    project: string,
    token: string,
    fetcher: typeof fetch = fetch,
  ) {
    this.url = url;
    this.project = project;
    this.token = token;
    this.fetcher = fetcher;
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(parsed.hostname)
    )
      throw new Error("HTTPS required");
  }
  async call(path: string, body?: unknown) {
    const response = await this.fetcher(
      `${this.url.replace(/\/$/, "")}/projects/${encodeURIComponent(this.project)}/${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`Lead adapter HTTP ${response.status}`);
    return response.json() as Promise<any>;
  }
  async events(): Promise<Event[]> {
    return (await this.call("messages")).events;
  }
  async ack(seq: number) {
    return this.call("ack", { seq });
  }
}
