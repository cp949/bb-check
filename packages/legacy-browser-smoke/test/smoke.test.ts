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

/**
 * 실제 문서처럼 ready 식을 평가하는 responder. `location.href`는 `state.href`가,
 * `document.readyState`는 항상 `"complete"`가 된다 — navigate가 아직 커밋되지
 * 않은 about:blank에서도 참이 되는 ready 조건(readyState 확인 등)을 흉내낸다.
 * CDP `Runtime.evaluate`처럼 소스를 program으로 실행하고 completion value를
 * 돌려주도록 직접 `eval`을 쓴다.
 */
const createEvaluatingPageResponder =
  (state: { href: string }): Responder =>
  (message) => {
    if (message.method !== "Runtime.evaluate") return undefined;
    const params = message.params as
      { readonly expression?: string } | undefined;
    const expression = params?.expression ?? "";
    if (expression.includes("querySelectorAll")) {
      return {
        kind: "result",
        value: {
          result: { type: "object", value: defaultSnapshotValue },
        },
      };
    }
    const evaluate = Function(
      "location",
      "document",
      "expression",
      "return eval(expression);",
    ) as (
      location: { readonly href: string },
      document: { readonly readyState: string },
      expression: string,
    ) => unknown;
    return {
      kind: "result",
      value: {
        result: {
          type: "boolean",
          value: Boolean(
            evaluate(
              { href: state.href },
              { readyState: "complete" },
              expression,
            ),
          ),
        },
      },
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
  /** page socket별 responder를 직접 지정한다. 지정한 index는 pageStates를 쓰지 않는다. */
  readonly pageResponders?: readonly Responder[];
  /**
   * `http.getJson` 호출 순서(1-based, page attach 순서와 같다)별로 지정한
   * 메시지의 Error로 거부시킨다. attachPageSession 실패를 흉내내는 용도.
   */
  readonly httpJsonFailures?: readonly (string | undefined)[];
}

const smokeFixture = (options: SmokeFixtureOptions = {}) => {
  const log: string[] = [];
  const sockets: ScriptedSocket[] = [];
  const children: FakeChildProcess[] = [];
  const httpCalls: string[] = [];
  const timers = new FakeTimers();
  const pageStates = options.pageStates ?? [];
  const pageSnapshots = options.pageSnapshots ?? [];
  const pageResponders = options.pageResponders ?? [];
  const httpJsonFailures = options.httpJsonFailures ?? [];

  const createSocket: CdpSocketFactory = (url) => {
    const index = sockets.length;
    const socket = new ScriptedSocket(url, log, `socket${String(index + 1)}`);
    if (index === 0) {
      socket.responder = ackEverything;
    } else {
      const responder = pageResponders[index - 1];
      if (responder !== undefined) {
        socket.responder = responder;
      } else {
        const state = pageStates[index - 1];
        if (state === undefined) {
          throw new Error(
            `smokeFixture: no pageStates entry for page socket ${String(index)}`,
          );
        }
        socket.responder = createPageResponder(state, pageSnapshots[index - 1]);
      }
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
        const failureMessage = httpJsonFailures[index - 1];
        if (failureMessage !== undefined) {
          throw new Error(failureMessage);
        }
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

  it("navigate가 커밋되기 전 about:blank에서 참이 되는 ready 조건은 ready로 판정하지 않는다", async () => {
    // attachPageSession은 항상 about:blank target을 만들고, Page.navigate는
    // navigation의 "시작"만 알린다. 그 사이에 평가되는 ready 조건은 아직
    // 대상 문서를 본 적이 없으므로 참이어도 ready여선 안 된다.
    const location = { href: "about:blank" };
    const fixture = smokeFixture({
      pageResponders: [createEvaluatingPageResponder(location)],
    });

    let outcome: "pending" | "settled" = "pending";
    const promise = runSmoke(
      baseInput(fixture, {
        pages: [
          page("home", "/", {
            kind: "expression",
            expression: 'document.readyState === "complete"',
          }),
        ],
      }),
    ).then(
      (report) => {
        outcome = "settled";
        return report;
      },
      (error: unknown) => {
        outcome = "settled";
        throw error;
      },
    );

    await reachConnected(fixture);
    await attachNextPageSocket(fixture, 1);
    await waitUntil(() => fixture.log.includes("socket2:send:Page.navigate"));

    // about:blank에 머무는 동안에는 몇 번을 poll해도 page가 완료되지 않는다.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await waitUntil(
        () => fixture.timers.pendingAt(10) >= 1 || outcome === "settled",
      );
      expect(outcome).toBe("pending");
      expect(fixture.timers.fire(10)).toBe(1);
    }

    // navigate가 커밋되어 실제 문서 URL이 된 뒤에야 ready로 판정된다.
    await waitUntil(() => fixture.timers.pendingAt(10) >= 1);
    location.href = "http://127.0.0.1/";
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.status).toBe("pass");
    expect(report.pages[0]?.status).toBe("pass");
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("Page.navigate가 errorText를 돌려주면 ready-poll을 시작하지 않고 즉시 실패한다", async () => {
    const fixture = smokeFixture({
      pageResponders: [
        (message) => {
          if (message.method === "Page.navigate") {
            return {
              kind: "result",
              value: {
                frameId: "FRAME1",
                loaderId: "LOADER1",
                errorText: "net::ERR_CONNECTION_REFUSED",
              },
            };
          }
          // navigate 실패를 무시하고 poll이 시작되면 곧바로 ready가 되는 상황을
          // 만들어, 실패가 조용한 pass로 바뀌지 않는지 본다.
          if (message.method !== "Runtime.evaluate") return undefined;
          return {
            kind: "result",
            value: { result: { type: "boolean", value: true } },
          };
        },
      ],
    });

    const promise = runSmoke(
      baseInput(fixture, { pages: [page("home", "/")] }),
    );

    await reachConnected(fixture);
    await attachNextPageSocket(fixture, 1);

    const error = await reasonOf(promise);

    expect(error).toBeInstanceOf(LegacyBrowserSmokeError);
    expect((error as LegacyBrowserSmokeError).code).toBe("LBS_PAGE_NOT_READY");
    expect((error as LegacyBrowserSmokeError).message).toContain(
      "net::ERR_CONNECTION_REFUSED",
    );
    expect((error as LegacyBrowserSmokeError).cause).toBe(
      "net::ERR_CONNECTION_REFUSED",
    );
    expect(fixture.log).not.toContain("socket2:send:Runtime.evaluate");
    expect(fixture.log).toContain("socket2:send:Page.close");
    expect(fixture.timers.pendingCount).toBe(0);
  });

  it("page attach가 http.getJson 실패로 거부되면 runSmoke도 거부되고 deadline timer가 남지 않는다", async () => {
    const fixture = smokeFixture({
      httpJsonFailures: ["devtools endpoint unavailable"],
    });

    const promise = runSmoke(
      baseInput(fixture, { pages: [page("home", "/")] }),
    );

    await reachConnected(fixture);

    const error = await reasonOf(promise);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("devtools endpoint unavailable");
    expect(fixture.timers.pendingCount).toBe(0);
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

  it("Debugger.scriptFailedToParse는 script-parse 신호가 되어 페이지를 fail시킨다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, { pages: [page("home", "/")] }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);

    pageSocket.deliver({
      method: "Debugger.scriptFailedToParse",
      params: {
        url: "http://127.0.0.1/_next/static/chunks/a.js",
        startLine: 0,
        startColumn: 0,
      },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(fixture.log).toContain("socket2:send:Debugger.enable");
    expect(report.pages[0]).toEqual({
      name: "home",
      status: "fail",
      unexpectedSignals: [
        {
          kind: "script-parse",
          text: "path=/_next/static/chunks/a.js; line=0; column=0",
        },
      ],
      missingKnownUnsupported: [],
    });
  });

  it("script-parse 신호는 위치 기반 known-unsupported 선언으로 흡수된다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [page("home", "/")],
        knownUnsupported: [
          {
            kind: "script-parse",
            sourcePath: "/_next/static/chunks/a.js",
            lineNumber: 0,
            columnNumber: 0,
            count: 1,
            reason: "Chrome 75의 chunk 문법 미지원",
          },
        ],
      }),
    );

    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);
    pageSocket.deliver({
      method: "Debugger.scriptFailedToParse",
      params: {
        url: "http://127.0.0.1/_next/static/chunks/a.js",
        startLine: 0,
        startColumn: 0,
      },
    });
    state.ready = true;
    fixture.timers.fire(10);

    const report = await promise;

    expect(report.status).toBe("pass");
  });

  it("injectBeforeNavigate는 Page.navigate 전에 addScriptToEvaluateOnNewDocument로 등록된다", async () => {
    const state = { ready: true };
    const fixture = smokeFixture({ pageStates: [state] });

    const report = await (async () => {
      const promise = runSmoke(
        baseInput(fixture, {
          pages: [page("home", "/")],
          injectBeforeNavigate: "localStorage.setItem('k','v')",
        }),
      );
      await reachConnected(fixture);
      await attachNextPageSocket(fixture, 1);
      return promise;
    })();

    const sendLog = fixture.log.filter((line) =>
      line.startsWith("socket2:send:"),
    );
    const injectIndex = sendLog.indexOf(
      "socket2:send:Page.addScriptToEvaluateOnNewDocument",
    );
    const navigateIndex = sendLog.indexOf("socket2:send:Page.navigate");
    expect(injectIndex).toBeGreaterThanOrEqual(0);
    expect(injectIndex).toBeLessThan(navigateIndex);

    const injectFrame = fixture.sockets[1]?.sent
      .map((frame) => JSON.parse(frame) as { method: string; params?: object })
      .find(
        (frame) => frame.method === "Page.addScriptToEvaluateOnNewDocument",
      );
    expect(injectFrame?.params).toEqual({
      source: "localStorage.setItem('k','v')",
    });
    expect(report.status).toBe("pass");
  });

  it("injectBeforeNavigate가 없으면 addScriptToEvaluateOnNewDocument를 호출하지 않는다", async () => {
    const state = { ready: true };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, { pages: [page("home", "/")] }),
    );
    await reachConnected(fixture);
    await attachNextPageSocket(fixture, 1);
    await promise;

    expect(fixture.log).not.toContain(
      "socket2:send:Page.addScriptToEvaluateOnNewDocument",
    );
  });

  it("ready 후 미완료 Script는 deadline까지 기다렸다가 script-pending 신호로 fail시킨다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, { pages: [page("home", "/")] }),
    );
    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);

    pageSocket.deliver({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "s1",
        type: "Script",
        request: { url: "http://127.0.0.1/slow.js" },
      },
    });
    state.ready = true;
    fixture.timers.fire(10);
    // fire(10)은 tick()을 시작만 시킬 뿐, ready 판정(Runtime.evaluate 왕복)은 여러
    // microtask를 거쳐 비동기로 끝난다. 공유 deadline(500ms) timer는 attach 시점부터
    // 이미 pendingAt(500)>=1이므로, 이 microtask 왕복을 먼저 모두 흘려보내지 않으면
    // ready 판정이 끝나기 전에 500ms를 발화시켜 waitForReady의 (아직 등록된)
    // deadline listener를 잘못 건드리는 race가 생긴다.
    await new Promise((resolve) => setImmediate(resolve));
    // ready는 통과했지만 Script가 미완료라 settle 대기 중 — deadline(500ms)을 만료시킨다.
    await waitUntil(() => fixture.timers.pendingAt(500) >= 1);
    fixture.timers.fire(500);

    const report = await promise;

    expect(report.pages[0]).toEqual({
      name: "home",
      status: "fail",
      unexpectedSignals: [{ kind: "script-pending", text: "path=/slow.js" }],
      missingKnownUnsupported: [],
    });
  });

  it("ready 후 Script가 완료되면 deadline 만료 없이 pass한다", async () => {
    const state = { ready: false };
    const fixture = smokeFixture({ pageStates: [state] });

    const promise = runSmoke(
      baseInput(fixture, { pages: [page("home", "/")] }),
    );
    await reachConnected(fixture);
    const pageSocket = await attachNextPageSocket(fixture, 1);
    await waitForFirstPollRegistered(fixture, "socket2", 10);

    pageSocket.deliver({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "s1",
        type: "Script",
        request: { url: "http://127.0.0.1/app.js" },
      },
    });
    state.ready = true;
    fixture.timers.fire(10);
    pageSocket.deliver({
      method: "Network.loadingFinished",
      params: { requestId: "s1" },
    });

    const report = await promise;

    expect(report.status).toBe("pass");
  });

  it("expectedPath가 최종 경로와 다르면 path-mismatch 신호로 fail시킨다", async () => {
    const state = { ready: true };
    const history = {
      currentIndex: 1,
      entries: [
        { url: "http://127.0.0.1/mypage" },
        { url: "http://127.0.0.1/login" },
      ],
    };
    const responder: Responder = (message) => {
      if (message.method === "Page.getNavigationHistory") {
        return { kind: "result", value: history };
      }
      return createPageResponder(state)(message);
    };
    const fixture = smokeFixture({ pageResponders: [responder] });

    const promise = runSmoke(
      baseInput(fixture, {
        pages: [
          {
            name: "my-info",
            path: "/mypage",
            expectedPath: "/mypage",
            ready: { kind: "selector", selector: "#app" },
          },
        ],
      }),
    );
    await reachConnected(fixture);
    await attachNextPageSocket(fixture, 1);

    const report = await promise;

    expect(report.pages[0]).toEqual({
      name: "my-info",
      status: "fail",
      unexpectedSignals: [
        { kind: "path-mismatch", text: "expected=/mypage; final=/login" },
      ],
      missingKnownUnsupported: [],
    });
  });

  it("expectedPath가 일치하면 pass하고, 선언이 없으면 getNavigationHistory를 호출하지 않는다", async () => {
    const state = { ready: true };
    const history = {
      currentIndex: 0,
      entries: [{ url: "http://127.0.0.1/mypage" }],
    };
    const responder: Responder = (message) => {
      if (message.method === "Page.getNavigationHistory") {
        return { kind: "result", value: history };
      }
      return createPageResponder(state)(message);
    };
    const secondState = { ready: true };
    const fixture = smokeFixture({
      pageResponders: [responder, createPageResponder(secondState)],
    });

    const report = await (async () => {
      const promise = runSmoke(
        baseInput(fixture, {
          pages: [
            {
              name: "my-info",
              path: "/mypage",
              expectedPath: "/mypage",
              ready: { kind: "selector", selector: "#app" },
            },
            page("home", "/"),
          ],
        }),
      );
      await reachConnected(fixture);
      await attachNextPageSocket(fixture, 1);
      await attachNextPageSocket(fixture, 2);
      return promise;
    })();

    expect(report.status).toBe("pass");
    expect(fixture.log).toContain("socket2:send:Page.getNavigationHistory");
    expect(fixture.log).not.toContain("socket3:send:Page.getNavigationHistory");
  });
});
