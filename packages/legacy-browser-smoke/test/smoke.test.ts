import { describe, expect, it } from "vitest";
import type {
  CdpSocketEvent,
  CdpSocketEventType,
  CdpSocketFactory,
  TimerAdapter,
  WebSocketLike,
} from "../src/cdp.js";
import type { SmokePage } from "../src/config.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";
import type { ChromiumExecutable } from "../src/preflight.js";
import {
  createBrowserRuntime,
  type BrowserRuntimeRunner,
  type ChildProcessLike,
  type ProcessExit,
} from "../src/runtime.js";
import {
  defaultReadyPollIntervalMs,
  runSmoke,
  type RunSmokeInput,
} from "../src/smoke.js";

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

  /** 지정한 delay로 예약된 pending timer 개수. */
  pendingAt(delayMs: number): number {
    let count = 0;
    for (const timer of this.timers.values()) {
      if (timer.delayMs === delayMs) count += 1;
    }
    return count;
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

type ResponderOutcome =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "error"; readonly code: number; readonly message: string }
  | undefined;

type Responder = (message: {
  readonly id: number;
  readonly method: string;
  readonly params?: object;
}) => ResponderOutcome;

/** 항상 빈 result로 ack하는 기본 responder. */
const ackEverything: Responder = () => undefined;

/** cdp.ts가 사용하는 WebSocket 부분집합만 구현하고, command 응답을 script로 제어하는 test peer. */
class ScriptedSocket implements WebSocketLike {
  readyState = 0;
  closeCount = 0;
  responder: Responder = ackEverything;
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
      readonly method: string;
      readonly params?: object;
    };
    this.log.push(`${this.label}:send:${message.method}`);
    const outcome = this.responder(message);
    queueMicrotask(() => {
      if (this.readyState === 3) return;
      if (outcome === undefined) {
        this.deliver({ id: message.id, result: {} });
      } else if (outcome.kind === "error") {
        this.deliver({
          id: message.id,
          error: { code: outcome.code, message: outcome.message },
        });
      } else {
        this.deliver({ id: message.id, result: outcome.value });
      }
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

  private dispatch(type: CdpSocketEventType, event: CdpSocketEvent): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

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
    // 이 fixture의 가짜 프로세스는 항상 SIGTERM을 받으면 스스로 종료한다.
    queueMicrotask(() => {
      this.exit({ code: null, signal });
    });
  }

  /** Chromium이 DevTools endpoint를 알리는 stderr 줄을 흉내낸다. */
  announce(url: string): void {
    this.stderr.push(`DevTools listening on ${url}\n`);
  }

  exit(exit: ProcessExit = { code: 0, signal: null }): void {
    if (!this.alive) return;
    this.alive = false;
    this.stderr.end();
    this.settleExit(exit);
  }
}

/** microtask만 진행시키며 조건이 성립할 때까지 기다린다. */
const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
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
const httpBaseUrl = "http://127.0.0.1:41111";
const pageWsUrl = (index: number): string =>
  `ws://127.0.0.1:41111/devtools/page/PAGE${String(index)}`;

const executable: ChromiumExecutable = Object.freeze({
  path: "/cache/@cp949/legacy-browser-smoke/browser/chrome-linux/chrome",
  revision: "650583",
  version: "Chromium 75.0.3765.0",
});

const defaultSnapshotValue = Object.freeze({
  scripts: [] as readonly string[],
  stylesheets: [] as readonly unknown[],
});

/**
 * ready 상태를 test 코드가 직접 flip하는 responder를 만든다. `Runtime.evaluate`
 * 호출이 resources.ts의 DOM snapshot 식(querySelectorAll 포함)이면 snapshot 값을
 * 돌려주고, 그 외에는 ready-poll 호출로 보고 `state.ready`를 그대로 반영한다.
 */
const createPageResponder = (
  state: { ready: boolean },
  snapshotValue: {
    readonly scripts: readonly string[];
    readonly stylesheets: readonly unknown[];
  } = defaultSnapshotValue,
): Responder => {
  return (message) => {
    if (message.method !== "Runtime.evaluate") return undefined;
    const params = message.params as
      { readonly expression?: string } | undefined;
    if (params?.expression?.includes("querySelectorAll") === true) {
      return {
        kind: "result",
        value: { result: { type: "object", value: snapshotValue } },
      };
    }
    return {
      kind: "result",
      value: { result: { type: "boolean", value: state.ready } },
    };
  };
};

