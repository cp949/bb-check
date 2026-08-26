import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp as nodeMkdtemp, rm as nodeRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectCdp,
  defaultCommandTimeoutMs,
  defaultConnectTimeoutMs,
  nodeTimers,
  type CdpConnection,
  type CdpSocketFactory,
  type TimerAdapter,
} from "./cdp.js";
import { LegacyBrowserSmokeError } from "./errors.js";
import type { ChromiumExecutable } from "./preflight.js";
import {
  closeTrackedPages,
  createRawSession,
  fetchHttpJson,
  registerBrowserSession,
  type HttpJsonAdapter,
  type RawSession,
} from "./raw-session.js";

/** 자식 프로세스 종료 결과. `error`는 spawn 자체가 실패한 경우에만 채워진다. */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly error?: unknown;
}

/** runtime이 자식 프로세스에서 실제로 사용하는 부분집합. */
export interface ChildProcessLike {
  readonly stderr: AsyncIterable<string | Uint8Array>;
  readonly exited: Promise<ProcessExit>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface ProcessSpawnAdapter {
  spawn(executablePath: string, args: readonly string[]): ChildProcessLike;
}

/** launch마다 쓰는 임시 user-data-dir 생성/삭제 adapter. */
export interface RuntimeFileSystemAdapter {
  mkdtemp(prefix: string): Promise<string>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
}

export interface BrowserRuntimeAdapters {
  readonly process: ProcessSpawnAdapter;
  readonly fs: RuntimeFileSystemAdapter;
  readonly http: HttpJsonAdapter;
  readonly createSocket: CdpSocketFactory;
  readonly timers: TimerAdapter;
  readonly userId: number | undefined;
  readonly temporaryPrefix: string;
  /** Test seam; production always uses the 5s SIGTERM grace policy. */
  readonly terminateGraceMs: number;
}

export interface SandboxOption {
  readonly mode: "required";
}

export interface SandboxDisabledOption {
  readonly mode: "disabled";
  readonly reason: string;
}

export interface BrowserRuntimeOptions {
  readonly executable: ChromiumExecutable;
  readonly signal?: AbortSignal;
  readonly sandbox?: SandboxOption | SandboxDisabledOption;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}

export type BrowserRuntimeRunner = <T>(
  options: BrowserRuntimeOptions,
  operation: (session: RawSession) => Promise<T>,
) => Promise<T>;

const defaultTerminateGraceMs = 5_000;
const devToolsMarker = "DevTools listening on ";

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

const connectTimeout = (
  message: string,
  cause?: unknown,
): LegacyBrowserSmokeError =>
  new LegacyBrowserSmokeError(
    "LBS_CONNECT_TIMEOUT",
    message,
    cause === undefined ? undefined : { cause },
  );

const emptyStderr: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => ({
    next: async (): Promise<IteratorResult<Uint8Array>> => ({
      done: true,
      value: undefined,
    }),
  }),
};

