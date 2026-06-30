import { Context, Effect, Either, Layer } from "effect";
import { parseJsonRpcMessage, type JsonRpcMessage, type JsonRpcRequest } from "../shared/rpc";
import { parseWithSchema, RuntimeMessageSchema, type CursorState, type NativeHostStatus, type RuntimeMessage } from "../shared/extension-schemas";

const HOST_NAMES = [
  "com.opzero.chrome",
  "com.opzero.chrome.internal",
  "com.opzero.chrome.dev"
];
const HOST_NAME = "com.opzero.chrome";
const NATIVE_HOST_STATUS_KEY = "NATIVE_HOST_STATUS";
const NATIVE_HOST_PAUSED_KEY = "NATIVE_HOST_PAUSED";
const TAB_GROUPS_KEY = "TAB_GROUPS";
const EXTENSION_INSTANCE_ID_KEY = "extensionInstanceId";
const PENDING_UPDATE_KEY = "opChromePendingUpdateVersion";
const RECONNECT_ALARM = `native-transport-reconnect:${HOST_NAME}`;
const HEARTBEAT_ALARM = "client-heartbeat-alarm";
const DEFAULT_SESSION_TITLE = "Chrome Control";
const DELIVERABLE_TITLE = "✅ Chrome Control";
const DELIVERABLE_COLOR = "blue";
const SESSION_COLORS = ["grey", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;
const DEBUGGER_VERSION = "1.3";
const DEFAULT_CDP_TIMEOUT_MS = 10000;
const MESSAGE_TIMEOUT_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 3000;

type RpcId = number | string | null | undefined;
type JsonRecord = Record<string, unknown>;
type TabOrigin = "agent" | "user";
type RpcErrorWithCode = Error & { code?: number };
type Session = {
  id: string;
  turnId: string;
  tabIds: Set<number>;
  origins: Map<number, TabOrigin>;
  groupId: number | null;
  groupColorIndex: number;
  title: string;
  active: boolean;
  createdAt: number;
};
type TabInfo = {
  id?: number;
  title: string;
  active: boolean;
  url: string;
  windowId?: number;
  index?: number;
  groupId?: number;
  origin: TabOrigin;
};
type CursorWaiter = { resolve: () => void };
type PendingNativeRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type RpcHandler = (params?: JsonRecord) => Effect.Effect<unknown, Error, ChromeApi>;
type ChromeApiService = {
  call: <T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]) => Effect.Effect<T, Error>;
  storageGet: <T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) => Effect.Effect<T, Error>;
  storageSet: (value: Record<string, unknown>) => Effect.Effect<void, Error>;
  sessionStorageGet: <T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) => Effect.Effect<T, Error>;
  safeCall: <T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]) => Effect.Effect<T | undefined, never>;
};

class ChromeApi extends Context.Tag("opzero/ChromeApi")<ChromeApi, ChromeApiService>() {}

const sessions = new Map<string, Session>();
const tabToSession = new Map<number, string>();
const attachedTabs = new Set<number>();
const commandQueues = new Map<number, Promise<unknown>>();
const cursorStates = new Map<number, CursorState>();
const cursorWaiters = new Map<string, CursorWaiter>();
const tabOrigins = new Map<number, TabOrigin>();
let deliverableGroupId: number | null = null;
let nativeTransport: NativeTransport;

function jsonRpcError(id: RpcId, error: unknown) {
  const rpcError = error as Partial<RpcErrorWithCode> | undefined;
  const message = rpcError?.message || String(error || "Unknown error");
  const code = Number.isInteger(rpcError?.code) ? rpcError?.code as number : -32000;
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function createRpcError(message: string, code = -32000): RpcErrorWithCode {
  const error = new Error(message) as RpcErrorWithCode;
  error.code = code;
  return error;
}

function isNativeHostStatus(value: unknown): value is NativeHostStatus {
  return typeof value === "object"
    && value != null
    && "state" in value
    && typeof value.state === "string";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error || "Unknown error"));
}

function chromeCallback<T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]): Promise<T> {
  return chromeCallbackFrom<T>(chrome[namespace], method, ...args);
}

function chromeCallbackFrom<T = unknown>(target: unknown, method: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const callable = (target as Record<string, unknown>)[method];
    if (typeof callable !== "function") {
      reject(new Error(`Chrome API method ${method} is not callable`));
      return;
    }
    Reflect.apply(callable, target, [...args, (result: T) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    }]);
  });
}

