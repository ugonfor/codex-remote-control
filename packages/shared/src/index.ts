export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type RpcId = string | number;

export type JsonRpcRequest = {
  id: RpcId;
  method: string;
  params?: JsonValue;
};

export type JsonRpcNotification = {
  method: string;
  params?: JsonValue;
};

export type JsonRpcResponse = {
  id: RpcId;
  result?: JsonValue;
  error?: {
    code: number;
    message: string;
    data?: JsonValue;
  };
};

export type HostSummary = {
  id: string;
  name: string;
  online: boolean;
  pairedAt: string;
  lastSeenAt: string;
  agentVersion?: string;
  status?: HostRuntimeStatus;
};

export type HostRuntimeStatus = {
  codexReady: boolean;
  activeThreadIds: string[];
  cwd?: string;
  message?: string;
};

export type PairingStartRequest = {
  hostName: string;
  agentVersion?: string;
};

export type PairingStartResponse = {
  hostId: string;
  hostToken: string;
  pairingCode: string;
  pairingUrl: string;
  expiresAt: string;
};

export type PairingCodeResponse = {
  hostId: string;
  pairingCode: string;
  pairingUrl: string;
  expiresAt: string;
};

export type PairingClaimRequest = {
  pairingCode: string;
  deviceName: string;
};

export type PairingClaimResponse = {
  deviceId: string;
  deviceToken: string;
  host: HostSummary;
};

export type AuthLoginRequest = {
  password: string;
  deviceName: string;
};

export type AuthLoginResponse = {
  deviceId: string;
  deviceToken: string;
  hosts: HostSummary[];
};

export type HostToRelayMessage =
  | {
      type: "host.hello";
      hostId: string;
      hostName: string;
      agentVersion: string;
      status: HostRuntimeStatus;
    }
  | {
      type: "host.status";
      status: HostRuntimeStatus;
    }
  | {
      type: "host.log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      data?: JsonValue;
    }
  | {
      type: "codex.clientResponse";
      mobileRequestId: string;
      response: JsonRpcResponse;
    }
  | {
      type: "codex.serverRequest";
      serverRequestId: RpcId;
      method: string;
      params?: JsonValue;
    }
  | {
      type: "codex.serverNotification";
      method: string;
      params?: JsonValue;
    };

export type RelayToHostMessage =
  | {
      type: "relay.hello";
      hostId: string;
      serverTime: string;
    }
  | {
      type: "codex.clientRequest";
      mobileRequestId: string;
      request: JsonRpcRequest;
    }
  | {
      type: "codex.serverResponse";
      serverRequestId: RpcId;
      response: JsonRpcResponse;
    }
  | {
      type: "host.shutdown";
      reason?: string;
    };

export type MobileToRelayMessage =
  | {
      type: "mobile.hello";
      deviceName?: string;
    }
  | {
      type: "host.list";
      requestId: string;
    }
  | {
      type: "host.subscribe";
      requestId: string;
      hostId: string;
    }
  | {
      type: "codex.clientRequest";
      hostId: string;
      mobileRequestId: string;
      request: JsonRpcRequest;
    }
  | {
      type: "codex.serverResponse";
      hostId: string;
      serverRequestId: RpcId;
      response: JsonRpcResponse;
    };

export type RelayToMobileMessage =
  | {
      type: "relay.hello";
      deviceId: string;
      serverTime: string;
    }
  | {
      type: "host.listResult";
      requestId: string;
      hosts: HostSummary[];
    }
  | {
      type: "host.snapshot";
      requestId?: string;
      host: HostSummary;
    }
  | {
      type: "host.status";
      hostId: string;
      host: HostSummary;
    }
  | {
      type: "codex.clientResponse";
      hostId: string;
      mobileRequestId: string;
      response: JsonRpcResponse;
    }
  | {
      type: "codex.serverRequest";
      hostId: string;
      serverRequestId: RpcId;
      method: string;
      params?: JsonValue;
    }
  | {
      type: "codex.serverNotification";
      hostId: string;
      method: string;
      params?: JsonValue;
    }
  | {
      type: "relay.error";
      requestId?: string;
      message: string;
    };

export const CODEX_REMOTE_CONTROL_PROTOCOL_VERSION = "0.1.0";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
