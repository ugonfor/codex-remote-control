import { randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import webPush, { type PushSubscription } from "web-push";
import WebSocket, { WebSocketServer } from "ws";
import type {
  HostRuntimeStatus,
  HostSummary,
  HostToRelayMessage,
  AdminActionResponse,
  AdminSessionsResponse,
  AuthLoginRequest,
  AuthLoginResponse,
  MobileToRelayMessage,
  PairingClaimRequest,
  PairingCodeResponse,
  PairingStartRequest,
  RelayToHostMessage,
  RelayToMobileMessage
} from "@codex-remote-control/shared";

const port = Number(process.env.PORT ?? 8787);
const publicRelayUrl = process.env.PUBLIC_RELAY_URL ?? `http://localhost:${port}`;
const mobileAppUrl = process.env.MOBILE_APP_URL ?? "http://localhost:5173";
const pairingTtlMs = Number(process.env.PAIRING_TTL_MS ?? 10 * 60 * 1000);
const loginPassword = process.env.CODEX_REMOTE_LOGIN_PASSWORD ?? process.env.LOGIN_PASSWORD ?? "";
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT ?? "mailto:admin@example.com";

if (vapidPublicKey && vapidPrivateKey) {
  webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

type HostRecord = {
  id: string;
  name: string;
  token: string;
  pairedDeviceIds: Set<string>;
  createdAt: Date;
  pairedAt?: Date;
  lastSeenAt: Date;
  online: boolean;
  socket?: WebSocket;
  agentVersion?: string;
  status?: HostRuntimeStatus;
};

type PairingRecord = {
  code: string;
  hostId: string;
  hostToken: string;
  expiresAt: Date;
};

type DeviceRecord = {
  id: string;
  token: string;
  name: string;
  hostIds: Set<string>;
  allHosts: boolean;
  createdAt: Date;
  lastSeenAt: Date;
};

type MobileConnection = {
  id: string;
  ws: WebSocket;
  device: DeviceRecord;
  subscribedHostIds: Set<string>;
};

const hosts = new Map<string, HostRecord>();
const hostTokens = new Map<string, string>();
const pairings = new Map<string, PairingRecord>();
const devices = new Map<string, DeviceRecord>();
const deviceTokens = new Map<string, string>();
const mobileConnections = new Map<string, MobileConnection>();
const pendingMobileRequests = new Map<string, MobileConnection>();
const pushSubscriptions = new Map<string, PushSubscription[]>();

const hostWss = new WebSocketServer({ noServer: true });
const mobileWss = new WebSocketServer({ noServer: true });

const server = createServer(async (req, res) => {
  try {
    await handleHttp(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal_error" });
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = parseRequestUrl(req);

  if (url.pathname === "/ws/host") {
    hostWss.handleUpgrade(req, socket, head, (ws) => handleHostSocket(ws, req));
    return;
  }

  if (url.pathname === "/ws/mobile") {
    mobileWss.handleUpgrade(req, socket, head, (ws) => handleMobileSocket(ws, req));
    return;
  }

  socket.destroy();
});

server.listen(port, () => {
  console.log(`relay listening on ${publicRelayUrl}`);
});

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = parseRequestUrl(req);

  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    if (!loginPassword) {
      sendJson(res, 503, { error: "login_disabled" });
      return;
    }

    const body = await readJson<AuthLoginRequest>(req);
    if (typeof body.password !== "string" || body.password !== loginPassword) {
      sendJson(res, 401, { error: "invalid_password" });
      return;
    }

    const device = createDevice(normalizeDeviceName(body.deviceName), { allHosts: true });
    const response: AuthLoginResponse = {
      deviceId: device.id,
      deviceToken: device.token,
      hosts: listDeviceHosts(device)
    };
    sendJson(res, 200, response);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const device = authenticateDevice(req);
    if (device) {
      deleteDevice(device);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/sessions") {
    const device = authenticateAdminDevice(req);
    if (!device) {
      sendJson(res, 403, { error: "admin_required" });
      return;
    }
    sendJson(res, 200, toAdminSessionsResponse(device));
    return;
  }

  const adminHostShutdownMatch = /^\/api\/admin\/hosts\/([^/]+)\/shutdown$/.exec(url.pathname);
  if (req.method === "POST" && adminHostShutdownMatch) {
    const device = authenticateAdminDevice(req);
    if (!device) {
      sendJson(res, 403, { error: "admin_required" });
      return;
    }
    const host = hosts.get(decodeURIComponent(adminHostShutdownMatch[1]));
    if (!host || !host.socket || host.socket.readyState !== WebSocket.OPEN) {
      sendJson(res, 404, { error: "host_offline" });
      return;
    }
    sendHost(host.socket, {
      type: "host.shutdown",
      reason: `Requested by ${device.name}`
    });
    sendJson(res, 200, { ok: true } satisfies AdminActionResponse);
    return;
  }

  const adminHostForgetMatch = /^\/api\/admin\/hosts\/([^/]+)\/forget$/.exec(url.pathname);
  if (req.method === "POST" && adminHostForgetMatch) {
    const device = authenticateAdminDevice(req);
    if (!device) {
      sendJson(res, 403, { error: "admin_required" });
      return;
    }
    const host = hosts.get(decodeURIComponent(adminHostForgetMatch[1]));
    if (!host) {
      sendJson(res, 404, { error: "host_not_found" });
      return;
    }
    if (host.online) {
      sendJson(res, 409, { error: "host_online" });
      return;
    }
    deleteHost(host);
    sendJson(res, 200, { ok: true } satisfies AdminActionResponse);
    return;
  }

  const adminDeviceRevokeMatch = /^\/api\/admin\/devices\/([^/]+)\/revoke$/.exec(url.pathname);
  if (req.method === "POST" && adminDeviceRevokeMatch) {
    const adminDevice = authenticateAdminDevice(req);
    if (!adminDevice) {
      sendJson(res, 403, { error: "admin_required" });
      return;
    }
    const device = devices.get(decodeURIComponent(adminDeviceRevokeMatch[1]));
    if (!device) {
      sendJson(res, 404, { error: "device_not_found" });
      return;
    }
    deleteDevice(device);
    sendJson(res, 200, { ok: true } satisfies AdminActionResponse);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pairings") {
    const body = await readJson<PairingStartRequest>(req);
    const hostName = typeof body.hostName === "string" && body.hostName.trim().length > 0
      ? body.hostName.trim()
      : "Codex Host";
    const hostId = `host_${randomToken(12)}`;
    const now = new Date();
    const hostToken = `host_${randomToken(32)}`;

    const host: HostRecord = {
      id: hostId,
      name: hostName,
      token: hostToken,
      pairedDeviceIds: new Set(),
      createdAt: now,
      lastSeenAt: now,
      online: false,
      agentVersion: body.agentVersion,
      status: {
        codexReady: false,
        activeThreadIds: [],
        message: "Waiting for host agent"
      }
    };

    hosts.set(hostId, host);
    hostTokens.set(hostToken, hostId);
    const response = {
      ...createPairingForHost(host),
      hostToken
    };

    sendJson(res, 201, response);
    return;
  }

  const hostPairingMatch = /^\/api\/hosts\/([^/]+)\/pairings$/.exec(url.pathname);
  if (req.method === "POST" && hostPairingMatch) {
    const host = authenticateHost(req);
    const requestedHostId = decodeURIComponent(hostPairingMatch[1]);

    if (!host || host.id !== requestedHostId) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    sendJson(res, 201, createPairingForHost(host));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pairings/claim") {
    const body = await readJson<PairingClaimRequest>(req);
    const code = String(body.pairingCode ?? "").replace(/\D/g, "");
    const pairing = pairings.get(code);

    if (!pairing || pairing.expiresAt.getTime() < Date.now()) {
      if (pairing) {
        pairings.delete(code);
      }
      sendJson(res, 404, { error: "pairing_not_found" });
      return;
    }

    const host = hosts.get(pairing.hostId);
    if (!host) {
      sendJson(res, 404, { error: "host_not_found" });
      return;
    }

    const device = createDevice(normalizeDeviceName(body.deviceName), {
      hostIds: [host.id],
      allHosts: false
    });

    host.pairedDeviceIds.add(device.id);
    host.pairedAt = host.pairedAt ?? new Date();
    pairings.delete(code);

    const response = {
      deviceId: device.id,
      deviceToken: device.token,
      host: toHostSummary(host)
    };

    sendJson(res, 200, response);
    broadcastHost(host.id);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/hosts") {
    const device = authenticateDevice(req);
    if (!device) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    sendJson(res, 200, {
      hosts: listDeviceHosts(device)
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
    const device = authenticateDevice(req);
    if (!device) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJson<PushSubscription>(req);
    const subscriptions = pushSubscriptions.get(device.id) ?? [];
    const exists = subscriptions.some((item) => item.endpoint === body.endpoint);
    if (!exists && body.endpoint) {
      subscriptions.push(body);
      pushSubscriptions.set(device.id, subscriptions);
    }
    sendJson(res, 200, { ok: true, enabled: Boolean(vapidPublicKey && vapidPrivateKey) });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function handleHostSocket(ws: WebSocket, req: IncomingMessage): void {
  const token = getToken(req);
  const hostId = token ? hostTokens.get(token) : undefined;
  const host = hostId ? hosts.get(hostId) : undefined;

  if (!host) {
    ws.close(1008, "invalid host token");
    return;
  }

  host.socket = ws;
  host.online = true;
  host.lastSeenAt = new Date();
  host.status = host.status ?? { codexReady: false, activeThreadIds: [] };
  sendHost(ws, { type: "relay.hello", hostId: host.id, serverTime: new Date().toISOString() });
  broadcastHost(host.id);

  ws.on("message", (raw) => {
    const message = parseWsMessage<HostToRelayMessage>(raw);
    if (!message) {
      return;
    }
    handleHostMessage(host, message);
  });

  ws.on("close", () => {
    if (host.socket === ws) {
      host.socket = undefined;
      host.online = false;
      host.lastSeenAt = new Date();
      host.status = {
        ...(host.status ?? { activeThreadIds: [] }),
        codexReady: false,
        message: "Host disconnected"
      };
      broadcastHost(host.id);
    }
  });
}

function handleHostMessage(host: HostRecord, message: HostToRelayMessage): void {
  host.lastSeenAt = new Date();

  switch (message.type) {
    case "host.hello":
      host.name = message.hostName || host.name;
      host.agentVersion = message.agentVersion;
      host.status = message.status;
      broadcastHost(host.id);
      break;
    case "host.status":
      host.status = message.status;
      broadcastHost(host.id);
      break;
    case "host.log":
      console.log(`[${message.level}] ${host.name}: ${message.message}`);
      break;
    case "codex.clientResponse": {
      const target = pendingMobileRequests.get(message.mobileRequestId);
      const payload: RelayToMobileMessage = {
        type: "codex.clientResponse",
        hostId: host.id,
        mobileRequestId: message.mobileRequestId,
        response: message.response
      };
      if (target && target.ws.readyState === WebSocket.OPEN) {
        sendMobile(target.ws, payload);
      } else {
        broadcastToPairedMobiles(host.id, payload);
      }
      pendingMobileRequests.delete(message.mobileRequestId);
      break;
    }
    case "codex.serverRequest":
      broadcastToPairedMobiles(host.id, {
        type: "codex.serverRequest",
        hostId: host.id,
        serverRequestId: message.serverRequestId,
        method: message.method,
        params: message.params
      });
      if (message.method.includes("requestApproval")) {
        void sendPushToHostDevices(host.id, {
          title: "Approval needed",
          body: `${host.name}: ${readableMethod(message.method)}`,
          data: {
            hostId: host.id,
            kind: "approval"
          }
        });
      }
      break;
    case "codex.serverNotification":
      broadcastToPairedMobiles(host.id, {
        type: "codex.serverNotification",
        hostId: host.id,
        method: message.method,
        params: message.params
      });
      if (shouldNotify(message.method)) {
        void sendPushToHostDevices(host.id, {
          title: "Codex updated",
          body: `${host.name}: ${readableMethod(message.method)}`,
          data: {
            hostId: host.id,
            kind: "event"
          }
        });
      }
      break;
  }
}

function handleMobileSocket(ws: WebSocket, req: IncomingMessage): void {
  const device = authenticateDevice(req);
  if (!device) {
    ws.close(1008, "invalid device token");
    return;
  }

  device.lastSeenAt = new Date();

  const connection: MobileConnection = {
    id: `conn_${randomToken(12)}`,
    ws,
    device,
    subscribedHostIds: new Set()
  };
  mobileConnections.set(connection.id, connection);
  sendMobile(ws, { type: "relay.hello", deviceId: device.id, serverTime: new Date().toISOString() });

  ws.on("message", (raw) => {
    const message = parseWsMessage<MobileToRelayMessage>(raw);
    if (!message) {
      return;
    }
    handleMobileMessage(connection, message);
  });

  ws.on("close", () => {
    mobileConnections.delete(connection.id);
    for (const [requestId, pending] of pendingMobileRequests.entries()) {
      if (pending.id === connection.id) {
        pendingMobileRequests.delete(requestId);
      }
    }
  });
}

function handleMobileMessage(connection: MobileConnection, message: MobileToRelayMessage): void {
  connection.device.lastSeenAt = new Date();

  switch (message.type) {
    case "mobile.hello":
      if (message.deviceName) {
        connection.device.name = normalizeDeviceName(message.deviceName);
      }
      break;
    case "host.list":
      sendMobile(connection.ws, {
        type: "host.listResult",
        requestId: message.requestId,
        hosts: listDeviceHosts(connection.device)
      });
      break;
    case "host.subscribe": {
      const host = getAuthorizedHost(connection.device, message.hostId);
      if (!host) {
        sendMobile(connection.ws, {
          type: "relay.error",
          requestId: message.requestId,
          message: "Host not found or not paired"
        });
        return;
      }
      connection.subscribedHostIds.add(host.id);
      sendMobile(connection.ws, {
        type: "host.snapshot",
        requestId: message.requestId,
        host: toHostSummary(host)
      });
      break;
    }
    case "codex.clientRequest": {
      const host = getAuthorizedHost(connection.device, message.hostId);
      if (!host || !host.socket || host.socket.readyState !== WebSocket.OPEN) {
        sendMobile(connection.ws, {
          type: "codex.clientResponse",
          hostId: message.hostId,
          mobileRequestId: message.mobileRequestId,
          response: {
            id: message.request.id,
            error: {
              code: -32000,
              message: "Host is offline"
            }
          }
        });
        return;
      }
      pendingMobileRequests.set(message.mobileRequestId, connection);
      sendHost(host.socket, {
        type: "codex.clientRequest",
        mobileRequestId: message.mobileRequestId,
        request: message.request
      });
      break;
    }
    case "codex.serverResponse": {
      const host = getAuthorizedHost(connection.device, message.hostId);
      if (!host || !host.socket || host.socket.readyState !== WebSocket.OPEN) {
        sendMobile(connection.ws, {
          type: "relay.error",
          message: "Host is offline"
        });
        return;
      }
      sendHost(host.socket, {
        type: "codex.serverResponse",
        serverRequestId: message.serverRequestId,
        response: message.response
      });
      break;
    }
  }
}

function broadcastHost(hostId: string): void {
  const host = hosts.get(hostId);
  if (!host) {
    return;
  }
  broadcastToPairedMobiles(hostId, {
    type: "host.status",
    hostId,
    host: toHostSummary(host)
  });
}

function broadcastToPairedMobiles(hostId: string, message: RelayToMobileMessage): void {
  for (const connection of mobileConnections.values()) {
    if (!canAccessHost(connection.device, hostId)) {
      continue;
    }
    if (connection.ws.readyState === WebSocket.OPEN) {
      sendMobile(connection.ws, message);
    }
  }
}

function listDeviceHosts(device: DeviceRecord): HostSummary[] {
  const hostIds = device.allHosts ? Array.from(hosts.keys()) : Array.from(device.hostIds);
  return hostIds
    .map((hostId) => hosts.get(hostId))
    .filter((host): host is HostRecord => Boolean(host))
    .map(toHostSummary);
}

function getAuthorizedHost(device: DeviceRecord, hostId: string): HostRecord | undefined {
  if (!canAccessHost(device, hostId)) {
    return undefined;
  }
  return hosts.get(hostId);
}

function canAccessHost(device: DeviceRecord, hostId: string): boolean {
  return device.allHosts || device.hostIds.has(hostId);
}

function toHostSummary(host: HostRecord): HostSummary {
  return {
    id: host.id,
    name: host.name,
    online: host.online,
    pairedAt: (host.pairedAt ?? host.createdAt).toISOString(),
    lastSeenAt: host.lastSeenAt.toISOString(),
    agentVersion: host.agentVersion,
    status: host.status
  };
}

function toAdminSessionsResponse(currentDevice: DeviceRecord): AdminSessionsResponse {
  const activeConnectionCounts = new Map<string, number>();
  for (const connection of mobileConnections.values()) {
    activeConnectionCounts.set(
      connection.device.id,
      (activeConnectionCounts.get(connection.device.id) ?? 0) + 1
    );
  }

  return {
    hosts: Array.from(hosts.values()).map(toHostSummary),
    devices: Array.from(devices.values()).map((device) => ({
      id: device.id,
      name: device.name,
      allHosts: device.allHosts,
      hostIds: Array.from(device.hostIds),
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt.toISOString(),
      activeConnectionCount: activeConnectionCounts.get(device.id) ?? 0,
      current: device.id === currentDevice.id
    })),
    activeMobileConnectionCount: mobileConnections.size,
    pendingMobileRequestCount: pendingMobileRequests.size,
    pendingPairingCount: Array.from(pairings.values())
      .filter((pairing) => pairing.expiresAt.getTime() >= Date.now())
      .length
  };
}

function createDevice(name: string, options: { hostIds?: string[]; allHosts: boolean }): DeviceRecord {
  const device: DeviceRecord = {
    id: `dev_${randomToken(12)}`,
    token: `dev_${randomToken(32)}`,
    name,
    hostIds: new Set(options.hostIds ?? []),
    allHosts: options.allHosts,
    createdAt: new Date(),
    lastSeenAt: new Date()
  };
  devices.set(device.id, device);
  deviceTokens.set(device.token, device.id);
  return device;
}

function deleteDevice(device: DeviceRecord): void {
  devices.delete(device.id);
  deviceTokens.delete(device.token);
  pushSubscriptions.delete(device.id);
  for (const host of hosts.values()) {
    host.pairedDeviceIds.delete(device.id);
  }
  for (const [connectionId, connection] of mobileConnections.entries()) {
    if (connection.device.id === device.id) {
      connection.ws.close(1008, "logged out");
      mobileConnections.delete(connectionId);
    }
  }
}

function deleteHost(host: HostRecord): void {
  if (host.socket && host.socket.readyState === WebSocket.OPEN) {
    host.socket.close(1008, "forgotten");
  }
  hosts.delete(host.id);
  hostTokens.delete(host.token);
  for (const pairing of pairings.values()) {
    if (pairing.hostId === host.id) {
      pairings.delete(pairing.code);
    }
  }
  for (const device of devices.values()) {
    device.hostIds.delete(host.id);
  }
  for (const connection of mobileConnections.values()) {
    connection.subscribedHostIds.delete(host.id);
  }
}

function authenticateDevice(req: IncomingMessage): DeviceRecord | undefined {
  const token = getToken(req);
  const deviceId = token ? deviceTokens.get(token) : undefined;
  return deviceId ? devices.get(deviceId) : undefined;
}

function authenticateAdminDevice(req: IncomingMessage): DeviceRecord | undefined {
  const device = authenticateDevice(req);
  return device?.allHosts ? device : undefined;
}

function authenticateHost(req: IncomingMessage): HostRecord | undefined {
  const token = getToken(req);
  const hostId = token ? hostTokens.get(token) : undefined;
  return hostId ? hosts.get(hostId) : undefined;
}

function getToken(req: IncomingMessage): string | undefined {
  const url = parseRequestUrl(req);
  const queryToken = url.searchParams.get("token");
  if (queryToken) {
    return queryToken;
  }

  const header = req.headers.authorization;
  if (!header) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

function parseRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", publicRelayUrl);
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setCorsHeaders(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {} as T;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function sendHost(ws: WebSocket, message: RelayToHostMessage): void {
  ws.send(JSON.stringify(message));
}

function sendMobile(ws: WebSocket, message: RelayToMobileMessage): void {
  ws.send(JSON.stringify(message));
}

function parseWsMessage<T>(raw: WebSocket.RawData): T | undefined {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw.toString();
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function createPairingCode(): string {
  let code = "";
  do {
    code = String(randomInt(100000, 999999));
  } while (pairings.has(code));
  return code;
}

function createPairingForHost(host: HostRecord): PairingCodeResponse {
  const code = createPairingCode();
  const expiresAt = new Date(Date.now() + pairingTtlMs);
  pairings.set(code, {
    code,
    hostId: host.id,
    hostToken: host.token,
    expiresAt
  });

  return {
    hostId: host.id,
    pairingCode: code,
    pairingUrl: `${mobileAppUrl}/pair?code=${encodeURIComponent(code)}&relay=${encodeURIComponent(publicRelayUrl)}`,
    expiresAt: expiresAt.toISOString()
  };
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function normalizeDeviceName(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    return "Mobile device";
  }
  return input.trim().slice(0, 80);
}

async function sendPushToHostDevices(
  hostId: string,
  payload: { title: string; body: string; data?: Record<string, string> }
): Promise<void> {
  if (!vapidPublicKey || !vapidPrivateKey) {
    return;
  }

  const host = hosts.get(hostId);
  if (!host) {
    return;
  }

  const targetDeviceIds = new Set(host.pairedDeviceIds);
  for (const device of devices.values()) {
    if (device.allHosts) {
      targetDeviceIds.add(device.id);
    }
  }

  await Promise.all(Array.from(targetDeviceIds).map(async (deviceId) => {
    const subscriptions = pushSubscriptions.get(deviceId) ?? [];
    const nextSubscriptions: PushSubscription[] = [];

    for (const subscription of subscriptions) {
      try {
        await webPush.sendNotification(subscription, JSON.stringify(payload));
        nextSubscriptions.push(subscription);
      } catch (error) {
        const statusCode = isWebPushError(error) ? error.statusCode : undefined;
        if (statusCode && statusCode !== 404 && statusCode !== 410) {
          console.warn(`push failed for ${deviceId}: ${statusCode}`);
          nextSubscriptions.push(subscription);
        }
      }
    }

    pushSubscriptions.set(deviceId, nextSubscriptions);
  }));
}

function shouldNotify(method: string): boolean {
  return method === "turn/completed"
    || method === "thread/status/changed"
    || method === "turn/status/changed";
}

function readableMethod(method: string): string {
  return method
    .replace(/^item\//, "")
    .replace(/^turn\//, "turn ")
    .replace(/^thread\//, "thread ")
    .replace(/\/requestApproval$/, " approval")
    .replace(/\//g, " ");
}

function isWebPushError(error: unknown): error is { statusCode: number } {
  return typeof error === "object"
    && error !== null
    && "statusCode" in error
    && typeof (error as { statusCode?: unknown }).statusCode === "number";
}