const ChromeApiLive = Layer.succeed(ChromeApi, {
  call: <T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]) =>
    Effect.tryPromise({ try: () => chromeCallback<T>(namespace, method, ...args), catch: toError }),
  storageGet: <T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) =>
    Effect.tryPromise({ try: () => chromeCallbackFrom<T>(chrome.storage.local, "get", keys), catch: toError }),
  storageSet: (value: Record<string, unknown>) =>
    Effect.tryPromise({ try: () => chromeCallbackFrom<void>(chrome.storage.local, "set", value), catch: toError }),
  sessionStorageGet: <T extends Record<string, unknown> = Record<string, unknown>>(keys: string | string[] | Record<string, unknown>) =>
    Effect.tryPromise({ try: () => chromeCallbackFrom<T>(chrome.storage.session, "get", keys), catch: toError }),
  safeCall: <T = unknown>(namespace: keyof typeof chrome, method: string, ...args: unknown[]) =>
    Effect.catchAll(
      Effect.tryPromise({ try: () => chromeCallback<T>(namespace, method, ...args), catch: toError }),
      () => Effect.succeed(undefined)
    )
});

function runChromeEffect<A>(program: Effect.Effect<A, Error, ChromeApi>): Promise<A> {
  return Effect.runPromise(Effect.provide(program, ChromeApiLive));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function normalizeSessionParams(params: JsonRecord = {}) {
  const sessionId = params.session_id || params.sessionId;
  const turnId = params.turn_id || params.turnId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw createRpcError("Missing required browser session_id");
  }
  if (typeof turnId !== "string" || !turnId) {
    throw createRpcError("Missing required browser turn_id");
  }
  return { sessionId, turnId };
}

function ensureSession(params: JsonRecord = {}): Session {
  const { sessionId, turnId } = normalizeSessionParams(params);
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      turnId,
      tabIds: new Set(),
      origins: new Map(),
      groupId: null,
      groupColorIndex: sessions.size % SESSION_COLORS.length,
      title: DEFAULT_SESSION_TITLE,
      active: true,
      createdAt: Date.now()
    };
    sessions.set(sessionId, session);
  }
  session.turnId = turnId;
  session.active = true;
  return session;
}

function getSessionForTab(tabId: number): Session | null {
  const sessionId = tabToSession.get(tabId);
  if (!sessionId) return null;
  return sessions.get(sessionId) || null;
}

function requireSessionTab(params: JsonRecord = {}) {
  const session = ensureSession(params);
  const target = typeof params.target === "object" && params.target != null ? params.target as JsonRecord : {};
  const tabId = Number(params.tabId ?? target.tabId);
  if (!Number.isInteger(tabId)) throw createRpcError("Missing or invalid tabId");
  if (!session.tabIds.has(tabId)) throw createRpcError(`Tab ${tabId} does not belong to session ${session.id}`);
  return { session, tabId };
}

function isControllableUrl(url = "") {
  if (!url) return true;
  if (url === "about:blank") return true;
  return !/^(chrome|chrome-extension|edge|about|devtools):/i.test(url);
}

function tabInfo(tab?: chrome.tabs.Tab | { id: number } | null): TabInfo | null {
  if (!tab) return null;
  if (tab.id == null) return null;
  const fullTab = tab as chrome.tabs.Tab;
  return {
    id: tab.id,
    title: fullTab.title || "",
    active: Boolean(fullTab.active),
    url: fullTab.url || "",
    windowId: fullTab.windowId,
    index: fullTab.index,
    groupId: fullTab.groupId,
    origin: tabOrigins.get(tab.id) || getSessionForTab(tab.id)?.origins.get(tab.id) || "user"
  };
}

function getExtensionInstanceId() {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const stored = yield* chromeApi.storageGet<Record<string, unknown>>(EXTENSION_INSTANCE_ID_KEY);
    if (typeof stored[EXTENSION_INSTANCE_ID_KEY] === "string") return stored[EXTENSION_INSTANCE_ID_KEY];
    const value = crypto.randomUUID();
    yield* chromeApi.storageSet({ [EXTENSION_INSTANCE_ID_KEY]: value });
    return value;
  });
}

function persistGroupState() {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const sessionGroups: Record<string, number> = {};
    const sessionGroupTitles: Record<string, string> = {};
    for (const session of sessions.values()) {
      if (session.groupId != null) sessionGroups[session.id] = session.groupId;
      sessionGroupTitles[session.id] = session.title;
    }
    yield* chromeApi.storageSet({
      [TAB_GROUPS_KEY]: {
        groups: Array.from(sessions.values()).map((session) => ({
          sessionId: session.id,
          groupId: session.groupId,
          tabIds: Array.from(session.tabIds)
        })),
        sessionGroups,
        sessionGroupTitles,
        deliverableGroupId
      }
    });
  });
}

