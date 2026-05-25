import type { JsonValue } from "@codex-remote-control/shared";

export type EventEntry = {
  id: string;
  at: string;
  kind: "info" | "success" | "warning" | "error";
  title: string;
  role?: "user" | "assistant" | "system";
  body?: string;
  detail?: unknown;
};

export type EventDraft = Omit<EventEntry, "id" | "at">;

export type NotificationAction =
  | { type: "ignore" }
  | { type: "add"; event: EventDraft }
  | { type: "append"; id: string; event: EventDraft; body: string }
  | { type: "remove"; id: string }
  | { type: "upsert"; id: string; event: EventDraft };

export function displayActionForNotification(method: string, params: JsonValue | undefined): NotificationAction {
  if (method === "item/agentMessage/delta") {
    const payload = asRecord(params);
    const itemId = readString(payload, "itemId");
    const delta = readString(payload, "delta");
    if (!itemId || !delta) {
      return { type: "ignore" };
    }
    return {
      type: "append",
      id: `item:${itemId}`,
      body: delta,
      event: {
        kind: "info",
        title: "Response",
        role: "assistant"
      }
    };
  }

  if (method === "item/started" || method === "item/completed") {
    return displayActionForItem(params, method === "item/completed");
  }

  if (method === "turn/started") {
    const turn = asRecord(asRecord(params)?.turn);
    const turnId = readString(turn, "id");
    if (!turnId) {
      return { type: "ignore" };
    }
    return {
      type: "upsert",
      id: `turn:${turnId}`,
      event: {
        kind: "info",
        title: "Working",
        role: "assistant",
        body: "Codex is working on this request."
      }
    };
  }

  if (method === "turn/completed") {
    const turn = asRecord(asRecord(params)?.turn);
    const turnId = readString(turn, "id");
    const status = readString(turn, "status");
    if (!turnId) {
      return { type: "ignore" };
    }
    if (status === "completed") {
      return { type: "remove", id: `turn:${turnId}` };
    }
    const error = asRecord(turn?.error);
    return {
      type: "upsert",
      id: `turn:${turnId}`,
      event: {
        kind: status === "failed" ? "error" : "warning",
        title: status === "interrupted" ? "Interrupted" : "Turn failed",
        role: "assistant",
        body: readString(error, "message") ?? status ?? "Codex stopped before completing the turn.",
        detail: turn?.error
      }
    };
  }

  if (method === "error") {
    const payload = asRecord(params);
    return {
      type: "add",
      event: {
        kind: "error",
        title: readString(payload, "message") ?? "Codex error",
        detail: params
      }
    };
  }

  if (method === "warning" || method === "guardianWarning" || method === "configWarning") {
    const payload = asRecord(params);
    return {
      type: "add",
      event: {
        kind: "warning",
        title: readString(payload, "message") ?? readableMethod(method),
        detail: params
      }
    };
  }

  if (method === "model/rerouted") {
    return {
      type: "add",
      event: {
        kind: "info",
        title: "Model changed",
        body: modelRerouteText(params),
        detail: params
      }
    };
  }

  return { type: "ignore" };
}

