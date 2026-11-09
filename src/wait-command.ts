/**
 * A self-contained POSIX sh line (curl only, nothing downloaded) that long-polls until mail arrives.
 * Exit 0: the 200 body is printed. Exit 2: nothing before the overall timeout. Exit 3: the token was refused.
 * Exit 4: a permanent refusal (400, 403, 404).
 * Runs in a subshell, so pasting it into an interactive shell does not close that shell.
 */
export function waitCommand(url: string, token: string, timeoutSeconds: number, follow = false) {
  // Both values are single-quoted below. They come from trusted configuration and our own generator; fail closed anyway.
  if (!/^[A-Za-z0-9_-]+$/.test(token) || !/^https?:\/\/[A-Za-z0-9.:\[\]\/_-]+$/.test(url))
    throw new Error("Unsafe wait command input");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error("Invalid timeout");
  // Follow mode keeps running: each batch is one line, and `after` moves past it so nothing is printed twice.
  // The served body is compact JSON ending in "next":N}; a quote inside message text is always escaped.
  const address = follow ? `"$U&after=$A"` : `"$U"`;
  const mail = follow
    ? `tr -d '\\n' <"$F"; echo; A=$(sed -n 's/.*"next":\\([0-9][0-9]*\\)}$/\\1/p' "$F"); ` +
      `[ -n "$A" ] || { echo 'wait failed: unexpected response'; exit 4; }`
    : `cat "$F"; echo; exit 0`;
  return (
    `(T='${token}'; U='${url}?timeout=50'; ${follow ? "A=0; " : ""}F=$(mktemp) || exit 1; trap 'rm -f "$F"' EXIT; ` +
    `E=$(( $(date +%s) + ${timeoutSeconds} )); while [ "$(date +%s)" -lt "$E" ]; do ` +
    `C=$(curl -sS --max-time 60 -o "$F" -w '%{http_code}' -H "Authorization: Bearer $T" ${address} 2>/dev/null); ` +
    `case "$C" in 200) ${mail};; 204) ;; ` +
    `401) echo 'wait token expired: call wait_token again'; exit 3;; ` +
    // Permanent refusals end the loop; only 429, server errors and curl failures (000) are retried.
    `400|403|404) echo "wait failed: HTTP $C (check the project and URL, or call wait_token again)"; exit 4;; ` +
    `*) sleep 5;; esac; done; exit 2)`
  );
}
