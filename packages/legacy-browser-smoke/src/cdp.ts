import { LegacyBrowserSmokeError } from "./errors.js";

/** cdp.ts가 실제로 구독하는 WebSocket event 종류. */
export type CdpSocketEventType = "open" | "message" | "error" | "close";

/**
 * open/message/error/close event에서 실제로 읽는 필드만 모은 구조.
 * 표준 `Event`/`MessageEvent`/`CloseEvent`가 그대로 만족한다.
 */
export interface CdpSocketEvent {
  readonly type: string;
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
}

/** cdp.ts가 사용하는 표준 WebSocket의 최소 부분집합. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: CdpSocketEventType,
    listener: (event: CdpSocketEvent) => void,
  ): void;
  removeEventListener(
    type: CdpSocketEventType,
    listener: (event: CdpSocketEvent) => void,
  ): void;
}

/** ws URL로 transport를 만드는 주입 가능한 factory. */
export type CdpSocketFactory = (url: string) => WebSocketLike;

/** 실제 timer 대신 주입할 수 있는 지연 실행 adapter. */
export interface TimerAdapter {
  /** `delayMs` 후 `callback`을 실행하고, 취소 함수를 반환한다. */
  schedule(callback: () => void, delayMs: number): () => void;
}

/** JSON-RPC framing만 담당하는 CDP 연결. 프로세스나 페이지 개념은 모른다. */
export interface CdpConnection {
  command<T>(method: string, params?: object): Promise<T>;
  on(method: string, listener: (params: object) => void): () => void;
  /** idempotent transport 종료. 이미 종료했으면 아무 일도 하지 않는다. */
  close(): void;
}

export interface CdpConnectOptions {
  readonly url: string;
  readonly signal?: AbortSignal | undefined;
  readonly connectTimeoutMs?: number | undefined;
  readonly commandTimeoutMs?: number | undefined;
  readonly createSocket?: CdpSocketFactory | undefined;
  readonly timers?: TimerAdapter | undefined;
}

export const defaultConnectTimeoutMs = 10_000;
export const defaultCommandTimeoutMs = 30_000;

export const nodeTimers: TimerAdapter = {
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return (): void => {
      clearTimeout(timer);
    };
  },
};

const globalSocketFactory: CdpSocketFactory = (url) => new WebSocket(url);

interface PendingCommand {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveDuration = (
  value: number | undefined,
  fallback: number,
): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

const abortError = (signal: AbortSignal): LegacyBrowserSmokeError =>
  new LegacyBrowserSmokeError("LBS_ABORTED", "operation was aborted", {
    cause: signal.reason,
  });

/**
 * CDP `{id, error}` 응답은 이 패키지의 안정 계약이 아니라 통과시키는 protocol
 * 실패이므로 `LegacyBrowserSmokeError`가 아닌 일반 `Error`로 만든다.
 */
const protocolError = (
  error: Readonly<Record<string, unknown>>,
  method: string,
): Error => {
  const message =
    typeof error.message === "string" && error.message !== ""
      ? error.message
      : "unknown protocol error";
  const failure: Error & { code?: unknown; data?: unknown } = new Error(
    `CDP command ${method} failed: ${message}`,
  );
  if ("code" in error) failure.code = error.code;
  if ("data" in error) failure.data = error.data;
  return failure;
};

const closeError = (event: CdpSocketEvent): Error => {
  const code = event.code === undefined ? "unknown" : String(event.code);
  const reason =
    typeof event.reason === "string" && event.reason !== ""
      ? `, reason=${event.reason}`
      : "";
  return new Error(`CDP connection closed (code=${code}${reason})`);
};

const parseMessage = (
  data: unknown,
): Readonly<Record<string, unknown>> | undefined => {
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // 손상된 frame은 dispatch를 중단시키지 않고 버린다.
    return undefined;
  }
};

/**
 * ws URL에 연결하고 CDP JSON-RPC framing을 제공하는 연결을 만든다.
 * open까지는 `connectTimeoutMs`, 개별 command는 `commandTimeoutMs`로 제한한다.
 */