const nodeProcessSpawn: ProcessSpawnAdapter = {
  spawn: (executablePath, args) => {
    const child = nodeSpawn(executablePath, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let settleExit!: (exit: ProcessExit) => void;
    const exited = new Promise<ProcessExit>((resolve) => {
      settleExit = resolve;
    });
    child.once("exit", (code, signal) => {
      settleExit({ code, signal });
    });
    child.once("error", (error) => {
      settleExit({ code: null, signal: null, error });
    });
    return {
      stderr: child.stderr ?? emptyStderr,
      exited,
      kill: (signal) => {
        child.kill(signal);
      },
    };
  },
};

const nodeRuntimeFileSystem: RuntimeFileSystemAdapter = {
  mkdtemp: (prefix) => nodeMkdtemp(prefix),
  rm: (path, options) => nodeRm(path, options),
};

const defaultAdapters = (): BrowserRuntimeAdapters => ({
  process: nodeProcessSpawn,
  fs: nodeRuntimeFileSystem,
  http: fetchHttpJson,
  createSocket: (url) => new WebSocket(url),
  timers: nodeTimers,
  userId: typeof process.getuid === "function" ? process.getuid() : undefined,
  temporaryPrefix: join(tmpdir(), "lbs-browser-"),
  terminateGraceMs: defaultTerminateGraceMs,
});

/**
 * sandbox 설정을 검증하고 `--no-sandbox`가 필요한지 판정한다.
 * `--no-sandbox`는 명시적인 `disabled` 요청에서만 켜지며 자동으로 붙지 않는다.
 */
const resolveNoSandbox = (
  sandbox: BrowserRuntimeOptions["sandbox"],
): boolean => {
  if (sandbox === undefined || sandbox.mode === "required") return false;
  if (sandbox.mode !== "disabled") {
    throw new LegacyBrowserSmokeError(
      "LBS_CONFIG_INVALID",
      'sandbox.mode must be "required" or "disabled"',
    );
  }
  if (typeof sandbox.reason !== "string" || sandbox.reason.trim() === "") {
    throw new LegacyBrowserSmokeError(
      "LBS_CONFIG_INVALID",
      'sandbox.mode "disabled" requires a non-empty reason',
    );
  }
  return true;
};

const launchArgs = (
  userDataDir: string,
  noSandbox: boolean,
): readonly string[] => {
  const args = [
    // Chromium 75는 `--headless=new`를 모르므로 구식 `--headless`만 사용한다.
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    // 컨테이너의 작은 /dev/shm에서 렌더러가 죽는 것을 막는다.
    "--disable-dev-shm-usage",
    // 2019년 build가 외부 component/variations 서버를 찾지 않게 한다.
    "--disable-background-networking",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
  ];
  if (noSandbox) args.push("--no-sandbox");
  args.push("about:blank");
  return args;
};

const devToolsUrlFrom = (line: string): string | undefined => {
  const index = line.indexOf(devToolsMarker);
  if (index === -1) return undefined;
  const candidate = line.slice(index + devToolsMarker.length).trim();
  if (candidate === "") return undefined;
  try {
    const protocol = new URL(candidate).protocol;
    if (protocol !== "ws:" && protocol !== "wss:") return undefined;
  } catch {
    return undefined;
  }
  return candidate;
};

const httpBaseFrom = (webSocketUrl: string): string => {
  const url = new URL(webSocketUrl);
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
};

/**
 * stderr를 계속 비우면서 DevTools endpoint 줄을 찾는다. 줄이 없으면 promise는
 * 계속 대기하고, 프로세스 종료/timeout 경로가 진단을 담당한다.
 */
const watchDevToolsLine = (
  source: AsyncIterable<string | Uint8Array>,
): Promise<string> => {
  let resolveUrl!: (url: string) => void;
  const found = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  let matched = false;
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of source) {
        // 찾은 뒤에도 stderr를 계속 읽어 자식 프로세스가 막히지 않게 한다.
        if (matched) continue;
        buffer +=
          typeof chunk === "string"
            ? chunk
            : decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const url = devToolsUrlFrom(line);
          if (url !== undefined) {
            matched = true;
            resolveUrl(url);
            break;
          }
          newline = buffer.indexOf("\n");
        }
      }
    } catch {
      // stderr 읽기 실패는 exit/timeout 경로가 진단한다.
    }
  })();
  return found;
};

/** promise를 timeout과 abort로 제한하고, 어느 쪽이 끝나든 timer를 해제한다. */
const raceDeadline = <T>(
  operation: Promise<T>,
  timeoutMs: number,
  timers: TimerAdapter,
  timeoutError: () => Error,
  signal: AbortSignal | undefined,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let done = false;
    let cancelTimer = (): void => {};
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      cancelTimer();
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      settle();
    };
    function onAbort(): void {
      if (signal === undefined) return;
      finish(() => {
        reject(abortError(signal));
      });
    }
    cancelTimer = timers.schedule(() => {
      finish(() => {
        reject(timeoutError());
      });
    }, timeoutMs);
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // 이미 abort된 signal이어도 operation의 실패가 unhandled로 남지 않도록 먼저 붙인다.
    operation.then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error);
        });
      },
    );
    if (signal?.aborted === true) onAbort();
  });

/** 종료 통지 또는 grace 경과 중 먼저 오는 쪽까지 기다린다. */
const awaitExitOrGrace = (
  exited: Promise<ProcessExit>,
  graceMs: number,
  timers: TimerAdapter,
): Promise<void> =>
  new Promise<void>((resolve) => {
    let done = false;
    let cancelTimer = (): void => {};
    const finish = (): void => {
      if (done) return;
      done = true;
      cancelTimer();
      resolve();
    };
    cancelTimer = timers.schedule(finish, graceMs);
    exited.then(finish, finish);
  });

