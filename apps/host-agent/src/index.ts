#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import WebSocket from "ws";
import type {
  HostRuntimeStatus,
  HostToRelayMessage,
  PairingCodeResponse,
  PairingStartResponse,
  RelayToHostMessage
} from "@codex-remote-control/shared";
import { CodexAppServerBridge } from "./codexAppServer.js";

const agentVersion = "0.1.0";

type CliOptions = {
  relayUrl: string;
  hostName: string;
  hostToken?: string;
  configPath: string;
  codexCommand: string;
  codexArgs: string[];
  cwd?: string;
};

type StoredHostConfig = {
  hostId: string;
  hostToken: string;
  hostName: string;
  relayUrl: string;
  savedAt: string;
};

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
  }
}

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    relay: { type: "string", short: "r" },
    name: { type: "string", short: "n" },
    "host-token": { type: "string" },
    "codex-command": { type: "string" },
    config: { type: "string" },
    cwd: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

if (parsed.values.help) {
  printHelp();
  process.exit(0);
}

const command = parsed.positionals[0] ?? "start";
if (command !== "start" && command !== "pair") {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

const options: CliOptions = {
  relayUrl: String(parsed.values.relay ?? process.env.CODEX_REMOTE_RELAY_URL ?? process.env.ARC_RELAY_URL ?? "http://localhost:8787"),
  hostName: String(parsed.values.name ?? process.env.CODEX_REMOTE_HOST_NAME ?? process.env.ARC_HOST_NAME ?? os.hostname()),
  hostToken: String(parsed.values["host-token"] ?? process.env.CODEX_REMOTE_HOST_TOKEN ?? process.env.ARC_HOST_TOKEN ?? "") || undefined,
  configPath: String(parsed.values.config ?? process.env.CODEX_REMOTE_HOST_CONFIG ?? process.env.ARC_HOST_CONFIG ?? path.join(os.homedir(), ".codex-remote-control", "host.json")),
  codexCommand: String(parsed.values["codex-command"] ?? process.env.CODEX_COMMAND ?? "codex"),
  codexArgs: ["app-server"],
  cwd: String(parsed.values.cwd ?? process.env.CODEX_REMOTE_CODEX_CWD ?? process.env.ARC_CODEX_CWD ?? "") || undefined
};

void (command === "pair" ? printNewPairing(options) : main(options)).catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main(options: CliOptions): Promise<void> {
  const storedConfig = options.hostToken ? undefined : await loadStoredHost(options.configPath);
  let pairing: PairingCodeResponse | undefined;
  let hostToken = options.hostToken ?? storedConfig?.hostToken;

  if (!options.hostToken && storedConfig?.hostId && storedConfig.hostToken) {
    try {
      pairing = await createExistingHostPairing(options, storedConfig.hostId, storedConfig.hostToken);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) {
        throw error;
      }
      console.warn("saved host config is no longer accepted by the relay; creating a new host");
      hostToken = undefined;
    }
  }

  if (!hostToken) {
    const newPairing = await createNewHostPairing(options);
    pairing = newPairing;
    hostToken = newPairing.hostToken;
    await saveStoredHost(options.configPath, {
      hostId: newPairing.hostId,
      hostToken: newPairing.hostToken,
      hostName: options.hostName,
      relayUrl: options.relayUrl,
      savedAt: new Date().toISOString()
    });
  }

  if (!hostToken) {
    throw new Error("missing host token");
  }

  if (pairing) {
    printPairing(pairing, "Pair this host from mobile:");
    console.log("The agent will keep running and wait for paired devices.");
    console.log("");
  } else if (storedConfig) {
    console.log(`using saved host config: ${options.configPath}`);
  }

  const relayWsUrl = toRelayWsUrl(options.relayUrl, "/ws/host", hostToken);
  let relay: RelayConnection | undefined;
  const bridge = new CodexAppServerBridge({
    command: options.codexCommand,
    args: options.codexArgs,
    cwd: options.cwd,
    onClientResponse: (mobileRequestId, response) => {
      relay?.send({
        type: "codex.clientResponse",
        mobileRequestId,
        response
      });
    },
    onServerRequest: (serverRequestId, method, params) => {
      relay?.send({
        type: "codex.serverRequest",
        serverRequestId,
        method,
        params
      });
    },
    onServerNotification: (method, params) => {
      relay?.send({
        type: "codex.serverNotification",
        method,
        params
      });
    },
    onStatus: (status) => {
      relay?.send({
        type: "host.status",
        status
      });
    },
    onLog: (level, message, data) => {
      relay?.send({
        type: "host.log",
        level,
        message,
        data
      });
      if (level !== "debug") {
        console.log(`[${level}] ${message}`);
      }
    }
  });

  relay = new RelayConnection(relayWsUrl, options.hostName, bridge.status, bridge);
  relay.connect();

  process.on("SIGINT", async () => {
    console.log("stopping host agent");
    relay?.close();
    await bridge.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    relay?.close();
    await bridge.stop();
    process.exit(0);
  });
}

class RelayConnection {
  private ws?: WebSocket;
  private retryMs = 500;
  private closed = false;
  private hostId = "pending";