export const connectCdp = async (
  options: CdpConnectOptions,
): Promise<CdpConnection> => {
  const url = options.url;
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("CDP url must be a non-empty string");
  }
  const signal = options.signal;
  if (signal?.aborted === true) throw abortError(signal);

  const createSocket = options.createSocket ?? globalSocketFactory;
  const timers = options.timers ?? nodeTimers;
  const connectTimeoutMs = positiveDuration(
    options.connectTimeoutMs,
    defaultConnectTimeoutMs,
  );
  const commandTimeoutMs = positiveDuration(
    options.commandTimeoutMs,
    defaultCommandTimeoutMs,
  );

  const pending = new Map<number, PendingCommand>();
  const listeners = new Map<string, Set<(params: object) => void>>();
  let settleReason: Error | undefined;
  let opened = false;
  let nextId = 0;

  let resolveOpen!: () => void;
  let rejectOpen!: (reason: Error) => void;
  const openPromise = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });

  const socket = createSocket(url);

  const onOpen = (): void => {
    if (settleReason !== undefined) return;
    opened = true;
    resolveOpen();
  };

  const onMessage = (event: CdpSocketEvent): void => {
    if (settleReason !== undefined) return;
    const message = parseMessage(event.data);
    if (message === undefined) return;
    const id = message.id;
    if (typeof id === "number") {
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      const error = message.error;
      if (isRecord(error)) {
        entry.reject(protocolError(error, entry.method));
        return;
      }
      entry.resolve(message.result);
      return;
    }
    const method = message.method;
    if (typeof method !== "string" || method === "") return;
    const params = isRecord(message.params) ? message.params : {};
    for (const listener of [...(listeners.get(method) ?? [])]) {
      try {
        listener(params);
      } catch {
        // 한 listener의 실패가 나머지 dispatch를 막지 않게 한다.
      }
    }
  };

  const onError = (event: CdpSocketEvent): void => {
    settle(
      opened
        ? new Error("CDP connection failed", { cause: event })
        : new LegacyBrowserSmokeError(
            "LBS_CONNECT_TIMEOUT",
            `CDP websocket failed before opening: ${url}`,
            { cause: event },
          ),
    );
  };

  const onClose = (event: CdpSocketEvent): void => {
    settle(
      opened
        ? closeError(event)
        : new LegacyBrowserSmokeError(
            "LBS_CONNECT_TIMEOUT",
            `CDP websocket closed before opening: ${url}`,
            { cause: event },
          ),
    );
  };

  const onAbort = (): void => {
    if (signal === undefined) return;
    settle(abortError(signal));
  };

  function settle(reason: Error): void {
    if (settleReason !== undefined) return;
    settleReason = reason;
    socket.removeEventListener("open", onOpen);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
    listeners.clear();
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) entry.reject(reason);
    rejectOpen(reason);
    try {
      socket.close();
    } catch {
      // transport 종료는 best-effort다.
    }
  }

  socket.addEventListener("open", onOpen);
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort, { once: true });

  const cancelConnectTimer = timers.schedule(() => {
    settle(
      new LegacyBrowserSmokeError(
        "LBS_CONNECT_TIMEOUT",
        `CDP websocket did not open within ${connectTimeoutMs}ms: ${url}`,
      ),
    );
  }, connectTimeoutMs);

  try {
    await openPromise;
  } finally {
    cancelConnectTimer();
  }

  const command = async <T>(method: string, params?: object): Promise<T> => {
    if (typeof method !== "string" || method === "") {
      throw new TypeError("CDP method must be a non-empty string");
    }
    if (settleReason !== undefined) throw settleReason;
    const id = (nextId += 1);
    const frame = JSON.stringify(
      params === undefined ? { id, method } : { id, method, params },
    );
    return new Promise<T>((resolve, reject) => {
      let cancelTimer = (): void => {};
      pending.set(id, {
        method,
        resolve: (value) => {
          cancelTimer();
          resolve(value as T);
        },
        reject: (reason) => {
          cancelTimer();
          reject(reason);
        },
      });
      try {
        socket.send(frame);
      } catch (error) {
        pending.delete(id);
        reject(error);
        return;
      }
      cancelTimer = timers.schedule(() => {
        pending.delete(id);
        reject(
          new LegacyBrowserSmokeError(
            "LBS_COMMAND_TIMEOUT",
            `CDP command ${method} timed out after ${commandTimeoutMs}ms`,
          ),
        );
      }, commandTimeoutMs);
    });
  };

  const on = (
    method: string,
    listener: (params: object) => void,
  ): (() => void) => {
    if (typeof method !== "string" || method === "") {
      throw new TypeError("CDP event method must be a non-empty string");
    }
    if (typeof listener !== "function") {
      throw new TypeError("CDP event listener must be a function");
    }
    const registered =
      listeners.get(method) ?? new Set<(params: object) => void>();
    registered.add(listener);
    listeners.set(method, registered);
    return (): void => {
      registered.delete(listener);
    };
  };

  const close = (): void => {
    settle(new Error("CDP connection closed by the caller"));
  };

  return Object.freeze({ command, on, close });
};
