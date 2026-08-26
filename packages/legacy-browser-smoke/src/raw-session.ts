import {
  connectCdp,
  type CdpConnection,
  type CdpSocketFactory,
  type TimerAdapter,
} from "./cdp.js";
import type { PageSession } from "./page-session.js";

/**
 * 내부 runtime이 다루는 CDP session. B2b의 `PageSession`과 동일한 계약이므로
 * 별도 타입을 선언하지 않고 그대로 재사용한다.
 */
export type { PageSession as RawSession } from "./page-session.js";

type RawSession = PageSession;

/** 열려 있는 page target 하나의 수명주기 handle. */
export interface PageHandle {
  readonly session: RawSession;
  /** idempotent best-effort 종료. 절대 throw하지 않는다. */
  close(): Promise<void>;
}

/** DevTools HTTP endpoint에서 JSON을 읽는 주입 가능한 adapter. */
export interface HttpJsonAdapter {
  getJson(url: string, signal: AbortSignal): Promise<unknown>;
}

/** browser session 하나가 새 page target을 여는 데 필요한 연결 정보. */
export interface PageAttachContext {
  readonly httpBaseUrl: string;
  readonly http: HttpJsonAdapter;
  readonly createSocket: CdpSocketFactory;
  readonly timers: TimerAdapter;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

export const fetchHttpJson: HttpJsonAdapter = {
  getJson: async (url, signal) => {
    const response = await fetch(url, {
      signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // 읽지 않은 응답 본문 정리는 best-effort다.
      }
      throw new Error(
        `DevTools HTTP endpoint responded with ${String(response.status)}`,
      );
    }
    return response.json();
  },
};

const attachContexts = new WeakMap<RawSession, PageAttachContext>();
const trackedPages = new WeakMap<RawSession, Set<PageHandle>>();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const webSocketUrlFrom = (target: unknown): string => {
  if (!isRecord(target)) {
    throw new TypeError("invalid DevTools target response");
  }
  const url = target.webSocketDebuggerUrl;
  if (typeof url !== "string" || url === "") {
    throw new TypeError("DevTools target response has no webSocketDebuggerUrl");
  }
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new TypeError("DevTools target webSocketDebuggerUrl is not a URL");
  }
  if (protocol !== "ws:" && protocol !== "wss:") {
    throw new TypeError(
      "DevTools target webSocketDebuggerUrl must use the ws protocol",
    );
  }
  return url;
};

const combineSignals = (
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal => {
  if (first !== undefined && second !== undefined) {
    return AbortSignal.any([first, second]);
  }
  return first ?? second ?? new AbortController().signal;
};

/**
 * CDP 연결을 `RawSession` 모양으로만 투영한다. transport 종료 수단은
 * session 밖의 handle이 소유하므로 여기서 노출하지 않는다.
 */
export const createRawSession = (connection: CdpConnection): RawSession =>
  Object.freeze({
    command: <T>(method: string, params?: object): Promise<T> =>
      connection.command<T>(method, params),
    on: (method: string, listener: (params: object) => void): (() => void) =>
      connection.on(method, listener),
  });

/**
 * 이후 `attachPageSession` 호출이 사용할 연결 정보를 session 신원에 등록한다.
 * `runtime.ts`가 browser session을 만든 직후 한 번 호출한다.
 */
export const registerBrowserSession = (
  session: RawSession,
  context: PageAttachContext,
): void => {
  attachContexts.set(session, context);
  if (!trackedPages.has(session)) trackedPages.set(session, new Set());
};

/**
 * browser의 DevTools HTTP endpoint로 새 page target을 만들고, 그 target 전용
 * WebSocket에 독립 연결한다. 같은 browser socket을 다중화하지 않으므로 page마다
 * 실제 target 격리가 보장된다.
 */
export const attachPageSession = async (
  browserSession: RawSession,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<PageHandle> => {
  const context = attachContexts.get(browserSession);
  if (context === undefined) {
    throw new TypeError(
      "attachPageSession requires a session created by withBrowserRuntime",
    );
  }
  const handles = trackedPages.get(browserSession) ?? new Set<PageHandle>();
  trackedPages.set(browserSession, handles);

  const signal = combineSignals(options.signal, context.signal);
  const target = await context.http.getJson(
    `${context.httpBaseUrl}/json/new?about:blank`,
    signal,
  );
  const connection = await connectCdp({
    url: webSocketUrlFrom(target),
    signal,
    connectTimeoutMs: context.connectTimeoutMs,
    commandTimeoutMs: context.commandTimeoutMs,
    createSocket: context.createSocket,
    timers: context.timers,
  });
  const session = createRawSession(connection);
  attachContexts.set(session, context);
  trackedPages.set(session, handles);

  let closing: Promise<void> | undefined;
  const closeOnce = async (): Promise<void> => {
    try {
      await session.command("Page.close");
    } catch {
      // page가 이미 사라진 경우를 포함해 종료 요청 실패는 무시한다.
    }
    try {
      connection.close();
    } catch {
      // transport 종료는 best-effort다.
    }
    handles.delete(handle);
  };
  const handle: PageHandle = Object.freeze({
    session,
    close: (): Promise<void> => (closing ??= closeOnce()),
  });
  handles.add(handle);
  return handle;
};

/**
 * 아직 열려 있는 page handle을 모두 닫는다. shutdown 전용 helper이며
 * best-effort로 동시에 닫고 절대 throw하지 않는다.
 */
export const closeTrackedPages = async (
  browserSession: RawSession,
): Promise<void> => {
  const handles = trackedPages.get(browserSession);
  if (handles === undefined || handles.size === 0) return;
  await Promise.all(
    [...handles].map(async (handle) => {
      try {
        await handle.close();
      } catch {
        // handle.close는 throw하지 않지만 정리 경로는 방어적으로 유지한다.
      }
    }),
  );
};
