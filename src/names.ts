import { Failure } from "./types.ts";

/** One line of printable text: control and format characters become spaces, then it is capped by code points. */
export function clean(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\p{C}\p{Zl}\p{Zp}\s]+/gu, " ").trim();
  return [...text].slice(0, max).join("").trim();
}
/** A friendly label for an MCP client's self-reported `clientInfo.name`. It is a label, never an identity. */
export function clientLabel(raw: unknown) {
  const name = clean(raw, 100),
    n = name.toLowerCase();
  if (!name) return "agent";
  if (/^claude[-_ ]?code(?![a-z])/.test(n)) return "Claude Code";
  if (n.startsWith("codex")) return "Codex";
  // "pi", "pi-coding-agent": not every name that merely starts with those letters ("pieces").
  if (/^pi(?![a-z])/.test(n)) return "pi";
  if (/^cursor(?![a-z])/.test(n)) return "Cursor";
  return clean(name, 30);
}
/** 1 to 40 printable characters on one line. Refused, not repaired: the same name must always mean the same session. */
export function sessionName(raw: unknown) {
  const refused = new Failure(400, "Session name must be 1 to 40 printable characters on one line");
  if (typeof raw !== "string") throw refused;
  const name = raw.trim(),
    length = [...name].length;
  if (length < 1 || length > 40 || /[\p{C}\p{Zl}\p{Zp}]/u.test(name)) throw refused;
  return name;
}
/** "<Person>'s <Client>" or "<Person>'s <Client> · <session name>". The person always comes from verified identity. */
export function displayName(person: string, label: string, session?: string) {
  return `${person}'s ${label}${session ? ` · ${session}` : ""}`;
}