interface SmokeFixtureOptions {
  readonly userId?: number;
  /** page attach 순서대로, 각 page의 ready 상태를 test가 flip할 수 있는 state. */
  readonly pageStates?: readonly { ready: boolean }[];
  readonly pageSnapshots?: readonly (
    | {
        readonly scripts: readonly string[];
        readonly stylesheets: readonly unknown[];
      }
    | undefined
  )[];
}

const smokeFixture = (options: SmokeFixtureOptions = {}) => {
  const log: string[] = [];
  const sockets: ScriptedSocket[] = [];
  const children: FakeChildProcess[] = [];
  const httpCalls: string[] = [];
  const timers = new FakeTimers();
  const pageStates = options.pageStates ?? [];
  const pageSnapshots = options.pageSnapshots ?? [];

  const createSocket: CdpSocketFactory = (url) => {
    const index = sockets.length;
    const socket = new ScriptedSocket(url, log, `socket${String(index + 1)}`);
    if (index === 0) {
      socket.responder = ackEverything;
    } else {
      const state = pageStates[index - 1];
      if (state === undefined) {
        throw new Error(
          `smokeFixture: no pageStates entry for page socket ${String(index)}`,
        );
      }
      socket.responder = createPageResponder(state, pageSnapshots[index - 1]);
    }
    sockets.push(socket);
    queueMicrotask(() => {
      socket.open();
    });
    return socket;
  };

  const runtime: BrowserRuntimeRunner = createBrowserRuntime({
    userId: options.userId ?? 1000,
    timers,
    terminateGraceMs: 5000,
    temporaryPrefix: "/tmp/lbs-smoke-",
    createSocket,
    process: {
      spawn: (): ChildProcessLike => {
        const child = new FakeChildProcess(log);
        children.push(child);
        return child;
      },
    },
    fs: {
      mkdtemp: async (prefix) => `${prefix}1`,
      rm: async () => {},
    },
    http: {
      getJson: async (url) => {
        httpCalls.push(url);
        const index = httpCalls.length;
        return {
          id: `PAGE${String(index)}`,
          type: "page",
          webSocketDebuggerUrl: pageWsUrl(index),
        };
      },
    },
  });

  return { runtime, log, sockets, children, httpCalls, timers };
};

type SmokeFixture = ReturnType<typeof smokeFixture>;

/** 자식 프로세스가 DevTools endpoint를 알리고 browser socket이 열릴 때까지 진행한다. */
const reachConnected = async (fixture: SmokeFixture): Promise<void> => {
  await waitUntil(() => fixture.children.length === 1);
  const child = fixture.children[0];
  if (child === undefined) throw new Error("child process was not spawned");
  child.announce(browserWsUrl);
  await waitUntil(() => fixture.sockets.length === 1);
};

/** `order`번째(1-based)로 attach된 page socket을 기다려 돌려준다. */
const attachNextPageSocket = async (
  fixture: SmokeFixture,
  order: number,
): Promise<ScriptedSocket> => {
  await waitUntil(() => fixture.sockets.length > order);
  const socket = fixture.sockets[order];
  if (socket === undefined) {
    throw new Error(`page socket ${String(order)} was not created`);
  }
  return socket;
};

/**
 * page socket이 `Page.navigate`를 보내고(listener 등록이 끝났다는 증거), 첫 번째
 * ready-poll tick이 이미 완료되어(`state.ready`가 아직 false였을 때 소비되고) 다음
 * poll timer가 예약된 시점까지 기다린다. 이 시점 이후에야 signal을 전달하고
 * `state.ready`를 뒤집는 것이 race-free하다 — 그 전에 뒤집으면 아직 전송되지 않은
 * 첫 tick이 곧바로 ready=true를 읽어 버려 signal을 전달할 틈이 사라진다.
 */
const waitForFirstPollRegistered = async (
  fixture: SmokeFixture,
  label: string,
  pollIntervalMs: number,
): Promise<void> => {
  await waitUntil(() => fixture.log.includes(`${label}:send:Page.navigate`));
  await waitUntil(() => fixture.timers.pendingAt(pollIntervalMs) >= 1);
};

const baseInput = (
  fixture: SmokeFixture,
  overrides: Partial<RunSmokeInput> & { readonly pages: readonly SmokePage[] },
): RunSmokeInput => ({
  origin: "http://127.0.0.1",
  executable,
  timeoutMs: 500,
  knownUnsupported: [],
  runtime: fixture.runtime,
  timers: fixture.timers,
  readyPollIntervalMs: 10,
  ...overrides,
});

