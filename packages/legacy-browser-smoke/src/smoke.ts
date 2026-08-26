import {
  nodeTimers,
  startDeadline,
  type DeadlineSignal,
  type TimerAdapter,
} from "./cdp.js";
import type {
  KnownUnsupportedSignal,
  ReadyCondition,
  SmokePage,
} from "./config.js";
import { LegacyBrowserSmokeError } from "./errors.js";
import {
  isReadyResult,
  matchKnownUnsupported,
  navigateErrorText,
  readyExpression,
  validateLoopbackOrigin,
} from "./page-contract.js";
import type { ChromiumExecutable } from "./preflight.js";
import { attachPageSession, type RawSession } from "./raw-session.js";
import {
  beginPageResourceCollection,
  type PageResourceCollector,
  type PageSignal,
} from "./resources.js";
import {
  withBrowserRuntime,
  type BrowserRuntimeRunner,
  type SandboxDisabledOption,
  type SandboxOption,
} from "./runtime.js";
import { normalizeSignalText } from "./signal.js";

/**
 * `runSmoke`의 CDP orchestration 입력. `pages`/`timeoutMs`/`knownUnsupported`는
 * `defineSmokeConfig`가 이미 정규화·중복제거한 값을 그대로 받는다.
 * `origin`/`executable`은 호출자가 loopback 검증과 registry/preflight를 마친 값을,
 * `runtime`/`timers`/`readyPollIntervalMs`는 test를 위한 내부 DI seam이다.
 */
export interface RunSmokeInput {
  readonly origin: string;
  readonly executable: ChromiumExecutable;
  readonly pages: readonly SmokePage[];
  /** ready 조건 budget. 전체 실행이 아니라 page 하나마다 적용된다. */
  readonly timeoutMs: number;
  readonly knownUnsupported: readonly KnownUnsupportedSignal[];
  readonly signal?: AbortSignal;
  readonly sandbox?: SandboxOption | SandboxDisabledOption;
  readonly runtime?: BrowserRuntimeRunner;
  readonly timers?: TimerAdapter;
  readonly readyPollIntervalMs?: number;
}

export interface SmokePageResult {
  readonly name: string;
  readonly status: "pass" | "fail";
  readonly unexpectedSignals: readonly PageSignal[];
  readonly missingKnownUnsupported: readonly KnownUnsupportedSignal[];
}

export interface SmokeReport {
  readonly status: "pass" | "fail";
  readonly browserVersion: string;
  readonly pages: readonly SmokePageResult[];
}

/** ready-poll 주기의 기본값. `cdp.ts`의 `defaultConnectTimeoutMs` 등과 같은 관례다. */
export const defaultReadyPollIntervalMs = 25;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * CDP event payload는 신뢰할 수 없으므로 listener 본문에서 발생한 예외가
 * session dispatch를 중단시키지 않게 감싼다. `resources.ts`의
 * `ignoreMalformedEvent`와 동일한 관례다.
 */
const ignoreMalformedEvent =
  (listener: (params: object) => void): ((params: object) => void) =>
  (params) => {
    try {
      listener(params);
    } catch {
      // CDP event payload는 신뢰할 수 없으므로 listener 실패는 무시한다.
    }
  };

/** CDP `RemoteObject` 하나를 텍스트로 렌더링한다: description → value → type 순으로 시도한다. */
const renderRemoteObject = (arg: unknown): string => {
  if (!isRecord(arg)) return "";
  if (typeof arg.description === "string") return arg.description;
  if ("value" in arg) return String(arg.value);
  if (typeof arg.type === "string") return arg.type;
  return "";
};

const createConsoleListener =
  (consoleSignals: PageSignal[]) =>
  (params: object): void => {
    if (!isRecord(params) || params.type !== "error") return;
    const args = params.args;
    if (!Array.isArray(args)) return;
    const text = args.map(renderRemoteObject).join(" ");
    consoleSignals.push({ kind: "console", text: normalizeSignalText(text) });
  };

const createExceptionListener =
  (consoleSignals: PageSignal[]) =>
  (params: object): void => {
    if (!isRecord(params)) return;
    const details = params.exceptionDetails;
    if (!isRecord(details)) return;
    const exception = details.exception;
    const description =
      isRecord(exception) && typeof exception.description === "string"
        ? exception.description
        : typeof details.text === "string"
          ? details.text
          : undefined;
    if (description === undefined) return;
    consoleSignals.push({
      kind: "page-error",
      text: normalizeSignalText(description),
    });
  };

/**
 * ready 조건이 충족될 때까지 `Runtime.evaluate`를 poll한다. 즉시 한 번 poll하고
 * 이후 `readyPollIntervalMs`마다 poll하며, `deadline`이 만료되면
 * `LBS_PAGE_NOT_READY`로 reject한다. 두 경로 모두 예약된 timer를 남기지 않는다.
 */
