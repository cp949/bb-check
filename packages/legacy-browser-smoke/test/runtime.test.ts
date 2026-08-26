import { describe, expect, it } from "vitest";
import {
  connectCdp,
  type CdpSocketEvent,
  type CdpSocketEventType,
  type CdpSocketFactory,
  type TimerAdapter,
  type WebSocketLike,
} from "../src/cdp.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";
import type { ChromiumExecutable } from "../src/preflight.js";
import {
  attachPageSession,
  closeTrackedPages,
  createRawSession,
  registerBrowserSession,
  type HttpJsonAdapter,
  type RawSession,
} from "../src/raw-session.js";
import {
  createBrowserRuntime,
  withBrowserRuntime,
  type BrowserRuntimeOptions,
  type ChildProcessLike,
  type ProcessExit,
} from "../src/runtime.js";

interface CdpRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: object;
}

interface PendingTimer {
  readonly id: number;
  readonly delayMs: number;
  readonly callback: () => void;
}

/** 실제 timer 없이 예약/취소를 관찰하고 원하는 시점에 발화시키는 test double. */
class FakeTimers implements TimerAdapter {
  private nextId = 0;
  private readonly timers = new Map<number, PendingTimer>();

  schedule(callback: () => void, delayMs: number): () => void {
    const id = (this.nextId += 1);
    this.timers.set(id, { id, delayMs, callback });
    return (): void => {
      this.timers.delete(id);
    };
  }

  get pendingCount(): number {
    return this.timers.size;
  }

  /** 같은 delay로 예약된 timer를 모두 발화하고 발화 개수를 돌려준다. */
  fire(delayMs: number): number {
    const due = [...this.timers.values()].filter(
      (timer) => timer.delayMs === delayMs,
    );
    for (const timer of due) {
      this.timers.delete(timer.id);
      timer.callback();
    }
    return due.length;
  }
}

/** cdp.ts가 사용하는 WebSocket 부분집합만 구현한 test peer. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  closeCount = 0;
  /** true면 수신한 command마다 빈 result를 자동 응답한다. */
  autoAck = false;
  /** autoAck 상태에서도 응답하지 않을 method 목록. */
  readonly unanswered = new Set<string>();
  readonly sent: string[] = [];

  private readonly listeners = new Map<
    CdpSocketEventType,
    Set<(event: CdpSocketEvent) => void>
  >();

  constructor(
    readonly url: string,
    private readonly log: string[],
    readonly label: string,
  ) {}

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as {
      readonly id: number;
      readonly method?: string;
    };
    this.log.push(`${this.label}:send:${message.method ?? "unknown"}`);
    if (!this.autoAck) return;
    if (message.method !== undefined && this.unanswered.has(message.method)) {
      return;
    }
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      this.deliver({ id: message.id, result: {} });
    });
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = 3;
    this.log.push(`${this.label}:close`);
  }

  addEventListener(
    type: CdpSocketEventType,
    listener: (event: CdpSocketEvent) => void,
  ): void {
    const registered =
      this.listeners.get(type) ?? new Set<(event: CdpSocketEvent) => void>();
    registered.add(listener);
    this.listeners.set(type, registered);
  }

  removeEventListener(
    type: CdpSocketEventType,
    listener: (event: CdpSocketEvent) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(): number {
    let count = 0;
    for (const registered of this.listeners.values()) count += registered.size;
    return count;
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", { type: "open" });
  }

  deliver(message: unknown): void {
    this.dispatch("message", {
      type: "message",
      data: JSON.stringify(message),
    });
  }

  deliverRaw(data: unknown): void {
    this.dispatch("message", { type: "message", data });
  }

  fail(): void {
    this.dispatch("error", { type: "error" });
  }

  remoteClose(code = 1006, reason = "peer closed"): void {
    this.readyState = 3;
    this.dispatch("close", { type: "close", code, reason });
  }

  request(index: number): CdpRequest {
    const raw = this.sent[index];
    if (raw === undefined) {
      throw new Error(`fake socket has no request at index ${index}`);
    }
    return JSON.parse(raw) as CdpRequest;
  }

  private dispatch(type: CdpSocketEventType, event: CdpSocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

const socketFactoryFor = (
  sockets: FakeSocket[],
  log: string[],
  options: { readonly autoOpen?: boolean; readonly autoAck?: boolean } = {},
): CdpSocketFactory => {
  return (url) => {
    const socket = new FakeSocket(url, log, `socket${sockets.length + 1}`);
    socket.autoAck = options.autoAck === true;
    sockets.push(socket);
    if (options.autoOpen !== false) {
      queueMicrotask(() => {
        socket.open();
      });
    }
    return socket;
  };
};

const socketAt = (
  sockets: readonly FakeSocket[],
  index: number,
): FakeSocket => {
  const socket = sockets[index];
  if (socket === undefined) {
    throw new Error(`fake socket ${index} was never created`);
  }
  return socket;
};

/** microtask만 진행시키며 조건이 성립할 때까지 기다린다. */
const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was never reached");
};

const reasonOf = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("promise resolved but a rejection was expected");
    },
    (reason: unknown) => reason,
  );