export const createBrowserRuntime = (
  overrides: Partial<BrowserRuntimeAdapters> = {},
): BrowserRuntimeRunner => {
  const adapters: BrowserRuntimeAdapters = {
    ...defaultAdapters(),
    ...overrides,
  };

  return async <T>(
    options: BrowserRuntimeOptions,
    operation: (session: RawSession) => Promise<T>,
  ): Promise<T> => {
    const signal = options.signal;
    const noSandbox = resolveNoSandbox(options.sandbox);
    if (!noSandbox && adapters.userId === 0) {
      throw new LegacyBrowserSmokeError(
        "LBS_SANDBOX_UNAVAILABLE",
        'Chromium cannot use its sandbox as root; pass sandbox { mode: "disabled", reason } to launch without it',
      );
    }
    if (signal?.aborted === true) throw abortError(signal);

    const connectTimeoutMs = positiveDuration(
      options.connectTimeoutMs,
      defaultConnectTimeoutMs,
    );
    const commandTimeoutMs = positiveDuration(
      options.commandTimeoutMs,
      defaultCommandTimeoutMs,
    );

    let userDataDir: string | undefined;
    let child: ChildProcessLike | undefined;
    let processExited = false;
    let connection: CdpConnection | undefined;
    let browserSession: RawSession | undefined;
    let cleanupPromise: Promise<void> | undefined;

    const terminateProcess = async (
      target: ChildProcessLike,
    ): Promise<void> => {
      if (processExited) return;
      target.kill("SIGTERM");
      if (processExited) return;
      await awaitExitOrGrace(
        target.exited,
        adapters.terminateGraceMs,
        adapters.timers,
      );
      if (processExited) return;
      target.kill("SIGKILL");
    };

    const runCleanup = async (): Promise<void> => {
      if (browserSession !== undefined) {
        try {
          await closeTrackedPages(browserSession);
        } catch {
          // page 정리 실패가 원래 오류를 덮지 않게 한다.
        }
      }
      if (connection !== undefined) {
        try {
          await raceDeadline(
            connection.command("Browser.close"),
            adapters.terminateGraceMs,
            adapters.timers,
            () => new Error("Browser.close did not complete in time"),
            undefined,
          );
        } catch {
          // 이미 끊긴 연결이나 거부된 Browser.close는 무시한다.
        }
        try {
          connection.close();
        } catch {
          // transport 종료는 best-effort다.
        }
      }
      if (child !== undefined) {
        try {
          await terminateProcess(child);
        } catch {
          // signal 전달 실패는 남은 정리를 막지 않는다.
        }
      }
      if (userDataDir !== undefined) {
        try {
          await adapters.fs.rm(userDataDir, { recursive: true, force: true });
        } catch {
          // 임시 디렉터리 제거는 best-effort다.
        }
      }
    };

    /** 어느 종료 경로로 들어와도 정리를 정확히 한 번 실행하고, 결코 원래 오류를 덮지 않는다. */
    const cleanup = async (): Promise<void> => {
      cleanupPromise ??= runCleanup();
      try {
        await cleanupPromise;
      } catch {
        // 정리 중 예기치 못한 실패가 primary error를 대체하지 않게 한다.
      }
    };

    try {
      userDataDir = await adapters.fs.mkdtemp(adapters.temporaryPrefix);
      child = adapters.process.spawn(
        options.executable.path,
        launchArgs(userDataDir, noSandbox),
      );
      const started = child;
      void started.exited.then(
        () => {
          processExited = true;
        },
        () => {
          processExited = true;
        },
      );

      const webSocketUrl = await raceDeadline(
        Promise.race([
          watchDevToolsLine(started.stderr),
          started.exited.then((exit): never => {
            throw connectTimeout(
              "Chromium exited before the DevTools endpoint became available",
              exit,
            );
          }),
        ]),
        connectTimeoutMs,
        adapters.timers,
        () =>
          connectTimeout(
            `Chromium did not report a DevTools endpoint within ${String(connectTimeoutMs)}ms`,
          ),
        signal,
      );

      connection = await connectCdp({
        url: webSocketUrl,
        signal,
        connectTimeoutMs,
        commandTimeoutMs,
        createSocket: adapters.createSocket,
        timers: adapters.timers,
      });
      browserSession = createRawSession(connection);
      registerBrowserSession(browserSession, {
        httpBaseUrl: httpBaseFrom(webSocketUrl),
        http: adapters.http,
        createSocket: adapters.createSocket,
        timers: adapters.timers,
        connectTimeoutMs,
        commandTimeoutMs,
        signal,
      });

      const result = await operation(browserSession);
      await cleanup();
      return result;
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
};

export const withBrowserRuntime: BrowserRuntimeRunner = createBrowserRuntime();