function ensureSessionGroup(session: Session, tabId: number) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    if (session.groupId != null) {
      const grouped = yield* Effect.either(Effect.gen(function* () {
        yield* chromeApi.call("tabGroups", "get", session.groupId);
        yield* chromeApi.call("tabs", "group", { groupId: session.groupId, tabIds: [tabId] });
        yield* chromeApi.call("tabGroups", "update", session.groupId, {
          title: session.title || DEFAULT_SESSION_TITLE,
          color: SESSION_COLORS[session.groupColorIndex],
          collapsed: false
        });
        yield* persistGroupState();
        return session.groupId;
      }));
      if (Either.isRight(grouped)) return grouped.right;
      session.groupId = null;
    }

    const groupId = yield* chromeApi.call<number>("tabs", "group", { tabIds: [tabId] });
    session.groupId = groupId;
    yield* chromeApi.call("tabGroups", "update", groupId, {
      title: session.title || DEFAULT_SESSION_TITLE,
      color: SESSION_COLORS[session.groupColorIndex],
      collapsed: false
    });
    yield* persistGroupState();
    return groupId;
  });
}

function ensureDeliverableGroup(tabIds: number[]) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    if (!tabIds.length) return null;
    if (deliverableGroupId != null) {
      const grouped = yield* Effect.either(Effect.gen(function* () {
        yield* chromeApi.call("tabGroups", "get", deliverableGroupId);
        yield* chromeApi.call("tabs", "group", { groupId: deliverableGroupId, tabIds });
        yield* chromeApi.call("tabGroups", "update", deliverableGroupId, {
          title: DELIVERABLE_TITLE,
          color: DELIVERABLE_COLOR,
          collapsed: false
        });
        yield* persistGroupState();
        return deliverableGroupId;
      }));
      if (Either.isRight(grouped)) return grouped.right;
      deliverableGroupId = null;
    }
    deliverableGroupId = yield* chromeApi.call<number>("tabs", "group", { tabIds });
    yield* chromeApi.call("tabGroups", "update", deliverableGroupId, {
      title: DELIVERABLE_TITLE,
      color: DELIVERABLE_COLOR,
      collapsed: false
    });
    yield* persistGroupState();
    return deliverableGroupId;
  });
}

function registerSessionTab(session: Session, tab: chrome.tabs.Tab | { id: number }, origin: TabOrigin) {
  if (tab.id == null) throw createRpcError("Missing tab id");
  session.tabIds.add(tab.id);
  session.origins.set(tab.id, origin);
  tabToSession.set(tab.id, session.id);
  tabOrigins.set(tab.id, origin);
}

function releaseSessionTab(session: Session, tabId: number, ungroup = true) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    session.tabIds.delete(tabId);
    session.origins.delete(tabId);
    tabToSession.delete(tabId);
    tabOrigins.delete(tabId);
    cursorStates.delete(tabId);
    if (ungroup) yield* chromeApi.safeCall("tabs", "ungroup", tabId);
    yield* detachTab(tabId);
  });
}

function cleanupSessionIfEmpty(session: Session) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    if (session.tabIds.size > 0) return;
    if (session.groupId != null) yield* chromeApi.safeCall("tabGroups", "update", session.groupId, { collapsed: true });
    sessions.delete(session.id);
    yield* persistGroupState();
  });
}

function findNormalWindow() {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const current = yield* chromeApi.safeCall<chrome.windows.Window>("windows", "getCurrent", { populate: false });
    if (current?.id && current.type === "normal") return current;
    const windows = yield* chromeApi.call<chrome.windows.Window[]>("windows", "getAll", { populate: false, windowTypes: ["normal"] });
    return windows.find((win) => win.focused) || windows[0] || null;
  });
}

class NativeTransport {
  hostName: string;
  port: chrome.runtime.Port | null = null;
  nextId = 1;
  pending = new Map<number, PendingNativeRequest>();
  reconnectAttempt = 0;
  connected = false;
  paused = false;

  constructor(hostName: string) {
    this.hostName = hostName;
  }

  start() {
    void this.ensureConnected();
  }

  scheduleAlarms() {
    chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  }

  async loadPausedState(): Promise<boolean> {
    const stored = await runChromeEffect(Effect.flatMap(ChromeApi, (chromeApi) =>
      chromeApi.storageGet<Record<string, unknown>>(NATIVE_HOST_PAUSED_KEY)
    ));
    return stored[NATIVE_HOST_PAUSED_KEY] === true;
  }

  async persistPaused(paused: boolean) {
    this.paused = paused;
    await runChromeEffect(Effect.flatMap(ChromeApi, (chromeApi) =>
      chromeApi.storageSet({ [NATIVE_HOST_PAUSED_KEY]: paused })
    ));
  }

  async ensureConnected(): Promise<void> {
    this.paused = await this.loadPausedState();
    if (this.paused) {
      await this.setStatus("paused").catch(() => undefined);
      return;
    }
    this.scheduleAlarms();
    this.connect();
  }