const page = (
  name: string,
  path: `/${string}`,
  ready: SmokePage["ready"] = { kind: "selector", selector: "#app" },
): SmokePage => ({ name, path, ready });

describe("runSmoke", () => {
  it("잘못된 origin은 프로세스를 만들기 전에 LBS_ORIGIN_NOT_LOOPBACK으로 거절한다", async () => {
    const fixture = smokeFixture({ pageStates: [{ ready: true }] });

    const error = await reasonOf(
      runSmoke(
        baseInput(fixture, {
          origin: "https://127.0.0.1",
          pages: [page("home", "/")],
        }),
      ),
    );

    expect(error).toBeInstanceOf(LegacyBrowserSmokeError);
    expect((error as LegacyBrowserSmokeError).code).toBe(
      "LBS_ORIGIN_NOT_LOOPBACK",
    );
    expect(fixture.children).toEqual([]);
  });

  it("selector 조건이 false에서 true로 바뀌면 페이지가 ready가 되고 신호가 없으면 pass다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("home", "/", { kind: "selector", selector: "#app" })],
      }),
    );

    await reachConnected(fixture);
    await attachNextPageSocket(fixture, 1);

    // 첫 tick은 아직 false다 — poll timer가 재예약되는 것으로 확인한다.
    await waitUntil(() => fixture.timers.pendingAt(10) >= 1);
    expect(fixture.timers.fire(10)).toBe(1);

    // 다음 tick 전에 false에서 true로 뒤집는다.
    state.ready = true;
    await waitUntil(() => fixture.timers.pendingAt(10) >= 1);
    fixture.timers.fire(10);

    const report = await promise;

    expect(report).toEqual({
      status: "pass",
      browserVersion: executable.version,
      pages: [
        {
          name: "home",
          status: "pass",
          unexpectedSignals: [],
          missingKnownUnsupported: [],
        },
      ],
    });
    expect(fixture.httpCalls).toEqual([`${httpBaseUrl}/json/new?about:blank`]);
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("expression 조건도 동일하게 ready 판정에 사용된다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [
          page("home", "/", {
            kind: "expression",
            expression: "window.__ready === true",
          }),
        ],
      }),
    );

    await reachConnected(fixture);
    await attachNextPageSocket(fixture, 1);
    await waitUntil(() => fixture.timers.pendingAt(10) >= 1);
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.status).toBe("pass");
    expect(report.pages[0]?.status).toBe("pass");
  });

  it("ready 조건이 timeoutMs 안에 충족되지 않으면 LBS_PAGE_NOT_READY로 전체 호출이 거부되고 page session도 close된다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        timeoutMs: 200,
        pages: [page("slow", "/")],
      }),
    );

    await reachConnected(fixture);
    await attachNextPageSocket(fixture, 1);
    await waitUntil(() => fixture.timers.pendingAt(200) >= 1);
    fixture.timers.fire(200);

    const error = await reasonOf(promise);

    expect(error).toBeInstanceOf(LegacyBrowserSmokeError);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_PAGE_NOT_READY");
    expect(fixture.log).toContain("socket2:send:Page.close");
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("undeclared page-error(JS 예외)는 unexpectedSignals에 남고 status를 fail로 만든다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("home", "/")],
      }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    pageSocket.deliver({
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: { text: "Uncaught TypeError: boom" } },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.status).toBe("fail");
    expect(report.pages[0]).toEqual({
      name: "home",
      status: "fail",
      unexpectedSignals: [
        { kind: "page-error", text: "Uncaught TypeError: boom" },
      ],
      missingKnownUnsupported: [],
    });
  });

  it("선언된 page-error는 조용히 소비되어 status가 pass로 유지된다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("home", "/")],
        knownUnsupported: [
          {
            kind: "page-error",
            pattern: "Uncaught TypeError: boom",
            count: 1,
            reason: "레거시 예외",
          },
        ],
      }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    pageSocket.deliver({
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: { text: "Uncaught TypeError: boom" } },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.status).toBe("pass");
    expect(report.pages[0]).toEqual({
      name: "home",
      status: "pass",
      unexpectedSignals: [],
      missingKnownUnsupported: [],
    });
  });

  it("console error 이벤트는 console signal을 만들고 warning/log는 만들지 않는다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("home", "/")],
      }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    pageSocket.deliver({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "error",
        args: [{ description: "console boom" }],
      },
    });
    pageSocket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "warning", args: [{ description: "should be ignored" }] },
    });
    pageSocket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [{ description: "should be ignored" }] },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.pages[0]?.unexpectedSignals).toEqual([
      { kind: "console", text: "console boom" },
    ]);
  });

  it("console error의 여러 args는 description/value/type 우선순위로 렌더링되어 공백으로 join된다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("home", "/")],
      }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    pageSocket.deliver({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "error",
        args: [{ description: "first" }, { value: 42 }, { type: "undefined" }],
      },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.pages[0]?.unexpectedSignals).toEqual([
      { kind: "console", text: "first 42 undefined" },
    ]);
  });

  it("request-failed와 http-error signal은 resources.ts collector를 거쳐 SmokePageResult에 반영된다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("home", "/")],
      }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    pageSocket.deliver({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "failed-1",
        type: "Script",
        request: { url: "https://example.test/legacy.js" },
      },
    });
    pageSocket.deliver({
      method: "Network.loadingFailed",
      params: {
        requestId: "failed-1",
        errorText: "net::ERR_FAILED",
        canceled: false,
      },
    });
    pageSocket.deliver({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "http-1",
        type: "Document",
        request: { url: "https://example.test/gone" },
      },
    });
    pageSocket.deliver({
      method: "Network.responseReceived",
      params: { requestId: "http-1", response: { status: 404 } },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.pages[0]?.unexpectedSignals).toEqual([
      {
        kind: "http-error",
        text: "status=404; type=Document; path=/gone",
      },
      {
        kind: "request-failed",
        text: "type=Script; path=/legacy.js; error=net::ERR_FAILED; blocked=; canceled=false",
      },
    ]);
    expect(report.pages[0]?.status).toBe("fail");
  });

  it("여러 종류가 섞인 known-unsupported 선언이 정확히 소비되면 pass다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("mix", "/")],
        knownUnsupported: [
          {
            kind: "console",
            pattern: "console boom",
            count: 2,
            reason: "레거시 console",
          },
          {
            kind: "page-error",
            pattern: "legacy throw",
            count: 1,
            reason: "레거시 예외",
          },
          {
            kind: "request-failed",
            pattern:
              "type=Script; path=/legacy.js; error=net::ERR_FAILED; blocked=; canceled=false",
            count: 1,
            reason: "레거시 asset",
          },
        ],
      }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    pageSocket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "error", args: [{ description: "console boom" }] },
    });
    pageSocket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "error", args: [{ description: "console boom" }] },
    });
    pageSocket.deliver({
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: { text: "legacy throw" } },
    });
    pageSocket.deliver({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "r1",
        type: "Script",
        request: { url: "https://example.test/legacy.js" },
      },
    });
    pageSocket.deliver({
      method: "Network.loadingFailed",
      params: {
        requestId: "r1",
        errorText: "net::ERR_FAILED",
        canceled: false,
      },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.status).toBe("pass");
    expect(report.pages[0]).toEqual({
      name: "mix",
      status: "pass",
      unexpectedSignals: [],
      missingKnownUnsupported: [],
    });
  });

  it("선언보다 signal이 적거나 많으면 missingKnownUnsupported/unexpectedSignals에 각각 반영된다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("home", "/")],
        knownUnsupported: [
          {
            kind: "console",
            pattern: "console boom",
            count: 3,
            reason: "레거시 console",
          },
        ],
      }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    // 선언은 3개인데 실제로는 1개만 발생 (부족) + 무관한 초과 signal 1개
    pageSocket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "error", args: [{ description: "console boom" }] },
    });
    pageSocket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "error", args: [{ description: "unexpected boom" }] },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.status).toBe("fail");
    expect(report.pages[0]).toEqual({
      name: "home",
      status: "fail",
      unexpectedSignals: [{ kind: "console", text: "unexpected boom" }],
      missingKnownUnsupported: [
        {
          kind: "console",
          pattern: "console boom",
          count: 2,
          reason: "레거시 console",
        },
      ],
    });
  });

  it("같은 signal이 다른 도착 순서로 전달돼도 두 실행의 정렬된 report는 동일하다", async () => {
    const runOnce = async (
      order: "a-then-b" | "b-then-a",
    ): Promise<unknown> => {
      const state = { ready: false };
      const fixture = smokeFixture({ pageStates: [state] });
      const promise = runSmoke(
        baseInput(fixture, { pages: [page("home", "/")] }),
      );
      await reachConnected(fixture);
      const pageSocket = await attachNextPageSocket(fixture, 1);
      await waitForFirstPollRegistered(fixture, "socket2", 10);
      const deliverA = (): void =>
        pageSocket.deliver({
          method: "Runtime.consoleAPICalled",
          params: { type: "error", args: [{ description: "a" }] },
        });
      const deliverB = (): void =>
        pageSocket.deliver({
          method: "Runtime.consoleAPICalled",
          params: { type: "error", args: [{ description: "b" }] },
        });
      if (order === "a-then-b") {
        deliverA();
        deliverB();
      } else {
        deliverB();
        deliverA();
      }
      state.ready = true;
      fixture.timers.fire(10);
      const report = await promise;
      return report.pages[0]?.unexpectedSignals;
    };

    const first = await runOnce("a-then-b");
    const second = await runOnce("b-then-a");

    expect(first).toEqual(second);
    expect(first).toEqual([
      { kind: "console", text: "a" },
      { kind: "console", text: "b" },
    ]);
  });

  it("두 페이지는 각각 독립된 attachPageSession과 신호 격리를 가지며 모두 close된다", async () => {
    const stateA = { ready: false };
    const stateB = { ready: false };
    const fixture = smokeFixture({ pageStates: [stateA, stateB] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("a", "/a"), page("b", "/b")],
      }),
    );

    await reachConnected(fixture);

    const socketA = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    socketA.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "error", args: [{ description: "leak-from-a" }] },
    });
    stateA.ready = true;
    fixture.timers.fire(10);

    const socketB = await attachNextPageSocket(fixture, 2);
    await waitForFirstPollRegistered(fixture, "socket3", 10);
    stateB.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(fixture.httpCalls).toEqual([
      `${httpBaseUrl}/json/new?about:blank`,
      `${httpBaseUrl}/json/new?about:blank`,
    ]);
    expect(report.pages).toHaveLength(2);
    expect(report.pages[0]).toEqual({
      name: "a",
      status: "fail",
      unexpectedSignals: [{ kind: "console", text: "leak-from-a" }],
      missingKnownUnsupported: [],
    });
    expect(report.pages[1]).toEqual({
      name: "b",
      status: "pass",
      unexpectedSignals: [],
      missingKnownUnsupported: [],
    });
    expect(fixture.log).toContain("socket2:send:Page.close");
    expect(fixture.log).toContain("socket3:send:Page.close");
    expect(socketA.closeCount).toBe(1);
    expect(socketB.closeCount).toBe(1);
  });

  it("report의 browserVersion은 executable.version과 같고, 한 page라도 fail이면 전체 status는 fail이다", async () => {
    const stateA = { ready: false };
    const stateB = { ready: false };
    const fixture = smokeFixture({ pageStates: [stateA, stateB] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("a", "/a"), page("b", "/b")],
      }),
    );

    await reachConnected(fixture);

    await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    stateA.ready = true;
    fixture.timers.fire(10);

    const socketB = await attachNextPageSocket(fixture, 2);
    await waitForFirstPollRegistered(fixture, "socket3", 10);
    socketB.deliver({
      method: "Runtime.exceptionThrown",
      params: { exceptionDetails: { text: "second page broke" } },
    });
    stateB.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.browserVersion).toBe(executable.version);
    expect(report.status).toBe("fail");
    expect(report.pages[0]?.status).toBe("pass");
    expect(report.pages[1]?.status).toBe("fail");
  });

  it("readyPollIntervalMs를 지정하지 않으면 defaultReadyPollIntervalMs를 사용한다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke({
      origin: "http://127.0.0.1",
      executable,
      timeoutMs: 500,
      knownUnsupported: [],
      pages: [page("home", "/")],
      runtime: fixture.runtime,
      timers: fixture.timers,
    });

    await reachConnected(fixture);
    await attachNextPageSocket(fixture, 1);
    await waitUntil(
      () => fixture.timers.pendingAt(defaultReadyPollIntervalMs) >= 1,
    );
    state.ready = true;
    fixture.timers.fire(defaultReadyPollIntervalMs);

    const report = await promise;
    expect(report.status).toBe("pass");
  });
});
