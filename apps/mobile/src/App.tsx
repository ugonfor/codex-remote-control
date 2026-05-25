import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bell,
  BookOpen,
  Check,
  ChevronDown,
  CircleStop,
  KeyRound,
  Link2,
  MoreHorizontal,
  PlugZap,
  Plus,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck,
  Smartphone,
  TerminalSquare,
  X
} from "lucide-react";
import type {
  AuthLoginResponse,
  HostSummary,
  JsonRpcResponse,
  JsonValue,
  PairingClaimResponse,
  RelayToMobileMessage
} from "@codex-remote-control/shared";

type EventEntry = {
  id: string;
  at: string;
  kind: "info" | "success" | "warning" | "error";
  title: string;
  detail?: unknown;
};

type PendingServerRequest = {
  id: string | number;
  hostId: string;
  method: string;
  params?: JsonValue;
};

const relayUrlKey = "codexRemoteControl.relayUrl";
const deviceTokenKey = "codexRemoteControl.deviceToken";
const deviceIdKey = "codexRemoteControl.deviceId";
const activeHostIdKey = "codexRemoteControl.activeHostId";
const legacyRelayUrlKey = "arc.relayUrl";
const legacyDeviceTokenKey = "arc.deviceToken";
const legacyDeviceIdKey = "arc.deviceId";
const legacyActiveHostIdKey = "arc.activeHostId";

