import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
/** A local app-server client, not an MCP server extension. Does not answer approvals on the user's behalf. */
export class CodexRpc {
  private child = spawn("codex", ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private turns = new Map<string, { status: string }>();
  private waiters = new Map<
    string,
    {
      resolve: (value: { status: string }) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && message.method) {
        this.fail(
          new Error(
            "Codex requested client approval or another unsupported client operation. Use an interactive client; nothing was auto-approved.",
          ),
        );
        return;
      }
      if (message.id !== undefined) {
        const p = this.pending.get(message.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(message.id);
          message.error
            ? p.reject(new Error(`Codex RPC error ${message.error.code}`))
            : p.resolve(message.result);
        }
      }
      if (message.method === "turn/completed") {
        const turn = message.params.turn;
        this.turns.set(turn.id, { status: turn.status });
        const w = this.waiters.get(turn.id);
        if (w) {
          clearTimeout(w.timer);
          this.waiters.delete(turn.id);
          w.resolve(turn);
        }
      }
    });
    this.child.on("error", () =>
      this.fail(new Error("Could not start codex app-server")),
    );
    this.child.on("exit", () =>
      this.fail(new Error("Codex app-server exited")),
    );
    // Drain, but do not echo potentially sensitive SDK diagnostics or credentials.
    this.child.stderr.resume();
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const p of this.waiters.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.waiters.clear();
    this.child.kill();
  }
  call(method: string, params: unknown): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex RPC timeout"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async initialize(threadId: string) {
    await this.call("initialize", {
      clientInfo: { name: "camel-lead", version: "0.1.0" },
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    await this.call("thread/resume", { threadId });
  }
  async waitTurn(id: string): Promise<{ status: string }> {
    const turn = this.turns.get(id);
    if (turn) {
      this.turns.delete(id);
      return turn;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error("Codex turn timeout; mailbox is not acknowledged"));
      }, 300_000);
      this.waiters.set(id, {
        resolve: (value) => {
          this.turns.delete(id);
          resolve(value);
        },
        reject,
        timer,
      });
    });
  }
  close() {
    this.fail(new Error("Bridge closed"));
  }
}