const waitForReady = (
  session: RawSession,
  ready: ReadyCondition,
  deadline: DeadlineSignal,
  timeoutMs: number,
  timers: TimerAdapter,
  readyPollIntervalMs: number,
  pageName: string,
): Promise<void> => {
  const expression = readyExpression(ready);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let lastOutcome: unknown;
    let cancelPollTimer: (() => void) | undefined;
    // 이미 만료된 deadline은 onExpire가 동기 실행되어 등록(재할당) 이전에
    // finish가 호출될 수 있다. no-op으로 초기화해 그 경우에도 안전하게 호출한다.
    let cancelDeadlineListener: () => void = () => {};

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      cancelPollTimer?.();
      cancelDeadlineListener();
      settle();
    };

    const scheduleNextTick = (): void => {
      cancelPollTimer = timers.schedule(() => {
        void tick();
      }, readyPollIntervalMs);
    };

    const tick = async (): Promise<void> => {
      if (settled) return;
      let evaluated: unknown;
      let evaluateFailed = false;
      try {
        evaluated = await session.command("Runtime.evaluate", {
          expression,
          returnByValue: true,
        });
      } catch (error) {
        evaluateFailed = true;
        evaluated = error;
      }
      if (settled) return;
      lastOutcome = evaluated;
      if (!evaluateFailed && isReadyResult(evaluated)) {
        finish(resolve);
        return;
      }
      scheduleNextTick();
    };

    cancelDeadlineListener = deadline.onExpire(() => {
      finish(() => {
        reject(
          new LegacyBrowserSmokeError(
            "LBS_PAGE_NOT_READY",
            `page "${pageName}" did not become ready within ${String(timeoutMs)}ms`,
            { cause: lastOutcome },
          ),
        );
      });
    });

    void tick();
  });
};

/** page 하나의 attach → navigate → ready-poll → signal 수집 → 판정 → cleanup 전체 흐름. */
const runPage = async (
  browserSession: RawSession,
  page: SmokePage,
  canonicalOrigin: string,
  timeoutMs: number,
  timers: TimerAdapter,
  readyPollIntervalMs: number,
  knownUnsupported: readonly KnownUnsupportedSignal[],
): Promise<SmokePageResult> => {
  const deadline = startDeadline(timers, timeoutMs);
  const pageHandle = await attachPageSession(browserSession);
  let resourceCollector: PageResourceCollector | undefined;
  const consoleSignals: PageSignal[] = [];
  let unsubscribeConsole: (() => void) | undefined;
  let unsubscribeException: (() => void) | undefined;
  try {
    resourceCollector = await beginPageResourceCollection(pageHandle.session);
    await pageHandle.session.command("Runtime.enable");
    unsubscribeConsole = pageHandle.session.on(
      "Runtime.consoleAPICalled",
      ignoreMalformedEvent(createConsoleListener(consoleSignals)),
    );
    unsubscribeException = pageHandle.session.on(
      "Runtime.exceptionThrown",
      ignoreMalformedEvent(createExceptionListener(consoleSignals)),
    );

    const url = `${canonicalOrigin}${page.path}`;
    const navigated = await pageHandle.session.command("Page.navigate", {
      url,
    });
    // CDP는 navigation 실패(net::ERR_CONNECTION_REFUSED 등)를 protocol error가
    // 아니라 결과의 errorText로 알린다. 이 경우 대상 문서는 존재하지 않으므로
    // ready-poll을 시작하지 않고 곧바로 실패로 끝낸다.
    const navigateFailure = navigateErrorText(navigated);
    if (navigateFailure !== undefined) {
      throw new LegacyBrowserSmokeError(
        "LBS_PAGE_NOT_READY",
        `page "${page.name}" navigation to ${url} failed: ${navigateFailure}`,
        { cause: navigateFailure },
      );
    }

    await waitForReady(
      pageHandle.session,
      page.ready,
      deadline,
      timeoutMs,
      timers,
      readyPollIntervalMs,
      page.name,
    );

    // ready 성공과 unsubscribe 사이에는 어떤 await도 두지 않는다 — 이 동기성이
    // consoleSignals를 그 뒤에 읽어도 race-free임을 보장한다.
    unsubscribeConsole();
    unsubscribeException();
    const resources = await resourceCollector.finish();

    const allSignals = [...consoleSignals, ...resources.failedRequests];
    const { unexpectedSignals, missingKnownUnsupported } =
      matchKnownUnsupported(allSignals, knownUnsupported);
    const status: "pass" | "fail" =
      unexpectedSignals.length === 0 && missingKnownUnsupported.length === 0
        ? "pass"
        : "fail";
    return {
      name: page.name,
      status,
      unexpectedSignals,
      missingKnownUnsupported,
    };
  } finally {
    deadline.cancel();
    resourceCollector?.dispose();
    unsubscribeConsole?.();
    unsubscribeException?.();
    await pageHandle.close();
  }
};

/**
 * `pages`를 순서대로, 한 번에 하나씩 방문해 각 page의 ready 조건과 신호를
 * 판정하고 `SmokeReport`를 만든다. page 사이에는 매번 새 target/session을 써서
 * console/network 상태가 새지 않게 한다.
 */
export const runSmoke = async (input: RunSmokeInput): Promise<SmokeReport> => {
  const canonicalOrigin = validateLoopbackOrigin(input.origin);
  const runtime = input.runtime ?? withBrowserRuntime;
  const timers = input.timers ?? nodeTimers;
  const readyPollIntervalMs =
    input.readyPollIntervalMs ?? defaultReadyPollIntervalMs;

  return runtime(
    {
      executable: input.executable,
      // BrowserRuntimeOptions.signal/sandbox는 `exactOptionalPropertyTypes`
      // 아래 명시적 `undefined` 값을 허용하지 않으므로, 값이 있을 때만 key를 둔다.
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
    },
    async (browserSession) => {
      const pages: SmokePageResult[] = [];
      for (const page of input.pages) {
        const result = await runPage(
          browserSession,
          page,
          canonicalOrigin,
          input.timeoutMs,
          timers,
          readyPollIntervalMs,
          input.knownUnsupported,
        );
        pages.push(result);
      }
      const status: "pass" | "fail" = pages.every(
        (result) => result.status === "pass",
      )
        ? "pass"
        : "fail";
      return {
        status,
        browserVersion: input.executable.version,
        pages,
      };
    },
  );
};