  disconnect(message = "Native host disconnected") {
    const port = this.port;
    this.port = null;
    this.connected = false;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // The port may already be dead; ignore.
      }
    }
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
  }

  async reload(): Promise<NativeHostStatus> {
    await this.persistPaused(false);
    this.disconnect("Native host reloaded");
    this.reconnectAttempt = 0;
    this.scheduleAlarms();
    this.connect();
    return this.refreshStatus();
  }

  async pause(): Promise<NativeHostStatus> {
    await this.persistPaused(true);
    this.disconnect("Native host paused");
    await chrome.alarms.clear(RECONNECT_ALARM);
    await chrome.alarms.clear(HEARTBEAT_ALARM);
    await runChromeEffect(stopActiveSessions("Native host paused by user")).catch(() => undefined);
    return this.setStatus("paused");
  }

  async resume(): Promise<NativeHostStatus> {
    await this.persistPaused(false);
    this.reconnectAttempt = 0;
    this.scheduleAlarms();
    this.connect();
    return this.refreshStatus();
  }

  async setStatus(state: string, extra: Partial<NativeHostStatus> = {}) {
    const status: NativeHostStatus = {
      state,
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      ...extra
    };
    await runChromeEffect(Effect.gen(function* () {
      const chromeApi = yield* ChromeApi;
      yield* chromeApi.storageSet({ [NATIVE_HOST_STATUS_KEY]: status });
      return status;
    }));
    return status;
  }

  connect() {
    if (this.paused || this.port) return;
    try {
      this.port = chrome.runtime.connectNative(this.hostName);
      this.connected = true;
      this.reconnectAttempt = 0;
      this.setStatus("connected").catch(() => undefined);
      this.port.onMessage.addListener((message) => this.onMessage(message));
      this.port.onDisconnect.addListener(() => this.onDisconnect());
    } catch (error) {
      this.connected = false;
      this.port = null;
      this.reconnectAttempt += 1;
      this.setStatus("disconnected", {
        error: error instanceof Error ? error.message : String(error),
        nextRetryMs: 5000
      }).catch(() => undefined);
    }
  }

  onDisconnect() {
    const message = chrome.runtime.lastError?.message || "Native host disconnected";
    this.connected = false;
    this.port = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
    if (this.paused) return;
    this.reconnectAttempt += 1;
    this.setStatus("disconnected", { error: message, nextRetryMs: 5000 }).catch(() => undefined);
  }

  onMessage(message: unknown) {
    let rpcMessage: JsonRpcMessage;
    try {
      rpcMessage = parseJsonRpcMessage(message);
    } catch {
      return;
    }
    if (!rpcMessage || rpcMessage.jsonrpc !== "2.0") return;
    if ("id" in rpcMessage && ("result" in rpcMessage || "error" in rpcMessage)) {
      const pending = this.pending.get(Number(rpcMessage.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(rpcMessage.id));
      if (rpcMessage.error) pending.reject(new Error(rpcMessage.error.message || "Native JSON-RPC error"));
      else pending.resolve(rpcMessage.result);
      return;
    }
    if ("method" in rpcMessage) {
      handleJsonRpcRequest(rpcMessage, (response) => this.post(response)).catch(() => undefined);
    }
  }

  post(message: unknown) {
    if (!this.port) throw new Error("Native host is not connected");
    this.port.postMessage(message);
  }

  call(method: string, params: JsonRecord = {}, timeoutMs = 10000) {
    const port = this.port;
    if (!port) return Promise.reject(new Error("Native host is not connected"));
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      port.postMessage(request);
    });
  }

  notify(method: string, params: JsonRecord = {}) {
    if (!this.port) return;
    this.port.postMessage({ jsonrpc: "2.0", method, params });
  }

  async refreshStatus(): Promise<NativeHostStatus> {
    if (!this.connected && !this.port) {
      this.paused = await this.loadPausedState();
      if (!this.paused) this.connect();
    }
    const hostName = this.hostName;
    const reconnectAttempt = this.reconnectAttempt;
    return runChromeEffect(Effect.gen(function* () {
      const chromeApi = yield* ChromeApi;
      const value = yield* chromeApi.storageGet<Record<string, unknown>>(NATIVE_HOST_STATUS_KEY);
      const storedStatus = value[NATIVE_HOST_STATUS_KEY];
      if (isNativeHostStatus(storedStatus)) return storedStatus;
      return {
        state: "disconnected",
        hostName,
        lastChecked: Date.now(),
        reconnectAttempt
      };
    }));
  }
}