export function App() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const isHelpPage = window.location.pathname === "/help";
  const hasPairingCode = Boolean(query.get("code"));
  const [relayUrl, setRelayUrl] = useState(
    query.get("relay") ?? localStorage.getItem(relayUrlKey) ?? localStorage.getItem(legacyRelayUrlKey) ?? defaultRelayUrl()
  );
  const [pairingCode, setPairingCode] = useState(query.get("code") ?? "");
  const [deviceToken, setDeviceToken] = useState(hasPairingCode ? "" : localStorage.getItem(deviceTokenKey) ?? localStorage.getItem(legacyDeviceTokenKey) ?? "");
  const [deviceId, setDeviceId] = useState(hasPairingCode ? "" : localStorage.getItem(deviceIdKey) ?? localStorage.getItem(legacyDeviceIdKey) ?? "");
  const [hosts, setHosts] = useState<HostSummary[]>([]);
  const [activeHostId, setActiveHostId] = useState(localStorage.getItem(activeHostIdKey) ?? localStorage.getItem(legacyActiveHostIdKey) ?? "");
  const [socketState, setSocketState] = useState<"closed" | "connecting" | "open">("closed");
  const [pushState, setPushState] = useState<"idle" | "enabled" | "blocked" | "unsupported">("idle");
  const [authView, setAuthView] = useState<"login" | "pair">(hasPairingCode ? "pair" : "login");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginState, setLoginState] = useState<"idle" | "loggingIn" | "failed">("idle");
  const [loginMessage, setLoginMessage] = useState("");
  const [pairingState, setPairingState] = useState<"idle" | "pairing" | "paired" | "failed">("idle");
  const [pairingMessage, setPairingMessage] = useState("");
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [pendingRequests, setPendingRequests] = useState<PendingServerRequest[]>([]);
  const [threadId, setThreadId] = useState("");
  const [prompt, setPrompt] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const autoPairAttemptedRef = useRef(false);
  const responseHandlers = useRef(new Map<string, (response: JsonRpcResponse) => void>());

  const activeHost = hosts.find((host) => host.id === activeHostId) ?? hosts[0];

  const addEvent = useCallback((entry: Omit<EventEntry, "id" | "at">) => {
    setEvents((current) => [
      {
        id: createId(),
        at: new Date().toLocaleTimeString(),
        ...entry
      },
      ...current
    ].slice(0, 80));
  }, []);

  const send = useCallback((message: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addEvent({ kind: "error", title: "Relay socket is closed" });
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  }, [addEvent]);

  const refreshHosts = useCallback(() => {
    send({
      type: "host.list",
      requestId: createId()
    });
  }, [send]);

  useEffect(() => {
    localStorage.setItem(relayUrlKey, relayUrl);
  }, [relayUrl]);

  useEffect(() => {
    if (!deviceToken) {
      return;
    }

    let disposed = false;
    setSocketState("connecting");
    const ws = new WebSocket(toWsUrl(relayUrl, "/ws/mobile", deviceToken));
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      if (disposed) {
        return;
      }
      setSocketState("open");
      ws.send(JSON.stringify({ type: "mobile.hello", deviceName: defaultDeviceName() }));
      ws.send(JSON.stringify({ type: "host.list", requestId: createId() }));
    });

    ws.addEventListener("message", (event) => {
      if (disposed) {
        return;
      }
      const message = parseMessage<RelayToMobileMessage>(event.data);
      if (!message) {
        return;
      }
      handleRelayMessage(message);
    });

    ws.addEventListener("close", (event) => {
      if (disposed || wsRef.current !== ws) {
        return;
      }
      setSocketState("closed");
      if (event.code === 1008) {
        localStorage.removeItem(deviceTokenKey);
        localStorage.removeItem(deviceIdKey);
        localStorage.removeItem(activeHostIdKey);
        setDeviceToken("");
        setDeviceId("");
        setHosts([]);
        setActiveHostId("");
        setPairingState("failed");
        setPairingMessage("Saved device session expired. Sign in again.");
      }
    });

    ws.addEventListener("error", () => {
      if (disposed || wsRef.current !== ws) {
        return;
      }
      setSocketState("closed");
      addEvent({ kind: "error", title: "Relay connection failed" });
    });

    return () => {
      disposed = true;
      ws.close();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [deviceToken, relayUrl]);

  useEffect(() => {
    if (!activeHostId && hosts.length > 0) {
      const nextHostId = hosts[0].id;
      setActiveHostId(nextHostId);
      localStorage.setItem(activeHostIdKey, nextHostId);
    }
  }, [activeHostId, hosts]);

  useEffect(() => {
    if (!activeHostId || socketState !== "open") {
      return;
    }
    send({
      type: "host.subscribe",
      requestId: createId(),
      hostId: activeHostId
    });
  }, [activeHostId, send, socketState]);

  const handleRelayMessage = useCallback((message: RelayToMobileMessage) => {
    switch (message.type) {
      case "relay.hello":
        setDeviceId(message.deviceId);
        localStorage.setItem(deviceIdKey, message.deviceId);
        break;
      case "host.listResult":
        setHosts(message.hosts);
        break;
      case "host.snapshot":
        upsertHost(message.host);
        break;
      case "host.status":
        upsertHost(message.host);
        break;
      case "codex.clientResponse": {
        const handler = responseHandlers.current.get(message.mobileRequestId);
        if (handler) {
          responseHandlers.current.delete(message.mobileRequestId);
          handler(message.response);
        }
        if (message.response.error) {
          addEvent({
            kind: "error",
            title: message.response.error.message,
            detail: message.response.error
          });
        }
        break;
      }
      case "codex.serverRequest":
        setPendingRequests((current) => [
          ...current.filter((item) => item.id !== message.serverRequestId),
          {
            id: message.serverRequestId,
            hostId: message.hostId,
            method: message.method,
            params: message.params
          }
        ]);
        addEvent({
          kind: "warning",
          title: readableMethod(message.method),
          detail: message.params
        });
        break;
      case "codex.serverNotification":
        addEvent({
          kind: eventKind(message.method),
          title: readableMethod(message.method),
          detail: message.params
        });
        break;
      case "relay.error":
        addEvent({ kind: "error", title: message.message });
        break;
    }
  }, [addEvent]);

  const pairDevice = useCallback(async () => {
    const code = pairingCode.replace(/\D/g, "");
    if (!code) {
      addEvent({ kind: "error", title: "Pairing code is required" });
      setPairingState("failed");
      setPairingMessage("Pairing code is required.");
      return;
    }

    setPairingState("pairing");
    setPairingMessage("Pairing with host...");

    try {
      const response = await fetch(`${trimRight(relayUrl, "/")}/api/pairings/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pairingCode: code,
          deviceName: defaultDeviceName()
        })
      });

      if (!response.ok) {
        const message = response.status === 404
          ? "Pairing code is invalid or already used. Generate a new code on the host."
          : `Pairing failed: ${response.status}`;
        setPairingState("failed");
        setPairingMessage(message);
        addEvent({ kind: "error", title: message });
        return;
      }

      const result = (await response.json()) as PairingClaimResponse;
      setDeviceToken(result.deviceToken);
      setDeviceId(result.deviceId);
      setHosts([result.host]);
      setActiveHostId(result.host.id);
      setPairingState("paired");
      setPairingMessage(`Paired with ${result.host.name}.`);
      localStorage.setItem(deviceTokenKey, result.deviceToken);
      localStorage.setItem(deviceIdKey, result.deviceId);
      localStorage.setItem(activeHostIdKey, result.host.id);
      addEvent({ kind: "success", title: `Paired with ${result.host.name}` });
    } catch {
      const message = "Cannot reach relay. Check that the phone is on the same network.";
      setPairingState("failed");
      setPairingMessage(message);
      addEvent({ kind: "error", title: message });
    }
  }, [addEvent, pairingCode, relayUrl]);

  const login = useCallback(async () => {
    if (!loginPassword) {
      setLoginState("failed");
      setLoginMessage("Password is required.");
      return;
    }

    setLoginState("loggingIn");
    setLoginMessage("Signing in...");

    try {
      const response = await fetch(`${trimRight(relayUrl, "/")}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          password: loginPassword,
          deviceName: defaultDeviceName()
        })
      });

      if (!response.ok) {
        const message = response.status === 503
          ? "Login is not enabled on this relay. Set CODEX_REMOTE_LOGIN_PASSWORD."
          : response.status === 401
            ? "Password is incorrect."
            : `Login failed: ${response.status}`;
        setLoginState("failed");
        setLoginMessage(message);
        addEvent({ kind: "error", title: message });
        return;
      }

      const result = (await response.json()) as AuthLoginResponse;
      setDeviceToken(result.deviceToken);
      setDeviceId(result.deviceId);
      setHosts(result.hosts);
      const nextHostId = result.hosts[0]?.id ?? "";
      setActiveHostId(nextHostId);
      setLoginPassword("");
      setLoginState("idle");
      setLoginMessage("");
      localStorage.setItem(deviceTokenKey, result.deviceToken);
      localStorage.setItem(deviceIdKey, result.deviceId);
      if (nextHostId) {
        localStorage.setItem(activeHostIdKey, nextHostId);
      }
      addEvent({ kind: "success", title: "Signed in" });
    } catch {
      const message = "Cannot reach relay. Check that the phone is on the same network.";
      setLoginState("failed");
      setLoginMessage(message);
      addEvent({ kind: "error", title: message });
    }
  }, [addEvent, loginPassword, relayUrl]);

  useEffect(() => {
    if (!hasPairingCode || deviceToken || pairingState !== "idle" || autoPairAttemptedRef.current) {
      return;
    }
    autoPairAttemptedRef.current = true;
    void pairDevice();
  }, [deviceToken, hasPairingCode, pairDevice, pairingState]);

  const sendCodexRequest = useCallback((
    method: string,
    params: JsonValue | undefined,
    onResponse?: (response: JsonRpcResponse) => void
  ) => {
    if (!activeHost) {
      addEvent({ kind: "error", title: "No host selected" });
      return "";
    }
    const mobileRequestId = createId();
    const requestId = createId();
    if (onResponse) {
      responseHandlers.current.set(mobileRequestId, onResponse);
    }
    send({
      type: "codex.clientRequest",
      hostId: activeHost.id,
      mobileRequestId,
      request: {
        id: requestId,
        method,
        params
      }
    });
    return mobileRequestId;
  }, [activeHost, addEvent, send]);

  const submitPrompt = useCallback(() => {
    const text = prompt.trim();
    if (!text) {
      return;
    }

    const startTurn = (targetThreadId: string) => {
      sendCodexRequest("turn/start", {
        threadId: targetThreadId,
        input: [{ type: "text", text }]
      });
      setPrompt("");
      addEvent({ kind: "info", title: "Turn started", detail: { text } });
    };

    if (threadId) {
      startTurn(threadId);
      return;
    }

    sendCodexRequest("thread/start", {}, (response) => {
      if (response.error) {
        return;
      }
      const nextThreadId = readThreadId(response.result);
      if (!nextThreadId) {
        addEvent({ kind: "error", title: "thread/start did not return a thread id", detail: response.result });
        return;
      }
      setThreadId(nextThreadId);
      startTurn(nextThreadId);
    });
  }, [addEvent, prompt, sendCodexRequest, threadId]);

  const approveRequest = useCallback((request: PendingServerRequest, decision: string) => {
    send({
      type: "codex.serverResponse",
      hostId: request.hostId,
      serverRequestId: request.id,
      response: {
        id: request.id,
        result: { decision }
      }
    });
    setPendingRequests((current) => current.filter((item) => item.id !== request.id));
    addEvent({ kind: "success", title: `${decision}: ${readableMethod(request.method)}` });
  }, [addEvent, send]);

  const interrupt = useCallback(() => {
    if (!threadId) {
      return;
    }
    sendCodexRequest("turn/interrupt", { threadId });
  }, [sendCodexRequest, threadId]);

  const startNewTask = useCallback(() => {
    setThreadId("");
    setPendingRequests([]);
    addEvent({ kind: "info", title: "New task ready" });
  }, [addEvent]);

  const logout = useCallback(() => {
    if (deviceToken) {
      void fetch(`${trimRight(relayUrl, "/")}/api/auth/logout`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deviceToken}`
        }
      }).catch(() => undefined);
    }
    localStorage.removeItem(deviceTokenKey);
    localStorage.removeItem(deviceIdKey);
    localStorage.removeItem(activeHostIdKey);
    setDeviceToken("");
    setDeviceId("");
    setHosts([]);
    setActiveHostId("");
    setThreadId("");
    wsRef.current?.close();
  }, [deviceToken, relayUrl]);

  const enablePush = useCallback(async () => {
    const publicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
    if (!publicKey || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setPushState("unsupported");
      addEvent({ kind: "warning", title: "Push is unavailable" });
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushState("blocked");
      addEvent({ kind: "warning", title: "Notifications blocked" });
      return;
    }

    const registration = await navigator.serviceWorker.register("/sw.js");
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    const response = await fetch(`${trimRight(relayUrl, "/")}/api/push/subscribe`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(subscription)
    });

    if (!response.ok) {
      addEvent({ kind: "error", title: `Push registration failed: ${response.status}` });
      return;
    }

    setPushState("enabled");
    addEvent({ kind: "success", title: "Notifications enabled" });
  }, [addEvent, deviceToken, relayUrl]);

  const projectName = workspaceName(activeHost?.status?.cwd);
  const orderedEvents = [...events].reverse();
  const hasSessionContent = orderedEvents.length > 0 || pendingRequests.length > 0;

  return (
    <main className={deviceToken && !isHelpPage ? "shell app-shell" : "shell"}>
      {isHelpPage ? (
        <>
          <header className="topbar utility-topbar">
            <div className="brand">
              <TerminalSquare size={22} />
              <div>
                <strong>Codex Remote Control</strong>
                <span>Help</span>
              </div>
            </div>
            <a className="icon-button" href="/" aria-label="Back to controller" title="Back to controller">
              <ArrowLeft size={18} />
            </a>
          </header>
          <HelpPage relayUrl={relayUrl} mobileUrl={window.location.origin} />
        </>
      ) : !deviceToken ? (
        <>
          <header className="topbar utility-topbar">
            <div className="brand">
              <TerminalSquare size={22} />
              <div>
                <strong>Codex Remote Control</strong>
                <span>Remote session</span>
              </div>
            </div>
            <a className="icon-button" href="/help" aria-label="Help" title="Help">
              <BookOpen size={18} />
            </a>
          </header>
          <section className="pairing-layout">
            <div className="panel pairing-panel">
              <div className="panel-title">
                {authView === "login" ? <KeyRound size={20} /> : <Smartphone size={20} />}
                <h1>{authView === "login" ? "Sign In" : "Pair Device"}</h1>
              </div>
              <label>
                Relay
                <input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} />
              </label>
              {authView === "login" ? (
                <>
                  <label>
                    Password
                    <input
                      value={loginPassword}
                      onChange={(event) => setLoginPassword(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void login();
                        }
                      }}
                      type="password"
                      autoComplete="current-password"
                    />
                  </label>
                  <button className="primary-action" onClick={login}>
                    <KeyRound size={18} />
                    {loginState === "loggingIn" ? "Signing in..." : "Sign In"}
                  </button>
                  {loginMessage ? <p className={`pairing-message ${loginState === "failed" ? "failed" : ""}`}>{loginMessage}</p> : null}
                  <button className="link-action" onClick={() => setAuthView("pair")}>
                    Use pairing code instead
                  </button>
                </>
              ) : (
                <>
                  <label>
                    Pairing code
                    <input
                      value={pairingCode}
                      onChange={(event) => setPairingCode(event.target.value)}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                    />
                  </label>
                  <button className="primary-action" onClick={pairDevice}>
                    <Link2 size={18} />
                    {pairingState === "pairing" ? "Pairing..." : "Pair"}
                  </button>
                  {pairingMessage ? <p className={`pairing-message ${pairingState}`}>{pairingMessage}</p> : null}
                  <button className="link-action" onClick={() => setAuthView("login")}>
                    Sign in with password
                  </button>
                </>
              )}
            </div>
          </section>
        </>
      ) : (
        <section className="code-layout">
          <aside className="code-sidebar">
            <div className="sidebar-head">
              <div className="sidebar-brand">
                <strong>Codex Remote</strong>
                <span>control</span>
              </div>
              <a className="sidebar-icon" href="/help" aria-label="Help" title="Help">
                <BookOpen size={17} />
              </a>
            </div>

            <nav className="sidebar-nav" aria-label="Session tools">
              <button onClick={startNewTask}>
                <Plus size={16} />
                New session
              </button>
              <button type="button">
                <PlugZap size={16} />
                Routines
              </button>
              <button type="button">
                <Settings size={16} />
                Customize
              </button>
              <button type="button">
                <MoreHorizontal size={16} />
                More
              </button>
            </nav>

            <div className="recents-head">
              <span>Recents</span>
              <button onClick={refreshHosts} aria-label="Refresh hosts" title="Refresh hosts">
                <RefreshCw size={15} />
              </button>
            </div>

            <div className="host-list side-hosts">
              {hosts.map((host) => (
                <button
                  key={host.id}
                  className={`host-row ${activeHost?.id === host.id ? "selected" : ""}`}
                  onClick={() => {
                    setActiveHostId(host.id);
                    localStorage.setItem(activeHostIdKey, host.id);
                  }}
                >
                  <span className={`status-dot ${host.online ? "online" : ""}`} />
                  <span>
                    <strong>{host.name}</strong>
                    <small>{host.online ? "online" : "offline"}</small>
                  </span>
                </button>
              ))}
              {hosts.length === 0 ? <p className="muted">No hosts</p> : null}
            </div>

            <div className="sidebar-footer">
              <span className="user-mark">HR</span>
              <span>{shortId(deviceId)}</span>
              <button onClick={logout} aria-label="Log out" title="Log out">
                <PlugZap size={15} />
              </button>
            </div>
          </aside>

          <section className="session-pane">
            <header className="session-header">
              <button className="workspace-crumb" type="button">
                <span>{activeHost?.name ?? "Host"}</span>
                <span>/</span>
                <strong>{projectName}</strong>
                <ChevronDown size={15} />
              </button>
              <div className="session-actions">
                <span className={`online-state ${activeHost?.online && socketState === "open" ? "online" : ""}`}>
                  {activeHost?.online && socketState === "open" ? "online" : socketState}
                </span>
                <button onClick={refreshHosts} aria-label="Refresh hosts" title="Refresh hosts">
                  <RefreshCw size={17} />
                </button>
                {import.meta.env.VITE_VAPID_PUBLIC_KEY ? (
                  <button onClick={enablePush} aria-label="Enable notifications" title={pushState}>
                    <Bell size={17} />
                  </button>
                ) : null}
              </div>
            </header>

            <div className="session-body">
              <div className="conversation">
                {!hasSessionContent ? (
                  <div className="empty-session">
                    <TerminalSquare size={22} />
                    <h1>{projectName}</h1>
                    <p>Codex에게 작업을 보내면 이곳에 진행 상황과 승인 요청이 쌓입니다.</p>
                  </div>
                ) : null}

                {orderedEvents.map((event) => {
                  const userText = readUserPrompt(event.detail);
                  const isUser = event.title === "Turn started" && userText;

                  return (
                    <article className={`message-row ${isUser ? "user" : "assistant"} ${event.kind}`} key={event.id}>
                      <div className="message-meta">
                        <span>{isUser ? "You" : event.kind === "warning" ? "Approval" : "Codex"}</span>
                        <time>{event.at}</time>
                      </div>
                      <div className="message-bubble">
                        {isUser ? (
                          <p>{userText}</p>
                        ) : (
                          <>
                            <strong>{event.title}</strong>
                            {event.detail ? <pre>{formatJson(event.detail)}</pre> : null}
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}

                {pendingRequests.map((request) => (
                  <article className="approval-card" key={String(request.id)}>
                    <div>
                      <ShieldCheck size={18} />
                      <strong>{readableMethod(request.method)}</strong>
                    </div>
                    <pre>{formatJson(request.params)}</pre>
                    <div className="approval-actions">
                      <button onClick={() => approveRequest(request, "accept")}>
                        <Check size={15} />
                        Accept
                      </button>
                      <button onClick={() => approveRequest(request, "acceptForSession")}>
                        <ShieldCheck size={15} />
                        Session
                      </button>
                      <button onClick={() => approveRequest(request, "decline")}>
                        <X size={15} />
                        Decline
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>

            <footer className="composer-dock">
              <div className="composer-box">
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      submitPrompt();
                    }
                  }}
                  placeholder="명령어를 입력하려면 / 입력"
                  rows={1}
                />
                <button className="send-round" onClick={submitPrompt} disabled={!activeHost?.online} aria-label="Send">
                  <Send size={18} />
                </button>
              </div>
              <div className="composer-meta">
                <div>
                  <button onClick={startNewTask}>
                    <Plus size={14} />
                    New
                  </button>
                  <button onClick={interrupt} disabled={!threadId}>
                    <CircleStop size={14} />
                    Stop
                  </button>
                </div>
                <span>{activeHost?.online ? "Codex · ready" : "Codex · offline"}</span>
              </div>
            </footer>
          </section>
        </section>
      )}
    </main>
  );

  function upsertHost(host: HostSummary) {
    setHosts((current) => {
      const rest = current.filter((item) => item.id !== host.id);
      return [host, ...rest].sort((a, b) => Number(b.online) - Number(a.online));
    });
  }
}

function HelpPage({ relayUrl, mobileUrl }: { relayUrl: string; mobileUrl: string }) {
  const pairingUrl = `${mobileUrl}/pair?code=PAIRING_CODE&relay=${encodeURIComponent(relayUrl)}`;

  return (
    <section className="help-page">
      <div className="help-hero">
        <BookOpen size={26} />
        <div>
          <h1>Codex Remote Control 사용법</h1>
          <p>핸드폰에서 이 Mac의 Codex를 조종하는 순서입니다.</p>
        </div>
      </div>

      <div className="help-grid">
        <article className="help-panel">
          <h2>1. 서버 확인</h2>
          <p>Mac에서 세 프로세스가 떠 있어야 합니다.</p>
          <pre>{`tmux list-sessions | grep codex-remote

codex-remote-relay
codex-remote-mobile
codex-remote-host`}</pre>
          <p>현재 접속 주소입니다.</p>
          <pre>{`Mobile: ${mobileUrl}
Relay:  ${relayUrl}`}</pre>
        </article>

        <article className="help-panel">
          <h2>2. 핸드폰 로그인</h2>
          <p>relay에 `CODEX_REMOTE_LOGIN_PASSWORD`가 설정돼 있으면 폰에서 비밀번호로 로그인합니다.</p>
          <pre>{`CODEX_REMOTE_LOGIN_PASSWORD=your-password`}</pre>
          <p>pairing은 fallback입니다. 새 code가 필요하면 Mac에서 아래 명령을 실행합니다.</p>
          <pre>{`node apps/host-agent/dist/index.js --relay ${relayUrl} pair`}</pre>
          <pre>{pairingUrl}</pre>
        </article>

        <article className="help-panel">
          <h2>3. 작업 보내기</h2>
          <ol>
            <li>왼쪽 Recents에서 online host를 선택합니다.</li>
            <li>하단 입력창에 Codex에게 시킬 일을 적고 Send를 누릅니다.</li>
            <li>이어지는 지시는 같은 작업에 자동으로 붙습니다.</li>
            <li>새 작업으로 분리하고 싶으면 New session 또는 New를 누릅니다.</li>
            <li>실행 중인 작업을 멈추려면 하단 Stop을 누릅니다.</li>
            <li>프로젝트 경로와 모델은 Mac에서 Codex/host agent를 시작할 때 정합니다.</li>
          </ol>
        </article>

        <article className="help-panel">
          <h2>4. 승인 처리</h2>
          <p>명령 실행이나 파일 변경 승인이 필요하면 중앙 세션 화면에 승인 카드가 표시됩니다.</p>
          <ul>
            <li>Accept: 이번 요청만 승인합니다.</li>
            <li>Session: 같은 세션에서 반복되는 요청을 승인합니다.</li>
            <li>Decline: 요청을 거절합니다.</li>
          </ul>
        </article>

        <article className="help-panel">
          <h2>문제 해결</h2>
          <ul>
            <li>아무것도 안 보이면 폰과 Mac이 같은 Wi-Fi인지 확인합니다.</li>
            <li>404는 pairing code가 틀렸거나 이미 사용된 상태입니다. 위 pairing 명령으로 새 code를 발급합니다.</li>
            <li>Relay socket is closed가 나오면 relay 또는 host agent를 다시 띄웁니다.</li>
            <li>로그인이 안 되면 relay가 `CODEX_REMOTE_LOGIN_PASSWORD`와 함께 실행 중인지 확인합니다.</li>
            <li>Host가 offline이면 Mac이 잠들었거나 host agent가 종료된 상태입니다.</li>
          </ul>
        </article>

        <article className="help-panel">
          <h2>재시작 명령</h2>
          <pre>{`tmux kill-session -t codex-remote-relay
tmux kill-session -t codex-remote-mobile
tmux kill-session -t codex-remote-host`}</pre>
          <p>다시 시작은 repo README의 Quick Start를 따르거나, 현재처럼 tmux 세션으로 실행합니다.</p>
        </article>
      </div>
    </section>
  );
}

function workspaceName(cwd?: string): string {
  if (!cwd) {
    return "new session";
  }

  const normalized = cwd.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function shortId(value: string): string {
  return value ? value.replace(/^dev_/, "").slice(0, 8) : "device";
}

function readUserPrompt(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

function toWsUrl(baseUrl: string, path: string, token: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  url.searchParams.set("token", token);
  return url.toString();
}

function defaultRelayUrl(): string {
  const port = "8787";
  if (window.location.hostname && window.location.hostname !== "localhost") {
    return `${window.location.protocol}//${window.location.hostname}:${port}`;
  }
  return `http://localhost:${port}`;
}

function defaultDeviceName(): string {
  return navigator.userAgent.includes("Mobile") ? "Mobile" : "Browser";
}

function parseMessage<T>(data: unknown): T | undefined {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return undefined;
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function trimRight(value: string, char: string): string {
  let result = value;
  while (result.endsWith(char)) {
    result = result.slice(0, -1);
  }
  return result;
}

function readThreadId(value: JsonValue | undefined): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const thread = value.thread;
  if (thread && typeof thread === "object" && !Array.isArray(thread) && typeof thread.id === "string") {
    return thread.id;
  }
  return typeof value.id === "string" ? value.id : undefined;
}

function readableMethod(method: string): string {
  return method
    .replace(/^item\//, "")
    .replace(/^turn\//, "turn ")
    .replace(/^thread\//, "thread ")
    .replace(/\/requestApproval$/, " approval")
    .replace(/\//g, " ");
}

function eventKind(method: string): EventEntry["kind"] {
  if (method.includes("requestApproval")) {
    return "warning";
  }
  if (method.includes("completed")) {
    return "success";
  }
  if (method.includes("failed") || method.includes("error")) {
    return "error";
  }
  return "info";
}

function createId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `id_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}