const browserWsUrl = "ws://127.0.0.1:41111/devtools/browser/abcdef";

const openConnection = async (
  overrides: {
    readonly connectTimeoutMs?: number;
    readonly commandTimeoutMs?: number;
    readonly signal?: AbortSignal;
  } = {},
) => {
  const sockets: FakeSocket[] = [];
  const log: string[] = [];
  const timers = new FakeTimers();
  const connection = await connectCdp({
    url: browserWsUrl,
    createSocket: socketFactoryFor(sockets, log),
    timers,
    ...overrides,
  });
  const socket = sockets[0];
  if (socket === undefined) throw new Error("fake socket was not created");
  return { connection, socket, sockets, timers, log };
};

describe("CDP wire framing", () => {
  it("응답 순서가 뒤바뀌어도 각 command promise에 정확히 대응한다", async () => {
    const { connection, socket } = await openConnection();

    const first = connection.command<{ readonly value: string }>(
      "Target.getTargets",
    );
    const second = connection.command<{ readonly value: string }>(
      "Browser.getVersion",
    );
    const firstId = socket.request(0).id;
    const secondId = socket.request(1).id;
    expect(firstId).not.toBe(secondId);

    socket.deliver({ id: secondId, result: { value: "second" } });
    socket.deliver({ id: firstId, result: { value: "first" } });

    await expect(first).resolves.toEqual({ value: "first" });
    await expect(second).resolves.toEqual({ value: "second" });
  });

  it("params를 그대로 전송하고 params 없는 command는 params 필드를 생략한다", async () => {
    const { connection, socket } = await openConnection();

    void connection.command("Page.navigate", { url: "http://127.0.0.1/" });
    void connection.command("Page.enable");

    expect(socket.request(0)).toEqual({
      id: 1,
      method: "Page.navigate",
      params: { url: "http://127.0.0.1/" },
    });
    expect(socket.request(1)).toEqual({ id: 2, method: "Page.enable" });
  });

  it("CDP protocol error는 code/message/data를 보존한 일반 Error로 reject한다", async () => {
    const { connection, socket } = await openConnection();

    const command = connection.command("Page.navigate");
    socket.deliver({
      id: socket.request(0).id,
      error: {
        code: -32601,
        message: "'Page.navigate' wasn't found",
        data: "unsupported in this build",
      },
    });

    const error = await reasonOf(command);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LegacyBrowserSmokeError);
    expect((error as Error).message).toContain("'Page.navigate' wasn't found");
    expect(error).toMatchObject({
      code: -32601,
      data: "unsupported in this build",
    });
  });

  it("event는 method가 일치하는 listener에만 전달되고 unsubscribe 후에는 전달되지 않는다", async () => {
    const { connection, socket } = await openConnection();
    const consoleEvents: object[] = [];
    const otherEvents: object[] = [];
    const secondConsoleEvents: object[] = [];

    const stopConsole = connection.on("Runtime.consoleAPICalled", (params) => {
      consoleEvents.push(params);
    });
    connection.on("Runtime.consoleAPICalled", (params) => {
      secondConsoleEvents.push(params);
    });
    connection.on("Network.loadingFailed", (params) => {
      otherEvents.push(params);
    });

    socket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "error" },
    });
    stopConsole();
    socket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });

    expect(consoleEvents).toEqual([{ type: "error" }]);
    expect(secondConsoleEvents).toEqual([{ type: "error" }, { type: "log" }]);
    expect(otherEvents).toEqual([]);
  });

  it("형식이 잘못된 message와 throw하는 listener가 dispatch를 중단시키지 않는다", async () => {
    const { connection, socket } = await openConnection();
    const seen: object[] = [];

    connection.on("Runtime.consoleAPICalled", () => {
      throw new Error("listener failure must not stop dispatch");
    });
    connection.on("Runtime.consoleAPICalled", (params) => {
      seen.push(params);
    });

    socket.deliverRaw("not json at all");
    socket.deliverRaw(new Uint8Array([1, 2, 3]));
    socket.deliver([1, 2, 3]);
    socket.deliver({ id: 9999, result: { ignored: true } });
    socket.deliver({ method: "Runtime.consoleAPICalled" });
    socket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
    });

    expect(seen).toEqual([{}, { type: "log" }]);

    const command = connection.command("Browser.getVersion");
    socket.deliver({ id: socket.request(0).id, result: { product: "Chrome" } });
    await expect(command).resolves.toEqual({ product: "Chrome" });
  });

  it("socket이 열리지 않으면 connectTimeoutMs 후 LBS_CONNECT_TIMEOUT으로 실패한다", async () => {
    const sockets: FakeSocket[] = [];
    const log: string[] = [];
    const timers = new FakeTimers();

    const failure = reasonOf(
      connectCdp({
        url: browserWsUrl,
        createSocket: socketFactoryFor(sockets, log, { autoOpen: false }),
        timers,
        connectTimeoutMs: 1234,
      }),
    );
    await waitUntil(() => timers.pendingCount === 1);
    expect(timers.fire(1234)).toBe(1);

    const error = await failure;
    expect(error).toBeInstanceOf(LegacyBrowserSmokeError);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_CONNECT_TIMEOUT");
    expect(timers.pendingCount).toBe(0);
    expect(sockets[0]?.closeCount).toBe(1);
    expect(sockets[0]?.listenerCount()).toBe(0);
  });

  it("open 전에 socket이 error를 내면 LBS_CONNECT_TIMEOUT으로 실패한다", async () => {
    const sockets: FakeSocket[] = [];
    const log: string[] = [];
    const timers = new FakeTimers();

    const failure = reasonOf(
      connectCdp({
        url: browserWsUrl,
        createSocket: socketFactoryFor(sockets, log, { autoOpen: false }),
        timers,
      }),
    );
    await waitUntil(() => sockets.length === 1);
    sockets[0]?.fail();

    const error = await failure;
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_CONNECT_TIMEOUT");
    expect(timers.pendingCount).toBe(0);
  });

  it("응답 없는 command는 commandTimeoutMs 후 LBS_COMMAND_TIMEOUT으로 실패한다", async () => {
    const { connection, timers } = await openConnection({
      commandTimeoutMs: 4321,
    });

    const failure = reasonOf(connection.command("Runtime.evaluate"));
    expect(timers.pendingCount).toBe(1);
    expect(timers.fire(4321)).toBe(1);

    const error = await failure;
    expect(error).toBeInstanceOf(LegacyBrowserSmokeError);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_COMMAND_TIMEOUT");
    expect(timers.pendingCount).toBe(0);
  });

  it("응답이 도착하면 command timeout timer를 즉시 해제한다", async () => {
    const { connection, socket, timers } = await openConnection({
      commandTimeoutMs: 4321,
    });

    const command = connection.command("Browser.getVersion");
    expect(timers.pendingCount).toBe(1);
    socket.deliver({ id: socket.request(0).id, result: { ok: true } });

    await expect(command).resolves.toEqual({ ok: true });
    expect(timers.pendingCount).toBe(0);
    expect(timers.fire(4321)).toBe(0);
  });

  it("peer가 socket을 닫으면 대기 중인 모든 command를 같은 사유로 한 번씩 reject한다", async () => {
    const { connection, socket, timers } = await openConnection();

    const first = reasonOf(connection.command("Target.getTargets"));
    const second = reasonOf(connection.command("Browser.getVersion"));
    socket.remoteClose(1006, "peer closed");

    const [firstReason, secondReason] = await Promise.all([first, second]);
    expect(firstReason).toBeInstanceOf(Error);
    expect(firstReason).toBe(secondReason);
    expect(timers.pendingCount).toBe(0);

    socket.remoteClose(1006, "peer closed");
    expect(socket.closeCount).toBe(1);
    expect(socket.listenerCount()).toBe(0);
  });

  it("종료된 connection의 command는 같은 종료 사유로 즉시 실패한다", async () => {
    const { connection, socket } = await openConnection();

    socket.remoteClose(1001, "browser shutting down");
    const error = await reasonOf(connection.command("Browser.getVersion"));

    expect(error).toBeInstanceOf(Error);
    expect(socket.sent).toEqual([]);
  });

  it("close()는 반복 호출해도 transport를 한 번만 닫고 pending command를 정리한다", async () => {
    const { connection, socket, timers } = await openConnection();

    const pending = reasonOf(connection.command("Runtime.evaluate"));
    connection.close();
    connection.close();
    connection.close();

    expect(await pending).toBeInstanceOf(Error);
    expect(socket.closeCount).toBe(1);
    expect(timers.pendingCount).toBe(0);
  });

  it("abort는 대기 중인 command를 LBS_ABORTED로 reject하고 abort 사유를 cause로 보존한다", async () => {
    const controller = new AbortController();
    const { connection, socket } = await openConnection({
      signal: controller.signal,
    });

    const pending = reasonOf(connection.command("Runtime.evaluate"));
    controller.abort(new Error("caller cancelled"));

    const error = await pending;
    expect(error).toBeInstanceOf(LegacyBrowserSmokeError);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_ABORTED");
    expect((error as LegacyBrowserSmokeError).cause).toBe(
      controller.signal.reason,
    );
    expect(socket.closeCount).toBe(1);
  });

  it("이미 abort된 signal이면 socket을 만들지 않고 LBS_ABORTED로 실패한다", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before connect"));
    const sockets: FakeSocket[] = [];
    const log: string[] = [];

    const error = await reasonOf(
      connectCdp({
        url: browserWsUrl,
        createSocket: socketFactoryFor(sockets, log),
        timers: new FakeTimers(),
        signal: controller.signal,
      }),
    );

    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_ABORTED");
    expect(sockets).toEqual([]);
  });
});