const api: Record<string, RpcHandler> = {
  ping: () => Effect.succeed("pong"),

  getInfo: () => Effect.gen(function* () {
    return {
    name: "Chrome",
    version: chrome.runtime.getManifest().version,
    type: "extension",
    metadata: {
      extensionId: chrome.runtime.id,
      extensionInstanceId: yield* getExtensionInstanceId(),
      supportedHostNames: HOST_NAMES
    }
    };
  }),

  getTabs: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const sessionId = params.session_id || params.sessionId;
    const targetSessions = sessionId
      ? Array.from(sessions.values()).filter((session) => session.id === sessionId)
      : Array.from(sessions.values());
    const tabIds = targetSessions.flatMap((session) => Array.from(session.tabIds));
    const tabs = yield* Effect.all(tabIds.map((id) => chromeApi.safeCall<chrome.tabs.Tab>("tabs", "get", id)));
    return tabs.flatMap((tab) => {
      const info = tabInfo(tab);
      return info ? [info] : [];
    });
  }),

  getUserTabs: () => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const tabs = yield* chromeApi.call<chrome.tabs.Tab[]>("tabs", "query", {});
    return tabs.flatMap((tab) => {
      if (tab.id == null || !isControllableUrl(tab.url) || tabToSession.has(tab.id)) return [];
      const info = tabInfo(tab);
      return info ? [info] : [];
    });
  }),

  getUserHistory: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const maxResults = Math.max(1, Math.min(Number(params.limit) || 100, 1000));
    const from = Number(params.from);
    const to = Number(params.to);
    const query: chrome.history.HistoryQuery = {
      text: typeof params.query === "string" ? params.query : "",
      maxResults,
      startTime: Number.isFinite(from) ? from : 0
    };
    if (Number.isFinite(to)) query.endTime = to;
    return yield* chromeApi.call<chrome.history.HistoryItem[]>("history", "search", query);
  }),

  createTab: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const win = yield* findNormalWindow();
    let tab;
    if (win?.id) {
      tab = yield* chromeApi.call<chrome.tabs.Tab>("tabs", "create", { windowId: win.id, url: "about:blank", active: true });
    } else {
      const created = yield* chromeApi.call<chrome.windows.Window>("windows", "create", { url: "about:blank", focused: false, type: "normal" });
      tab = created.tabs?.[0];
    }
    if (!tab?.id) return yield* Effect.fail(createRpcError("Failed to create tab"));
    yield* Effect.try({ try: () => registerSessionTab(session, tab, "agent"), catch: toError });
    yield* ensureSessionGroup(session, tab.id);
    yield* persistGroupState();
    return tabInfo(yield* chromeApi.call<chrome.tabs.Tab>("tabs", "get", tab.id));
  }),

  claimUserTab: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId)) return yield* Effect.fail(createRpcError("Missing or invalid tabId"));
    const tab = yield* chromeApi.call<chrome.tabs.Tab>("tabs", "get", tabId);
    if (!isControllableUrl(tab.url)) return yield* Effect.fail(createRpcError(`Cannot claim Chrome internal tab: ${tab.url || ""}`));
    const owner = tabToSession.get(tabId);
    if (owner && owner !== session.id) return yield* Effect.fail(createRpcError(`Tab ${tabId} already belongs to another session`));
    yield* Effect.try({ try: () => registerSessionTab(session, tab, "user"), catch: toError });
    yield* ensureSessionGroup(session, tabId);
    yield* persistGroupState();
    return tabInfo(yield* chromeApi.call<chrome.tabs.Tab>("tabs", "get", tabId));
  }),

  finalizeTabs: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const keep = Array.isArray(params.keep) ? params.keep : [];
    const seen = new Set<number>();
    const deliverable: number[] = [];
    const handoff: number[] = [];
    for (const rawItem of keep) {
      const item = typeof rawItem === "object" && rawItem != null ? rawItem as JsonRecord : {};
      const tabId = Number(item?.tabId);
      const status = item.status;
      if (!Number.isInteger(tabId)) return yield* Effect.fail(createRpcError("Invalid keep tabId"));
      if (seen.has(tabId)) return yield* Effect.fail(createRpcError(`Duplicate keep tabId ${tabId}`));
      if (!session.tabIds.has(tabId)) return yield* Effect.fail(createRpcError(`Unknown keep tabId ${tabId}`));
      if (status !== "handoff" && status !== "deliverable") return yield* Effect.fail(createRpcError(`Invalid keep status ${String(status)}`));
      seen.add(tabId);
      if (status === "deliverable") deliverable.push(tabId);
      else handoff.push(tabId);
    }

    for (const tabId of Array.from(session.tabIds)) {
      if (seen.has(tabId)) continue;
      const origin = session.origins.get(tabId) || "user";
      yield* detachTab(tabId);
      if (origin === "agent") yield* chromeApi.safeCall("tabs", "remove", tabId);
      else yield* releaseSessionTab(session, tabId, true);
    }

    if (deliverable.length) {
      yield* ensureDeliverableGroup(deliverable);
      for (const tabId of deliverable) yield* releaseSessionTab(session, tabId, false);
    }

    for (const tabId of handoff) yield* detachTab(tabId);
    yield* cleanupSessionIfEmpty(session);
    yield* maybeApplyPendingUpdate();
    return { kept: keep, closedOrReleased: true };
  }),

  nameSession: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    const name = String(params.name || DEFAULT_SESSION_TITLE).slice(0, 80);
    session.title = name || DEFAULT_SESSION_TITLE;
    if (session.groupId != null) {
      yield* chromeApi.safeCall("tabGroups", "update", session.groupId, { title: session.title, collapsed: false });
    }
    yield* persistGroupState();
    return { name: session.title };
  }),

  attach: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    if (attachedTabs.has(tabId)) return { attached: true };
    const attached = yield* Effect.either(chromeApi.call("debugger", "attach", { tabId }, DEBUGGER_VERSION));
    if (Either.isLeft(attached)) {
      const message = attached.left.message;
      if (!/Another debugger|already attached/i.test(message)) return yield* Effect.fail(attached.left);
    }
    attachedTabs.add(tabId);
    return { attached: true };
  }),

  detach: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    yield* detachTab(tabId);
    return { detached: true };
  }),

  executeCdp: (params: JsonRecord = {}) => Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const { tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const method = String(params.method || "");
    if (!method) return yield* Effect.fail(createRpcError("Missing CDP method"));
    if (method === "Target.getTargets") {
      const targetInfos = yield* chromeApi.call<chrome.debugger.TargetInfo[]>("debugger", "getTargets");
      return { targetInfos };
    }
    if (!attachedTabs.has(tabId)) return yield* Effect.fail(createRpcError(`Tab ${tabId} is not attached`));
    const commandParams: JsonRecord = typeof params.commandParams === "object" && params.commandParams != null
      ? params.commandParams as JsonRecord
      : {};
    const requestedTimeoutMs = Number(params.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_CDP_TIMEOUT_MS;
    return yield* sendDebuggerCommand(tabId, method, commandParams, timeoutMs);
  }),

  moveMouse: (params: JsonRecord = {}) => Effect.gen(function* () {
    const { session, tabId } = yield* Effect.try({ try: () => requireSessionTab(params), catch: toError });
    const x = Number(params.x);
    const y = Number(params.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return yield* Effect.fail(createRpcError("Missing or invalid cursor coordinates"));
    const previous = cursorStates.get(tabId)?.cursor;
    const moveSequence = (previous?.moveSequence || 0) + 1;
    const state: CursorState = {
      cursor: {
        visible: true,
        x,
        y,
        animateMovement: params.animateMovement !== false,
        moveSequence
      },
      isVisible: true,
      sessionId: session.id,
      turnId: session.turnId
    };
    cursorStates.set(tabId, state);
    const contentScriptDelivery = yield* Effect.either(Effect.gen(function* () {
      yield* ensureContentScript(tabId);
      const arrival = params.waitForArrival ? waitForCursorArrival(tabId, session.id, session.turnId, moveSequence) : null;
      yield* sendTabMessage(tabId, { type: "AGENT_CURSOR_STATE", state });
      if (arrival) yield* Effect.tryPromise({ try: () => arrival, catch: toError });
    }));

    if (Either.isRight(contentScriptDelivery)) {
      return { arrived: Boolean(params.waitForArrival), moveSequence, transport: "content-script" };
    }
    if (!attachedTabs.has(tabId)) return yield* Effect.fail(contentScriptDelivery.left);
    yield* renderCursorWithCdp(tabId, state);
    return { arrived: Boolean(params.waitForArrival), moveSequence, transport: "cdp" };
  }),

  turnEnded: (params: JsonRecord = {}) => Effect.gen(function* () {
    const session = yield* Effect.try({ try: () => ensureSession(params), catch: toError });
    for (const tabId of session.tabIds) {
      const current = cursorStates.get(tabId);
      if (!current) continue;
      const state = { ...current, cursor: null, isVisible: false };
      cursorStates.set(tabId, state);
      runChromeEffect(Effect.gen(function* () {
        const delivered = yield* Effect.either(sendTabMessage(tabId, { type: "AGENT_CURSOR_STATE", state }));
        if (Either.isLeft(delivered) && attachedTabs.has(tabId)) yield* renderCursorWithCdp(tabId, state);
      })).catch(() => undefined);
    }
    session.active = false;
    yield* maybeApplyPendingUpdate();
    return { ok: true };
  }),

  executeUnhandledCommand: (params: JsonRecord = {}) =>
    Effect.fail(createRpcError(`Unsupported browser command: ${params.command || params.method || "unknown"}`))
};

