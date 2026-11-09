/**
 * A self-contained POSIX sh line (curl only, nothing downloaded) that long-polls until mail arrives.
 * Exit 0: the 200 body is printed. Exit 2: nothing before the overall timeout. Exit 3: the token was refused.
 * Runs in a subshell, so pasting it into an interactive shell does not close that shell.
 */
export function waitCommand(url: string, token: string, timeoutSeconds: number) {
  // Both values are single-quoted below. They come from trusted configuration and our own generator; fail closed anyway.
  if (!/^[A-Za-z0-9_-]+$/.test(token) || !/^https?:\/\/[A-Za-z0-9.:\[\]\/_-]+$/.test(url))
    throw new Error("Unsafe wait command input");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) throw new Error("Invalid timeout");
  return (
    `(T='${token}'; U='${url}?timeout=50'; F=$(mktemp) || exit 1; trap 'rm -f "$F"' EXIT; ` +
    `E=$(( $(date +%s) + ${timeoutSeconds} )); while [ "$(date +%s)" -lt "$E" ]; do ` +
    `C=$(curl -sS --max-time 60 -o "$F" -w '%{http_code}' -H "Authorization: Bearer $T" "$U" 2>/dev/null); ` +
    `case "$C" in 200) cat "$F"; echo; exit 0;; 204) ;; ` +
    `401) echo 'wait token expired: call wait_token again'; exit 3;; *) sleep 5;; esac; done; exit 2)`
  );
}