const httpBaseUrl = "http://127.0.0.1:41111";

const pageWsUrl = (index: number): string =>
  `ws://127.0.0.1:41111/devtools/page/PAGE${index}`;

const browserFixture = async (
  options: {
    readonly autoAck?: boolean;
    readonly target?: (index: number) => unknown;
  } = {},
) => {
  const sockets: FakeSocket[] = [];
  const log: string[] = [];
  const timers = new FakeTimers();
  const httpCalls: string[] = [];
  const createSocket = socketFactoryFor(sockets, log, {
    autoAck: options.autoAck === true,
  });
  const makeTarget =
    options.target ??
    ((index: number) => ({
      id: `PAGE${index}`,
      type: "page",
      webSocketDebuggerUrl: pageWsUrl(index),
    }));
  const http: HttpJsonAdapter = {
    getJson: async (url) => {
      httpCalls.push(url);
      return makeTarget(httpCalls.length);
    },
  };
  const connection = await connectCdp({
    url: browserWsUrl,
    createSocket,
    timers,
  });
  const browserSession = createRawSession(connection);
  registerBrowserSession(browserSession, {
    httpBaseUrl,
    http,
    createSocket,
    timers,
    connectTimeoutMs: 1000,
    commandTimeoutMs: 2000,
    signal: undefined,
  });
  return { browserSession, connection, sockets, log, timers, httpCalls };
};

