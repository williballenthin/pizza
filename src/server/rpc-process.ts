import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import type { RpcEvent } from "../shared/types.js";

export class RpcProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private _alive = false;
  private commandId = 0;
  private lastError: Error | null = null;

  constructor(
    private piCommand: string,
    private cwd: string,
    private sessionFile: string | undefined,
    private sessionDir: string | undefined,
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
    } else if (this.sessionDir) {
      args.push("--session-dir", this.sessionDir);
    }

    this.lastError = null;

    try {
      this.proc = spawn(this.piCommand, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        shell: process.platform === "win32",
      });
    } catch (err) {
      this._alive = false;
      this.emitRpcError(toError(err));
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
      this.emitRpcError(err);
    });
  }

  send(command: Record<string, unknown>): string {
    if (this.lastError) {
      throw this.lastError;
    }
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
    const commandType =
      typeof command.type === "string" ? command.type : "unknown";

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("event", onEvent);
        this.removeListener("error", onError);
        this.removeListener("exit", onExit);
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const onExit = (code: number | null) => {
        cleanup();
        const suffix = code === null ? "" : ` with code ${code}`;
        reject(new Error(`RPC process exited${suffix}`));
      };

      const onEvent = (event: RpcEvent) => {
        if (event.type !== "response" || event.id !== id) return;

        cleanup();
        if ((event as Record<string, unknown>).success === false) {
          reject(
            new Error(
              (event as Record<string, unknown>).error as string ||
                "RPC command failed",
            ),
          );
        } else {
          resolve(event as Record<string, unknown>);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`RPC command '${commandType}' timed out`));
      }, timeoutMs);

      this.on("event", onEvent);
      this.on("error", onError);
      this.on("exit", onExit);
    });
  }

  async stop(timeoutMs = 5000): Promise<void> {
    const proc = this.proc;
    if (!proc) return;

    const exited = waitForProcessExit(proc, timeoutMs, () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Ignore kill failures during shutdown.
      }
    });

    if (this._alive) {
      try {
        proc.stdin?.end();
      } catch {
        // Ignore stdin shutdown failures.
      }

      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore kill failures during shutdown.
      }
      this._alive = false;
    }

    await exited;
  }

  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this._alive = false;
    }
  }

  private emitRpcError(err: Error): void {
    this.lastError = err;
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
      return;
    }
    console.error(`[rpc] error: ${err.message}`);
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

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function waitForProcessExit(
  proc: ChildProcess,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      proc.removeListener("exit", onExit);
    };

    const onExit = () => {
      cleanup();
      resolve();
    };

    const timer = setTimeout(() => {
      onTimeout();
    }, timeoutMs);

    proc.once("exit", onExit);
  });
}
