import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import type { RpcEvent } from "@shared/types.js";

export class RpcProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private _alive = false;
  private commandId = 0;

  constructor(
    private piCommand: string,
    private cwd: string,
    private sessionFile: string | undefined,
    private env: Record<string, string>,
  ) {
    super();
  }

  get alive(): boolean {
    return this._alive;
  }

  start(): void {
    if (this._alive) return;

    const args = ["--mode", "rpc"];
    if (this.sessionFile) {
      args.push("--session", this.sessionFile);
    }

    try {
      this.proc = spawn(this.piCommand, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
      });
    } catch (err) {
      this._alive = false;
      this.emit("error", err);
      return;
    }

    this._alive = true;

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[rpc] stderr: ${text}`);
      }
    });

    this.proc.on("exit", (code) => {
      this._alive = false;
      this.emit("exit", code);
    });

    this.proc.on("error", (err) => {
      this._alive = false;
      this.emit("error", err);
    });
  }

  send(command: Record<string, unknown>): string {
    if (!this.proc || !this._alive) {
      throw new Error("RPC process is not running");
    }
    const id = String(++this.commandId);
    const msg = { ...command, id };
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    return id;
  }

  sendAndWait(
    command: Record<string, unknown>,
    timeoutMs = 10000,
  ): Promise<Record<string, unknown>> {
    const id = this.send(command);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("event", handler);
        reject(new Error(`RPC command '${command.type}' timed out`));
      }, timeoutMs);

      const handler = (event: RpcEvent) => {
        if (event.type === "response" && event.id === id) {
          clearTimeout(timer);
          this.removeListener("event", handler);
          if ((event as Record<string, unknown>).success === false) {
            reject(new Error((event as Record<string, unknown>).error as string || "RPC command failed"));
          } else {
            resolve(event as Record<string, unknown>);
          }
        }
      };

      this.on("event", handler);
    });
  }

  stop(): void {
    if (this.proc && this._alive) {
      this.proc.stdin!.end();
      this.proc.kill("SIGTERM");
      this._alive = false;
    }
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this._alive = false;
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as RpcEvent;
        this.emit("event", parsed);
      } catch {
        console.error(`[rpc] non-json: ${trimmed}`);
      }
    }
  }
}