describe("raw session and page attach", () => {
  it("RawSession은 command와 on만 노출하고 transport 종료를 감춘다", async () => {
    const { browserSession } = await browserFixture();

    expect(Object.keys(browserSession).sort()).toEqual(["command", "on"]);
    expect((browserSession as { close?: unknown }).close).toBeUndefined();
  });

  it("attachPageSession은 /json/new로 target을 만들고 전용 socket에 연결한다", async () => {
    const fixture = await browserFixture();

    const handle = await attachPageSession(fixture.browserSession);

    expect(fixture.httpCalls).toEqual([`${httpBaseUrl}/json/new?about:blank`]);
    expect(fixture.sockets).toHaveLength(2);
    expect(socketAt(fixture.sockets, 1).url).toBe(pageWsUrl(1));

    void handle.session.command("Page.enable");
    expect(socketAt(fixture.sockets, 0).sent).toEqual([]);
    expect(socketAt(fixture.sockets, 1).request(0).method).toBe("Page.enable");
  });

  it("page session과 browser session의 event는 서로 격리된다", async () => {
    const fixture = await browserFixture();
    const handle = await attachPageSession(fixture.browserSession);
    const browserEvents: object[] = [];
    const pageEvents: object[] = [];

    fixture.browserSession.on("Runtime.consoleAPICalled", (params) => {
      browserEvents.push(params);
    });
    handle.session.on("Runtime.consoleAPICalled", (params) => {
      pageEvents.push(params);
    });

    socketAt(fixture.sockets, 1).deliver({
      method: "Runtime.consoleAPICalled",
      params: { source: "page" },
    });
    socketAt(fixture.sockets, 0).deliver({
      method: "Runtime.consoleAPICalled",
      params: { source: "browser" },
    });

    expect(pageEvents).toEqual([{ source: "page" }]);
    expect(browserEvents).toEqual([{ source: "browser" }]);
  });

  it("PageHandle.close는 Page.close 후 transport를 닫고 반복 호출해도 throw하지 않는다", async () => {
    const fixture = await browserFixture({ autoAck: true });
    const handle = await attachPageSession(fixture.browserSession);

    await expect(handle.close()).resolves.toBeUndefined();
    await expect(handle.close()).resolves.toBeUndefined();

    expect(fixture.log).toEqual(["socket2:send:Page.close", "socket2:close"]);
    expect(socketAt(fixture.sockets, 1).closeCount).toBe(1);
  });

  it("Page.close가 실패해도 transport를 닫고 close는 throw하지 않는다", async () => {
    const fixture = await browserFixture();
    const handle = await attachPageSession(fixture.browserSession);
    const pageSocket = socketAt(fixture.sockets, 1);

    const closing = handle.close();
    await waitUntil(() => pageSocket.sent.length === 1);
    pageSocket.deliver({
      id: pageSocket.request(0).id,
      error: { code: -32000, message: "target is closing" },
    });

    await expect(closing).resolves.toBeUndefined();
    expect(pageSocket.closeCount).toBe(1);
  });

  it("closeTrackedPages는 열려 있는 page만 닫고 이미 닫힌 page는 다시 닫지 않는다", async () => {
    const fixture = await browserFixture({ autoAck: true });
    const first = await attachPageSession(fixture.browserSession);
    const second = await attachPageSession(fixture.browserSession);
    await first.close();
    fixture.log.length = 0;

    await expect(
      closeTrackedPages(fixture.browserSession),
    ).resolves.toBeUndefined();

    expect(fixture.log).toEqual(["socket3:send:Page.close", "socket3:close"]);
    expect(socketAt(fixture.sockets, 1).closeCount).toBe(1);
    expect(socketAt(fixture.sockets, 2).closeCount).toBe(1);
    expect(second).toBeDefined();
  });

  it("closeTrackedPages는 등록된 적 없는 session에도 조용히 성공한다", async () => {
    const { connection } = await browserFixture();
    const orphan = createRawSession(connection);

    await expect(closeTrackedPages(orphan)).resolves.toBeUndefined();
  });

  it("등록되지 않은 session으로 attachPageSession을 호출하면 TypeError로 거절한다", async () => {
    const { connection } = await browserFixture();
    const orphan = createRawSession(connection);

    await expect(attachPageSession(orphan)).rejects.toBeInstanceOf(TypeError);
  });

  it("/json/new 응답이 유효한 ws URL을 주지 않으면 socket을 만들지 않고 실패한다", async () => {
    for (const target of [
      null,
      {},
      { webSocketDebuggerUrl: "" },
      { webSocketDebuggerUrl: "http://127.0.0.1:41111/devtools/page/PAGE1" },
      { webSocketDebuggerUrl: "not a url" },
      { webSocketDebuggerUrl: 42 },
    ]) {
      const fixture = await browserFixture({ target: () => target });

      await expect(
        attachPageSession(fixture.browserSession),
      ).rejects.toBeInstanceOf(TypeError);
      expect(fixture.sockets).toHaveLength(1);
    }
  });
});