export function readableMethod(method: string): string {
  return method
    .replace(/^item\//, "")
    .replace(/^turn\//, "turn ")
    .replace(/^thread\//, "thread ")
    .replace(/\/requestApproval$/, " approval")
    .replace(/\//g, " ");
}

function displayActionForItem(params: JsonValue | undefined, completed: boolean): NotificationAction {
  const item = asRecord(asRecord(params)?.item);
  const itemId = readString(item, "id");
  const itemType = readString(item, "type");
  if (!item || !itemId || !itemType) {
    return { type: "ignore" };
  }

  const id = `item:${itemId}`;
  if (itemType === "agentMessage") {
    const text = readString(item, "text") ?? "";
    if (!text && !completed) {
      return { type: "ignore" };
    }
    return {
      type: "upsert",
      id,
      event: {
        kind: completed ? "success" : "info",
        title: "Response",
        role: "assistant",
        body: text
      }
    };
  }

  if (itemType === "commandExecution") {
    const status = readString(item, "status") ?? (completed ? "completed" : "inProgress");
    const command = readString(item, "command") ?? "command";
    return {
      type: "upsert",
      id,
      event: {
        kind: statusKind(status),
        title: commandTitle(status),
        role: "assistant",
        body: command,
        detail: commandDetail(item)
      }
    };
  }

  if (itemType === "fileChange") {
    const status = readString(item, "status") ?? (completed ? "completed" : "inProgress");
    const changes = readArray(item, "changes");
    return {
      type: "upsert",
      id,
      event: {
        kind: statusKind(status),
        title: fileChangeTitle(status),
        role: "assistant",
        body: fileChangeBody(changes),
        detail: fileChangeDetail(changes)
      }
    };
  }

  if (itemType === "mcpToolCall") {
    const status = readString(item, "status") ?? (completed ? "completed" : "inProgress");
    const server = readString(item, "server");
    const tool = readString(item, "tool") ?? "tool";
    return {
      type: "upsert",
      id,
      event: {
        kind: statusKind(status),
        title: toolTitle(status),
        role: "assistant",
        body: server ? `${server}.${tool}` : tool,
        detail: toolDetail(item)
      }
    };
  }

  if (itemType === "dynamicToolCall") {
    const status = readString(item, "status") ?? (completed ? "completed" : "inProgress");
    const namespace = readString(item, "namespace");
    const tool = readString(item, "tool") ?? "tool";
    return {
      type: "upsert",
      id,
      event: {
        kind: statusKind(status),
        title: toolTitle(status),
        role: "assistant",
        body: namespace ? `${namespace}.${tool}` : tool,
        detail: toolDetail(item)
      }
    };
  }

  if (itemType === "webSearch") {
    return {
      type: "upsert",
      id,
      event: {
        kind: completed ? "success" : "info",
        title: completed ? "Web search completed" : "Searching web",
        role: "assistant",
        body: readString(item, "query") ?? "web search"
      }
    };
  }

  if (itemType === "plan") {
    const text = readString(item, "text");
    if (!text) {
      return { type: "ignore" };
    }
    return {
      type: "upsert",
      id,
      event: {
        kind: "info",
        title: "Plan",
        role: "assistant",
        body: text
      }
    };
  }

  return { type: "ignore" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" ? field : undefined;
}

function readArray(value: Record<string, unknown> | undefined, key: string): unknown[] {
  const field = value?.[key];
  return Array.isArray(field) ? field : [];
}

function statusKind(status: string): EventEntry["kind"] {
  if (status === "failed") {
    return "error";
  }
  if (status === "declined" || status === "interrupted") {
    return "warning";
  }
  if (status === "completed") {
    return "success";
  }
  return "info";
}

function commandTitle(status: string): string {
  if (status === "completed") {
    return "Command completed";
  }
  if (status === "failed") {
    return "Command failed";
  }
  if (status === "declined") {
    return "Command declined";
  }
  return "Running command";
}

function fileChangeTitle(status: string): string {
  if (status === "completed") {
    return "Files changed";
  }
  if (status === "failed") {
    return "File change failed";
  }
  if (status === "declined") {
    return "File change declined";
  }
  return "Editing files";
}

function toolTitle(status: string): string {
  if (status === "completed") {
    return "Tool completed";
  }
  if (status === "failed") {
    return "Tool failed";
  }
  return "Using tool";
}

function commandDetail(item: Record<string, unknown>): Record<string, unknown> {
  return removeEmpty({
    cwd: readString(item, "cwd"),
    exitCode: readNumber(item, "exitCode"),
    durationMs: readNumber(item, "durationMs"),
    output: readString(item, "aggregatedOutput")
  });
}

function toolDetail(item: Record<string, unknown>): Record<string, unknown> {
  return removeEmpty({
    arguments: item.arguments,
    result: item.result,
    error: item.error,
    durationMs: readNumber(item, "durationMs")
  });
}

function fileChangeBody(changes: unknown[]): string {
  const paths = changes
    .map((change) => readString(asRecord(change), "path"))
    .filter((path): path is string => Boolean(path));
  if (paths.length === 0) {
    return "File changes are being prepared.";
  }
  return paths.join("\n");
}

function fileChangeDetail(changes: unknown[]): Record<string, unknown> {
  return {
    changes: changes.map((change) => {
      const record = asRecord(change);
      return removeEmpty({
        path: readString(record, "path"),
        kind: readString(record, "kind")
      });
    })
  };
}

function modelRerouteText(params: JsonValue | undefined): string {
  const payload = asRecord(params);
  const from = readString(payload, "from") ?? readString(payload, "previousModel");
  const to = readString(payload, "to") ?? readString(payload, "model");
  if (from && to) {
    return `${from} -> ${to}`;
  }
  return to ?? "Codex switched models.";
}

function removeEmpty(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}