async function handleJsonRpcRequest(message: JsonRpcRequest, respond: (response: unknown) => void) {
  const { id, method, params } = message;
  if (!method || typeof method !== "string") {
    if (id != null) respond(jsonRpcError(id, createRpcError("Invalid JSON-RPC method", -32600)));
    return;
  }
  const fn = api[method] || api.executeUnhandledCommand;
  try {
    const result = await runChromeEffect(Effect.gen(function* () {
      const rpcParams = typeof params === "object" && params != null ? params as JsonRecord : {};
      return yield* fn(rpcParams);
    }));
    if (id != null) respond({ jsonrpc: "2.0", id, result });
  } catch (error) {
    if (id != null) respond(jsonRpcError(id, error));
  }
}

function enqueueCdp(tabId: number, task: () => Promise<unknown>) {
  const previous = commandQueues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  commandQueues.set(tabId, next.finally(() => {
    if (commandQueues.get(tabId) === next) commandQueues.delete(tabId);
  }));
  return next;
}

function sendDebuggerCommand<T = unknown>(
  tabId: number,
  method: string,
  commandParams: JsonRecord = {},
  timeoutMs = DEFAULT_CDP_TIMEOUT_MS
) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    return yield* Effect.tryPromise({
      try: async () => await enqueueCdp(tabId, () => withTimeout(
        Effect.runPromise(chromeApi.call<T>("debugger", "sendCommand", { tabId }, method, commandParams)),
        timeoutMs,
        `CDP command ${method}`
      ).catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out/i.test(message)) await runChromeEffect(detachTab(tabId));
        throw error;
      })) as T,
      catch: toError
    });
  });
}