/** 소비자가 도착할 때까지 chunk를 보관하는 최소 async stream. */
class PushStream implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private waiting: ((result: IteratorResult<string>) => void) | undefined;
  private ended = false;

  push(chunk: string): void {
    if (this.ended) return;
    const waiter = this.waiting;
    if (waiter !== undefined) {
      this.waiting = undefined;
      waiter({ done: false, value: chunk });
      return;
    }
    this.queue.push(chunk);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const waiter = this.waiting;
    if (waiter !== undefined) {
      this.waiting = undefined;
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: (): Promise<IteratorResult<string>> => {
        const chunk = this.queue.shift();
        if (chunk !== undefined) {
          return Promise.resolve({ done: false, value: chunk });
        }
        if (this.ended)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/** stderr, 종료 통지, signal 수신을 관찰 가능하게 만든 자식 프로세스 double. */
class FakeChildProcess implements ChildProcessLike {
  readonly stderr = new PushStream();
  readonly exited: Promise<ProcessExit>;
  readonly signals: string[] = [];
  /** true면 SIGTERM 수신 직후 실제 프로세스처럼 스스로 종료한다. */
  exitOnSigterm = true;

  private settleExit!: (exit: ProcessExit) => void;
  private alive = true;

  constructor(private readonly log: string[]) {
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.settleExit = resolve;
    });
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push(signal);
    this.log.push(`process:${signal}`);
    if (signal === "SIGKILL" || this.exitOnSigterm) {
      queueMicrotask(() => {
        this.exit({ code: null, signal });
      });
    }
  }

  /** Chromium이 DevTools endpoint를 알리는 stderr 줄을 흉내낸다. */
  announce(url: string): void {
    this.stderr.push("[0101/000000:INFO:headless.cc(1)] starting\n");
    this.stderr.push(`DevTools listening on ${url}\n`);
  }

  exit(exit: ProcessExit = { code: 0, signal: null }): void {
    if (!this.alive) return;
    this.alive = false;
    this.stderr.end();
    this.settleExit(exit);
  }
}

const executable: ChromiumExecutable = Object.freeze({
  path: "/cache/@cp949/legacy-browser-smoke/browser/chrome-linux/chrome",
  revision: "650583",
  version: "Chromium 75.0.3765.0",
});

const runtimeFixture = (
  options: {
    readonly userId?: number;
    readonly autoAck?: boolean;
    readonly exitOnSigterm?: boolean;
    readonly terminateGraceMs?: number;
    readonly onMkdtemp?: () => void;
  } = {},
) => {
  const log: string[] = [];
  const sockets: FakeSocket[] = [];
  const children: FakeChildProcess[] = [];
  const spawns: { readonly path: string; readonly args: readonly string[] }[] =
    [];
  const httpCalls: string[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const timers = new FakeTimers();

  const run = createBrowserRuntime({
    userId: options.userId ?? 1000,
    timers,
    terminateGraceMs: options.terminateGraceMs ?? 5000,
    temporaryPrefix: "/tmp/lbs-browser-",
    createSocket: socketFactoryFor(sockets, log, {
      autoAck: options.autoAck !== false,
    }),
    process: {
      spawn: (path, args): ChildProcessLike => {
        spawns.push({ path, args });
        const child = new FakeChildProcess(log);
        child.exitOnSigterm = options.exitOnSigterm !== false;
        children.push(child);
        return child;
      },
    },
    fs: {
      mkdtemp: async (prefix) => {
        const directory = `${prefix}${String(created.length + 1)}`;
        created.push(directory);
        options.onMkdtemp?.();
        return directory;
      },
      rm: async (path) => {
        removed.push(path);
      },
    },
    http: {
      getJson: async (url) => {
        httpCalls.push(url);
        return {
          id: `PAGE${String(httpCalls.length)}`,
          type: "page",
          webSocketDebuggerUrl: pageWsUrl(httpCalls.length),
        };
      },
    },
  });

  return {
    run,
    log,
    sockets,
    children,
    spawns,
    httpCalls,
    created,
    removed,
    timers,
  };
};

type RuntimeFixture = ReturnType<typeof runtimeFixture>;

const childAt = (fixture: RuntimeFixture, index: number): FakeChildProcess => {
  const child = fixture.children[index];
  if (child === undefined) {
    throw new Error(`fake child process ${index} was never spawned`);
  }
  return child;
};

const startBrowser = <T>(
  fixture: RuntimeFixture,
  operation: (session: RawSession) => Promise<T>,
  overrides: Omit<BrowserRuntimeOptions, "executable"> = {},
): Promise<T> => fixture.run({ executable, ...overrides }, operation);

/** 자식 프로세스가 DevTools endpoint를 알리고 browser socket이 열릴 때까지 진행한다. */
const reachConnected = async (fixture: RuntimeFixture): Promise<void> => {
  await waitUntil(() => fixture.children.length === 1);
  childAt(fixture, 0).announce(browserWsUrl);
  await waitUntil(() => fixture.sockets.length === 1);
};

describe("withBrowserRuntime", () => {
  it("root 사용자에서 sandbox required면 프로세스를 만들기 전에 LBS_SANDBOX_UNAVAILABLE로 거절한다", async () => {
    const scenarios: readonly Omit<BrowserRuntimeOptions, "executable">[] = [
      {},
      { sandbox: { mode: "required" } },
    ];
    for (const overrides of scenarios) {
      const fixture = runtimeFixture({ userId: 0 });

      const error = await reasonOf(
        startBrowser(fixture, async () => "unreachable", overrides),
      );

      expect(error).toBeInstanceOf(LegacyBrowserSmokeError);
      expect((error as LegacyBrowserSmokeError).code).toBe(
        "LBS_SANDBOX_UNAVAILABLE",
      );
      expect(fixture.spawns).toEqual([]);
      expect(fixture.created).toEqual([]);
    }
  });

  it("sandbox disabled의 reason이 비어 있으면 LBS_CONFIG_INVALID로 거절한다", async () => {
    for (const sandbox of [
      { mode: "disabled", reason: "" },
      { mode: "disabled", reason: "   " },
      { mode: "disabled" } as unknown as { mode: "disabled"; reason: string },
    ] satisfies readonly BrowserRuntimeOptions["sandbox"][]) {
      const fixture = runtimeFixture({ userId: 0 });

      const error = await reasonOf(
        startBrowser(fixture, async () => "unreachable", { sandbox }),
      );

      expect((error as LegacyBrowserSmokeError).code).toBe(
        "LBS_CONFIG_INVALID",
      );
      expect(fixture.spawns).toEqual([]);
    }
  });

  it("공개 withBrowserRuntime도 잘못된 sandbox 설정을 프로세스 실행 전에 거절한다", async () => {
    const error = await reasonOf(
      withBrowserRuntime(
        {
          executable,
          sandbox: { mode: "disabled", reason: "  " },
        },
        async () => "unreachable",
      ),
    );

    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_CONFIG_INVALID");
  });

  it("sandbox required는 --no-sandbox 없이 고정 launch flag로 실행한다", async () => {
    const fixture = runtimeFixture();

    const promise = startBrowser(fixture, async () => "done");
    await reachConnected(fixture);

    await expect(promise).resolves.toBe("done");
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0]?.path).toBe(executable.path);
    expect(fixture.spawns[0]?.args).toEqual([
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      "--user-data-dir=/tmp/lbs-browser-1",
      "about:blank",
    ]);
    expect(fixture.created).toEqual(["/tmp/lbs-browser-1"]);
    expect(fixture.removed).toEqual(["/tmp/lbs-browser-1"]);
  });

  it("sandbox disabled에 reason이 있으면 root에서도 --no-sandbox로 실행한다", async () => {
    const fixture = runtimeFixture({ userId: 0 });

    const promise = startBrowser(fixture, async () => "done", {
      sandbox: { mode: "disabled", reason: "container has no user namespaces" },
    });
    await reachConnected(fixture);

    await expect(promise).resolves.toBe("done");
    expect(fixture.spawns[0]?.args).toEqual([
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--remote-debugging-port=0",
      "--user-data-dir=/tmp/lbs-browser-1",
      "--no-sandbox",
      "about:blank",
    ]);
  });

  it("operation은 browser 전용 socket에 연결된 browser-level session을 받는다", async () => {
    const fixture = runtimeFixture();

    const promise = startBrowser(fixture, async (session) =>
      session.command("Target.getTargets"),
    );
    await reachConnected(fixture);

    await expect(promise).resolves.toEqual({});
    expect(socketAt(fixture.sockets, 0).url).toBe(browserWsUrl);
    expect(socketAt(fixture.sockets, 0).request(0).method).toBe(
      "Target.getTargets",
    );
  });

  it("DevTools 줄 없이 프로세스가 먼저 종료하면 exit 정보를 cause로 담아 LBS_CONNECT_TIMEOUT으로 실패한다", async () => {
    const fixture = runtimeFixture();

    const promise = startBrowser(fixture, async () => "unreachable");
    await waitUntil(() => fixture.children.length === 1);
    childAt(fixture, 0).exit({ code: 1, signal: null });

    const error = await reasonOf(promise);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_CONNECT_TIMEOUT");
    expect((error as LegacyBrowserSmokeError).cause).toEqual({
      code: 1,
      signal: null,
    });
    expect(fixture.sockets).toEqual([]);
    expect(childAt(fixture, 0).signals).toEqual([]);
    expect(fixture.removed).toEqual(["/tmp/lbs-browser-1"]);
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("connectTimeoutMs 안에 DevTools 줄이 없으면 LBS_CONNECT_TIMEOUT으로 실패하고 프로세스를 정리한다", async () => {
    const fixture = runtimeFixture();

    const promise = startBrowser(fixture, async () => "unreachable", {
      connectTimeoutMs: 7000,
    });
    await waitUntil(
      () => fixture.children.length === 1 && fixture.timers.pendingCount === 1,
    );
    expect(fixture.timers.fire(7000)).toBe(1);

    const error = await reasonOf(promise);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_CONNECT_TIMEOUT");
    expect(childAt(fixture, 0).signals).toEqual(["SIGTERM"]);
    expect(fixture.removed).toEqual(["/tmp/lbs-browser-1"]);
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("종료는 tracked page close, browser session close, process signal 순서로 진행한다", async () => {
    const fixture = runtimeFixture();

    const promise = startBrowser(fixture, async (session) => {
      await attachPageSession(session);
      return "done";
    });
    await reachConnected(fixture);

    await expect(promise).resolves.toBe("done");
    expect(fixture.httpCalls).toEqual([
      "http://127.0.0.1:41111/json/new?about:blank",
    ]);
    expect(fixture.log).toEqual([
      "socket2:send:Page.close",
      "socket2:close",
      "socket1:send:Browser.close",
      "socket1:close",
      "process:SIGTERM",
    ]);
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("Browser.close가 응답하지 않아도 grace 경과 후 정리를 이어간다", async () => {
    const fixture = runtimeFixture({ terminateGraceMs: 250 });

    const promise = startBrowser(fixture, async () => {
      // 응답도 socket 종료도 하지 않는 브라우저를 재현한다.
      socketAt(fixture.sockets, 0).unanswered.add("Browser.close");
      return "done";
    });
    await reachConnected(fixture);
    await waitUntil(() => fixture.log.includes("socket1:send:Browser.close"));

    // 이 시점 pending timer는 Browser.close의 grace deadline 하나뿐이다.
    expect(fixture.timers.fire(250)).toBe(1);

    await expect(promise).resolves.toBe("done");
    expect(fixture.log).toEqual([
      "socket1:send:Browser.close",
      "socket1:close",
      "process:SIGTERM",
    ]);
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("operation이 실패해도 같은 정리 순서를 한 번만 수행하고 원래 오류를 보존한다", async () => {
    const fixture = runtimeFixture();
    const failure = new Error("operation failed");

    const promise = startBrowser(fixture, async (session) => {
      await attachPageSession(session);
      throw failure;
    });
    await reachConnected(fixture);

    expect(await reasonOf(promise)).toBe(failure);
    expect(fixture.log).toEqual([
      "socket2:send:Page.close",
      "socket2:close",
      "socket1:send:Browser.close",
      "socket1:close",
      "process:SIGTERM",
    ]);
    expect(childAt(fixture, 0).signals).toEqual(["SIGTERM"]);
    expect(fixture.removed).toEqual(["/tmp/lbs-browser-1"]);
  });

  it("connect 중 abort하면 LBS_ABORTED로 실패하고 프로세스를 한 번만 종료한다", async () => {
    const fixture = runtimeFixture();
    const controller = new AbortController();

    const promise = startBrowser(fixture, async () => "unreachable", {
      signal: controller.signal,
    });
    await waitUntil(() => fixture.children.length === 1);
    controller.abort(new Error("cancelled while connecting"));

    const error = await reasonOf(promise);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_ABORTED");
    expect((error as LegacyBrowserSmokeError).cause).toBe(
      controller.signal.reason,
    );
    expect(childAt(fixture, 0).signals).toEqual(["SIGTERM"]);
    expect(fixture.removed).toEqual(["/tmp/lbs-browser-1"]);
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("spawn 직전에 abort된 signal이면 endpoint를 기다리지 않고 프로세스를 정리한다", async () => {
    const controller = new AbortController();
    const fixture = runtimeFixture({
      onMkdtemp: () => {
        controller.abort(new Error("cancelled before the endpoint appeared"));
      },
    });

    const promise = startBrowser(fixture, async () => "unreachable", {
      signal: controller.signal,
    });

    const error = await reasonOf(promise);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_ABORTED");
    expect(fixture.children).toHaveLength(1);
    expect(childAt(fixture, 0).signals).toEqual(["SIGTERM"]);
    expect(fixture.removed).toEqual(["/tmp/lbs-browser-1"]);
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("operation 중 abort하면 대기 중 command가 LBS_ABORTED로 끊기고 정리는 한 번만 실행된다", async () => {
    const fixture = runtimeFixture();
    const controller = new AbortController();

    const promise = startBrowser(
      fixture,
      async (session) => {
        socketAt(fixture.sockets, 0).unanswered.add("Runtime.evaluate");
        const pending = reasonOf(session.command("Runtime.evaluate"));
        controller.abort(new Error("cancelled mid operation"));
        throw await pending;
      },
      { signal: controller.signal },
    );
    await reachConnected(fixture);

    const error = await reasonOf(promise);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_ABORTED");
    expect(childAt(fixture, 0).signals).toEqual(["SIGTERM"]);
    expect(fixture.removed).toEqual(["/tmp/lbs-browser-1"]);
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("이미 종료한 프로세스에는 종료 signal을 보내지 않는다", async () => {
    const fixture = runtimeFixture();

    const promise = startBrowser(fixture, async (session) => {
      childAt(fixture, 0).exit({ code: 0, signal: null });
      // 왕복 command 한 번으로 exit 통지가 반영될 시간을 준다.
      await session.command("Browser.getVersion");
      return "done";
    });
    await reachConnected(fixture);

    await expect(promise).resolves.toBe("done");
    expect(childAt(fixture, 0).signals).toEqual([]);
    expect(fixture.log).not.toContain("process:SIGTERM");
    expect(fixture.removed).toEqual(["/tmp/lbs-browser-1"]);
  });

  it("SIGTERM 후 grace 안에 종료하지 않으면 SIGKILL을 한 번 더 보낸다", async () => {
    const fixture = runtimeFixture({
      exitOnSigterm: false,
      terminateGraceMs: 250,
    });

    const promise = startBrowser(fixture, async () => "done");
    await reachConnected(fixture);
    await waitUntil(() => childAt(fixture, 0).signals.length === 1);
    expect(childAt(fixture, 0).signals).toEqual(["SIGTERM"]);
    expect(fixture.timers.fire(250)).toBe(1);

    await expect(promise).resolves.toBe("done");
    expect(childAt(fixture, 0).signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(fixture.timers.pendingCount).toBe(0);
  });
});