  constructor(
    private readonly relayWsUrl: string,
    private readonly hostName: string,
    private readonly initialStatus: HostRuntimeStatus,
    private readonly bridge: CodexAppServerBridge
  ) {}

  connect(): void {
    if (this.closed) {
      return;
    }

    const ws = new WebSocket(this.relayWsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.retryMs = 500;
      console.log("connected to relay");
    });

    ws.on("message", (raw) => {
      const message = parseWsMessage<RelayToHostMessage>(raw);
      if (message) {
        void this.handleMessage(message);
      }
    });

    ws.on("close", () => {
      if (this.closed) {
        return;
      }
      console.warn(`relay disconnected, retrying in ${this.retryMs}ms`);
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10000);
    });

    ws.on("error", (error) => {
      console.warn(`relay websocket error: ${error.message}`);
    });
  }

  send(message: HostToRelayMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private async handleMessage(message: RelayToHostMessage): Promise<void> {
    switch (message.type) {
      case "relay.hello":
        this.hostId = message.hostId;
        this.send({
          type: "host.hello",
          hostId: this.hostId,
          hostName: this.hostName,
          agentVersion,
          status: this.initialStatus
        });
        break;
      case "codex.clientRequest":
        await this.bridge.sendClientRequest(message.mobileRequestId, message.request);
        break;
      case "codex.serverResponse":
        await this.bridge.sendServerResponse(message.serverRequestId, message.response);
        break;
      case "host.shutdown":
        console.log(`shutdown requested: ${message.reason ?? "no reason"}`);
        this.close();
        await this.bridge.stop();
        process.exit(0);
    }
  }
}

async function createNewHostPairing(options: CliOptions): Promise<PairingStartResponse> {
  const response = await fetch(`${trimRight(options.relayUrl, "/")}/api/pairings`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      hostName: options.hostName,
      agentVersion
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(`pairing failed: ${response.status} ${body}`, response.status, body);
  }

  return (await response.json()) as PairingStartResponse;
}

async function createExistingHostPairing(
  options: CliOptions,
  hostId: string,
  hostToken: string
): Promise<PairingCodeResponse> {
  const response = await fetch(`${trimRight(options.relayUrl, "/")}/api/hosts/${encodeURIComponent(hostId)}/pairings`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${hostToken}`,
      "content-type": "application/json"
    },
    body: "{}"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(`pairing failed: ${response.status} ${body}`, response.status, body);
  }

  return (await response.json()) as PairingCodeResponse;
}

async function printNewPairing(options: CliOptions): Promise<void> {
  const storedConfig = options.hostToken ? undefined : await loadStoredHost(options.configPath);
  let hostToken = options.hostToken ?? storedConfig?.hostToken;
  const hostId = storedConfig?.hostId;

  if (hostToken && hostId) {
    try {
      const pairing = await createExistingHostPairing(options, hostId, hostToken);
      printPairing(pairing, "New pairing code:");
      return;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 401) {
        throw error;
      }
      console.warn("saved host config is no longer accepted by the relay; creating a new host");
      hostToken = undefined;
    }
  }

  const pairing = await createNewHostPairing(options);
  await saveStoredHost(options.configPath, {
    hostId: pairing.hostId,
    hostToken: pairing.hostToken,
    hostName: options.hostName,
    relayUrl: options.relayUrl,
    savedAt: new Date().toISOString()
  });
  printPairing(pairing, "Created a new host and pairing code:");
}

function printPairing(pairing: PairingCodeResponse, title: string): void {
  console.log("");
  console.log(title);
  console.log(`  Code: ${pairing.pairingCode}`);
  console.log(`  URL:  ${pairing.pairingUrl}`);
  console.log(`  Expires: ${new Date(pairing.expiresAt).toLocaleString()}`);
  console.log("");
  qrcode.generate(pairing.pairingUrl, { small: true });
  console.log("");
}

async function loadStoredHost(configPath: string): Promise<StoredHostConfig | undefined> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as StoredHostConfig;
  } catch {
    return undefined;
  }
}

async function saveStoredHost(configPath: string, config: StoredHostConfig): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function toRelayWsUrl(relayUrl: string, path: string, token: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  url.searchParams.set("token", token);
  return url.toString();
}

function trimRight(value: string, char: string): string {
  let result = value;
  while (result.endsWith(char)) {
    result = result.slice(0, -1);
  }
  return result;
}

function parseWsMessage<T>(raw: WebSocket.RawData): T | undefined {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw.toString();
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function printHelp(): void {
  console.log(`Usage:
  codex-remote-control-host start [options]
  codex-remote-control-host pair [options]

Options:
  -r, --relay <url>          Relay URL. Defaults to CODEX_REMOTE_RELAY_URL or http://localhost:8787
  -n, --name <name>          Host display name. Defaults to hostname
      --config <path>        Host token config. Defaults to ~/.codex-remote-control/host.json
      --host-token <token>   Existing host token. If omitted, a pairing code is created
      --codex-command <cmd>  Codex CLI command. Defaults to codex
      --cwd <path>           Working directory for codex app-server
  -h, --help                 Show help

Examples:
  codex-remote-control-host start --relay http://localhost:8787 --name "My Mac"
  codex-remote-control-host pair --relay http://localhost:8787
`);
}
