import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type {
  HostRuntimeStatus,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonValue,
  RpcId
} from "@codex-remote-control/shared";

type PendingClientRequest = {
  mobileRequestId: string;
  originalRequestId: RpcId;
};

type PendingInternalRequest = {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
};

type CodexBridgeOptions = {
  command: string;
  args: string[];
  cwd?: string;
  onClientResponse: (mobileRequestId: string, response: JsonRpcResponse) => void;
  onServerRequest: (serverRequestId: RpcId, method: string, params?: JsonValue) => void;
  onServerNotification: (method: string, params?: JsonValue) => void;
  onStatus: (status: HostRuntimeStatus) => void;
  onLog: (level: "debug" | "info" | "warn" | "error", message: string, data?: JsonValue) => void;
};

export class CodexAppServerBridge {
  private proc?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private nextId = 1;
  private startPromise?: Promise<void>;
  private pendingClientRequests = new Map<RpcId, PendingClientRequest>();
  private pendingInternalRequests = new Map<RpcId, PendingInternalRequest>();

  constructor(private readonly options: CodexBridgeOptions) {}

  get status(): HostRuntimeStatus {
    return {
      codexReady: Boolean(this.proc && !this.proc.killed),
      activeThreadIds: [],
      cwd: this.options.cwd,
      message: this.proc ? "Codex app-server is running" : "Codex app-server is stopped"
    };
  }

  async sendClientRequest(mobileRequestId: string, request: JsonRpcRequest): Promise<void> {
    await this.ensureStarted();
    const id = this.nextRpcId();
    this.pendingClientRequests.set(id, {
      mobileRequestId,
      originalRequestId: request.id
    });
    this.write({
      id,
      method: request.method,
      params: request.params
    });
  }

  async sendServerResponse(serverRequestId: RpcId, response: JsonRpcResponse): Promise<void> {
    await this.ensureStarted();
    this.write({
      id: serverRequestId,
      result: response.result,
      error: response.error
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) {
      return;
    }
    const proc = this.proc;
    this.proc = undefined;
    this.lines?.close();
    proc.kill("SIGTERM");
    this.options.onStatus(this.status);
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      return;
    }

    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = undefined;
      });
    }

    return this.startPromise;
  }

  private async start(): Promise<void> {
    this.options.onLog("info", "starting codex app-server");
    const proc = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.proc = proc;
    this.options.onStatus(this.status);

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.options.onLog("debug", text);
      }
    });

    proc.on("error", (error) => {
      this.options.onLog("error", "failed to start codex app-server", {
        message: error.message
      });
      this.rejectAll(error);
      this.proc = undefined;
      this.options.onStatus(this.status);
    });

    proc.on("exit", (code, signal) => {
      this.options.onLog("warn", "codex app-server exited", {
        code,
        signal
      });
      this.rejectAll(new Error(`codex app-server exited with code ${code ?? "unknown"}`));
      this.proc = undefined;
      this.options.onStatus(this.status);
    });

    this.lines = createInterface({ input: proc.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    const initialize = await this.sendInternalRequest("initialize", {
      clientInfo: {
        name: "codex_remote_control",
        title: "Codex Remote Control",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    if (initialize.error) {
      throw new Error(initialize.error.message);
    }

    this.write({ method: "initialized", params: {} });
    this.options.onStatus(this.status);
  }

  private sendInternalRequest(method: string, params?: JsonValue): Promise<JsonRpcResponse> {
    const id = this.nextRpcId();
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pendingInternalRequests.set(id, { resolve, reject });
    });
    this.write({ id, method, params });
    return promise;
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.options.onLog("warn", "received non-json line from codex app-server", line);
      return;
    }

    if (!isRecord(message)) {
      return;
    }

    if ("id" in message && typeof message.method === "string") {
      this.options.onServerRequest(message.id as RpcId, message.method, message.params as JsonValue);
      return;
    }

    if ("id" in message) {
      const id = message.id as RpcId;
      const response = toJsonRpcResponse(message);
      const pendingClient = this.pendingClientRequests.get(id);
      if (pendingClient) {
        this.pendingClientRequests.delete(id);
        this.options.onClientResponse(pendingClient.mobileRequestId, {
          ...response,
          id: pendingClient.originalRequestId
        });
        return;
      }

      const pendingInternal = this.pendingInternalRequests.get(id);
      if (pendingInternal) {
        this.pendingInternalRequests.delete(id);
        pendingInternal.resolve(response);
        return;
      }
    }

    if (typeof message.method === "string") {
      this.options.onServerNotification(message.method, message.params as JsonValue);
    }
  }

  private write(message: unknown): void {
    if (!this.proc || this.proc.killed) {
      throw new Error("codex app-server is not running");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private nextRpcId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pendingInternalRequests.entries()) {
      this.pendingInternalRequests.delete(id);
      pending.reject(error);
    }

    for (const [id, pending] of this.pendingClientRequests.entries()) {
      this.pendingClientRequests.delete(id);
      this.options.onClientResponse(pending.mobileRequestId, {
        id: pending.originalRequestId,
        error: {
          code: -32000,
          message: error.message
        }
      });
    }
  }
}

function toJsonRpcResponse(message: Record<string, unknown>): JsonRpcResponse {
  const response: JsonRpcResponse = {
    id: message.id as RpcId
  };
  if ("result" in message) {
    response.result = message.result as JsonValue;
  }
  if ("error" in message && isRecord(message.error)) {
    response.error = {
      code: typeof message.error.code === "number" ? message.error.code : -32000,
      message: typeof message.error.message === "string" ? message.error.message : "Unknown error",
      data: message.error.data as JsonValue
    };
  }
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