function renderCursorWithCdp(tabId: number, state: CursorState | null) {
  const stateJson = JSON.stringify(state).replace(/</g, "\\u003c");
  const expression = `
(() => {
  const state = ${stateJson};
  const rootId = "opzero-chrome-cdp-cursor-root";
  const existing = document.getElementById(rootId);
  if (!state || !state.cursor || state.isVisible === false || state.cursor.visible === false) {
    existing?.remove();
    return { ok: true, visible: false };
  }

  const mount = document.documentElement || document.body;
  if (!mount) return { ok: false, reason: "missing document root" };

  let root = existing;
  if (!root) {
    root = document.createElement("div");
    root.id = rootId;
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
      contain: "layout style paint"
    });
    const cursor = document.createElement("div");
    cursor.dataset.opzeroCursor = "true";
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "22px",
      height: "22px",
      background: "#111827",
      border: "2px solid #fff",
      clipPath: "polygon(0 0, 0 100%, 35% 72%, 55% 100%, 75% 88%, 55% 61%, 100% 60%)",
      filter: "drop-shadow(0 3px 8px rgba(0,0,0,.28))",
      pointerEvents: "none",
      willChange: "transform, opacity",
      transition: "opacity 120ms linear"
    });
    root.appendChild(cursor);
    mount.appendChild(root);
  }

  const cursor = root.querySelector("[data-opzero-cursor='true']");
  if (!cursor) return { ok: false, reason: "missing cursor" };
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth || document.documentElement.clientWidth || 1;
  const height = viewport?.height || window.innerHeight || document.documentElement.clientHeight || 1;
  const x = Math.max(0, Math.min(width - 1, Number(state.cursor.x) || 0));
  const y = Math.max(0, Math.min(height - 1, Number(state.cursor.y) || 0));
  cursor.style.opacity = "1";
  cursor.style.transform = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0)";
  return { ok: true, visible: true, x, y, moveSequence: state.cursor.moveSequence };
})()
`;
  return sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false
  }, 2000);
}

function detachTab(tabId: number) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    attachedTabs.delete(tabId);
    commandQueues.delete(tabId);
    yield* chromeApi.safeCall("debugger", "detach", { tabId });
  });
}

function sendTabMessage(tabId: number, message: RuntimeMessage) {
  return Effect.tryPromise({
    try: () => withTimeout(
      runChromeEffect(Effect.flatMap(ChromeApi, (api) => api.call("tabs", "sendMessage", tabId, message))),
      MESSAGE_TIMEOUT_MS,
      `Message ${message.type}`
    ),
    catch: toError
  });
}

function ensureContentScript(tabId: number) {
  return Effect.gen(function* () {
    const chromeApi = yield* ChromeApi;
    const ping = yield* Effect.either(sendTabMessage(tabId, { type: "CONTENT_PING" }));
    if (Either.isRight(ping)) return;
    const session = getSessionForTab(tabId);
    if (!session) return yield* Effect.fail(createRpcError(`Cannot inject content script into untracked tab ${tabId}`));
    yield* chromeApi.call("scripting", "executeScript", {
      target: { tabId },
      files: ["content-scripts/opzero-chrome.js"],
      injectImmediately: true
    });
    yield* sendTabMessage(tabId, { type: "CONTENT_PING" });
  });
}

function waitForCursorArrival(tabId: number, sessionId: string, turnId: string, sequence: number): Promise<void> {
  const key = `${tabId}:${sessionId}:${turnId}:${sequence}`;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cursorWaiters.delete(key);
      reject(new Error("Cursor arrival timed out"));
    }, 2000);
    cursorWaiters.set(key, {
      resolve: () => {
        clearTimeout(timer);
        cursorWaiters.delete(key);
        resolve();
      }
    });
  });
}

function stopActiveSessions(reason: string) {
  return Effect.gen(function* () {
    for (const tabId of Array.from(attachedTabs)) yield* detachTab(tabId);
    for (const session of sessions.values()) session.active = false;
    nativeTransport?.notify("onControlStopped", { reason });
  });
}

function maybeApplyPendingUpdate() {
  return Effect.gen(function* () {
    const active = Array.from(sessions.values()).some((session) => session.active);
    if (active) return;
    const stored = yield* Effect.catchAll(
      Effect.flatMap(ChromeApi, (api) => api.sessionStorageGet(PENDING_UPDATE_KEY)),
      () => Effect.succeed({} as Record<string, unknown>)
    );
    if (stored[PENDING_UPDATE_KEY]) chrome.runtime.reload();
  });
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  (async () => {
    const parsedMessage = parseWithSchema(RuntimeMessageSchema, message);
    if (!parsedMessage) {
      sendResponse({ ok: false, error: "Unknown message type" });
      return;
    }
    if (parsedMessage.type === "GET_NATIVE_HOST_STATUS") {
      const status = await nativeTransport.refreshStatus();
      sendResponse({ ok: status.state === "connected", status, error: status.error || null });
      return;
    }
    if (parsedMessage.type === "RELOAD_NATIVE_HOST") {
      const status = await nativeTransport.reload();
      sendResponse({ ok: status.state === "connected", status, error: status.error || null });
      return;
    }
    if (parsedMessage.type === "PAUSE_NATIVE_HOST") {
      const status = await nativeTransport.pause();
      sendResponse({ ok: true, status, error: status.error || null });
      return;
    }
    if (parsedMessage.type === "RESUME_NATIVE_HOST") {
      const status = await nativeTransport.resume();
      sendResponse({ ok: status.state === "connected", status, error: status.error || null });
      return;
    }
    if (parsedMessage.type === "GET_AGENT_CURSOR_STATE") {
      const tabId = sender.tab?.id;
      sendResponse({ ok: true, state: tabId == null ? null : cursorStates.get(tabId) || null });
      return;
    }
    if (parsedMessage.type === "AGENT_CURSOR_ARRIVED") {
      const tabId = sender.tab?.id;
      const { sessionId, turnId, moveSequence } = parsedMessage;
      if (Number.isInteger(tabId) && typeof sessionId === "string" && typeof turnId === "string" && Number.isInteger(moveSequence)) {
        cursorWaiters.get(`${tabId}:${sessionId}:${turnId}:${moveSequence}`)?.resolve();
      }
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "Unknown message type" });
  })().catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  nativeTransport?.notify("onCDPEvent", { source, method, params: params || {} });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId != null && Number.isInteger(source.tabId)) attachedTabs.delete(source.tabId);
  nativeTransport?.notify("onCDPDetach", { source, reason });
});

chrome.downloads.onCreated.addListener((item) => {
  if (!sessions.size) return;
  nativeTransport?.notify("onDownloadChange", {
    id: String(item.id),
    filename: item.filename,
    url: item.url,
    status: "started"
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!sessions.size) return;
  let status = delta.state?.current;
  if (status === "complete") status = "complete";
  else if (status === "interrupted") status = delta.error?.current === "USER_CANCELED" ? "canceled" : "failed";
  else if (status) status = "in_progress";
  if (!status) return;
  nativeTransport?.notify("onDownloadChange", {
    id: String(delta.id),
    filename: delta.filename?.current,
    url: delta.url?.current,
    status
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = getSessionForTab(tabId);
  if (session) {
    session.tabIds.delete(tabId);
    session.origins.delete(tabId);
  }
  tabToSession.delete(tabId);
  tabOrigins.delete(tabId);
  cursorStates.delete(tabId);
  attachedTabs.delete(tabId);
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const session = getSessionForTab(removedTabId);
  if (!session) return;
  const origin = session.origins.get(removedTabId) || "user";
  session.tabIds.delete(removedTabId);
  session.origins.delete(removedTabId);
  registerSessionTab(session, { id: addedTabId }, origin);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativeTransport?.connected && !nativeTransport?.paused) nativeTransport.connect();
  if (alarm.name === HEARTBEAT_ALARM && nativeTransport?.connected) {
    withTimeout(nativeTransport.call("ping", {}, HEARTBEAT_TIMEOUT_MS), HEARTBEAT_TIMEOUT_MS, "Native heartbeat")
      .catch((error) => runChromeEffect(stopActiveSessions(error instanceof Error ? error.message : String(error))).catch(() => undefined));
  }
});

chrome.runtime.onUpdateAvailable.addListener((details) => {
  const active = Array.from(sessions.values()).some((session) => session.active);
  if (!active) chrome.runtime.reload();
  else chrome.storage.session.set({ [PENDING_UPDATE_KEY]: details.version });
});

chrome.runtime.onStartup.addListener(() => {
  void nativeTransport?.ensureConnected();
});

chrome.runtime.onInstalled.addListener(() => {
  void nativeTransport?.ensureConnected();
});

nativeTransport = new NativeTransport(HOST_NAME);
nativeTransport.start();
