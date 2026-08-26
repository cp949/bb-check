import { createServer, type Server } from "node:http";
import { ensureChromium } from "./chromium.js";
import {
  defineSmokeConfig,
  type LegacyBrowserSmokeConfig,
  type ReadyCondition,
  type SmokePage,
} from "./config.js";
import { LegacyBrowserSmokeError } from "./errors.js";
import { validateLoopbackOrigin } from "./page-contract.js";
import type { ChromiumExecutable, EnsureChromiumOptions } from "./preflight.js";
import type { SandboxDisabledOption, SandboxOption } from "./runtime.js";
import {
  runSmoke,
  type RunSmokeInput,
  type SmokePageResult,
  type SmokeReport,
} from "./smoke.js";

/**
 * package의 공개 facade. `run`은 소비자가 설정한 page 계약을 자신의 loopback
 * origin에 대해 실행하고, `selfTest`는 package 자신이 소유한 임시 page 두 개로
 * 고정된 Chromium이 실제로 레거시 엔진처럼 동작하는지 검증한다.
 */
export interface LegacyBrowserSmoke {
  run(options: {
    readonly origin: string;
    readonly executablePath?: string;
    readonly sandbox?: SandboxOption | SandboxDisabledOption;
    readonly injectBeforeNavigate?: string;
  }): Promise<SmokeReport>;
  selfTest(options?: {
    readonly executablePath?: string;
    readonly sandbox?: SandboxOption | SandboxDisabledOption;
  }): Promise<SelfTestReport>;
}

/** self-test의 check 단위 판정 결과. page 이름과 1:1로 대응한다. */
export interface SelfTestReport {
  readonly status: "pass" | "fail";
  readonly browserVersion: string;
  readonly checks: readonly {
    readonly name: string;
    readonly status: "pass" | "fail";
  }[];
}

/** facade가 의존하는 두 경계. test에서만 부분 교체한다. */
interface LegacyBrowserSmokeAdapters {
  readonly ensureChromium: (
    options?: EnsureChromiumOptions,
  ) => Promise<ChromiumExecutable>;
  readonly runSmoke: (input: RunSmokeInput) => Promise<SmokeReport>;
}

const baselineCheckName = "baseline";
const legacySyntaxCheckName = "legacy-syntax";

/**
 * self-test page 하나당 ready budget. 두 page 모두 로컬 loopback에서 오는
 * 정적 문서이므로 소비자 config의 `timeoutMs`와 무관한 고정값을 쓴다.
 * `cdp.ts`의 `defaultConnectTimeoutMs`와 같은 크기다.
 */
const selfTestTimeoutMs = 10_000;

/** 두 self-test page가 공유하는 ready 조건. */
const selfTestReady = Object.freeze<ReadyCondition>({
  kind: "expression",
  expression: "window.__legacyBrowserSmokeSelfTestReady === true",
});

const selfTestPages: readonly SmokePage[] = Object.freeze([
  Object.freeze<SmokePage>({
    name: baselineCheckName,
    path: "/baseline",
    ready: selfTestReady,
  }),
  Object.freeze<SmokePage>({
    name: legacySyntaxCheckName,
    path: "/legacy-syntax",
    ready: selfTestReady,
  }),
]);

/** ES5 범위 안의 정상 page. 고정된 Chromium이 깨끗하게 로드되는지만 본다. */
const baselineDocument = `<!doctype html>
<script>
window.__legacyBrowserSmokeSelfTestReady = true;
</script>
`;

/**
 * 고정된 Chromium 75가 실제로 최신 구문을 거부하는지 확인하는 page.
 * 첫 script의 optional chaining(`?.`)은 V8 7.5에서 parse 자체가 실패하므로
 * uncaught `SyntaxError`가 되고, `Runtime.exceptionThrown`으로 수집된다.
 * ready marker는 별개의 두 번째 script에 두어 parse 실패가 ready 조건을
 * 막지 않게 한다 — 그래야 `runSmoke`가 `LBS_PAGE_NOT_READY`로 throw하지 않고
 * page 판정이 담긴 `SmokeReport`를 돌려준다.
 */
const legacySyntaxDocument = `<!doctype html>
<script>
({})?.a;
</script>
<script>
window.__legacyBrowserSmokeSelfTestReady = true;
</script>
`;

const selfTestDocuments = new Map<string, string>([
  ["/baseline", baselineDocument],
  ["/legacy-syntax", legacySyntaxDocument],
]);

interface SelfTestServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * 열린 connection까지 함께 끊어 close가 keep-alive에 걸려 지연되지 않게 한다.
 * self-test는 browser를 이미 종료한 뒤에만 이 함수를 호출한다.
 */
const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });

/**
 * self-test 전용 문서 두 개만 서비스하는 loopback HTTP server를 띄운다.
 * 포트는 OS가 배정하고, 등록되지 않은 경로는 fail-closed로 404를 돌려준다.
 */
const startSelfTestServer = async (): Promise<SelfTestServer> => {
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    const document = selfTestDocuments.get(path);
    if (document === undefined) {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(document);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new TypeError("self-test HTTP server did not bind a TCP port");
  }

  return {
    port: address.port,
    close: () => closeServer(server),
  };
};

const findPage = (
  smokeReport: SmokeReport,
  name: string,
): SmokePageResult | undefined =>
  smokeReport.pages.find((page) => page.name === name);

/**
 * `SmokeReport`를 self-test 판정으로 옮긴다. page는 배열 순서가 아니라 이름으로
 * 찾는다. `legacy-syntax`는 "실패해야 정상"이라 판정 방향이 반대다: page가
 * `fail`이고 그 원인에 `page-error` 신호가 있어야 구문이 실제로 거부된 것이다.
 * V8의 정확한 SyntaxError 문구는 engine version마다 달라지므로 kind만 본다.
 */
const toSelfTestReport = (smokeReport: SmokeReport): SelfTestReport => {
  const baselinePage = findPage(smokeReport, baselineCheckName);
  const legacySyntaxPage = findPage(smokeReport, legacySyntaxCheckName);

  const baselineStatus: "pass" | "fail" =
    baselinePage?.status === "pass" ? "pass" : "fail";
  const legacySyntaxStatus: "pass" | "fail" =
    legacySyntaxPage?.status === "fail" &&
    legacySyntaxPage.unexpectedSignals.some(
      (signal) => signal.kind === "page-error",
    )
      ? "pass"
      : "fail";

  const checks: SelfTestReport["checks"] = Object.freeze([
    Object.freeze({ name: baselineCheckName, status: baselineStatus }),
    Object.freeze({ name: legacySyntaxCheckName, status: legacySyntaxStatus }),
  ]);
  const status: "pass" | "fail" = checks.every(
    (check) => check.status === "pass",
  )
    ? "pass"
    : "fail";

  return Object.freeze({
    status,
    browserVersion: smokeReport.browserVersion,
    checks,
  });
};

/**
 * facade의 DI seam. `overrides`는 test 전용이며, package root로 나가지 않는다.
 * config는 여기서 한 번만 `defineSmokeConfig`로 검증·정규화하고, 이후 모든
 * `run` 호출이 그 결과를 공유한다.
 */
export const createLegacyBrowserSmokeWithAdapters = (
  input: LegacyBrowserSmokeConfig,
  overrides: Partial<LegacyBrowserSmokeAdapters> = {},
): LegacyBrowserSmoke => {
  const adapters: LegacyBrowserSmokeAdapters = {
    ensureChromium,
    runSmoke,
    ...overrides,
  };
  const normalizedConfig = defineSmokeConfig(input);

  /**
   * run 전용 옵션 검증. config와 동일하게 LBS_CONFIG_INVALID로 거절한다.
   */
  const validateInjectBeforeNavigate = (value: string | undefined): void => {
    if (value === undefined) return;
    if (typeof value !== "string" || value.trim() === "") {
      throw new LegacyBrowserSmokeError(
        "LBS_CONFIG_INVALID",
        "injectBeforeNavigate must be a non-empty string",
      );
    }
  };

  /**
   * `EnsureChromiumOptions.executablePath`는 `exactOptionalPropertyTypes` 아래
   * 명시적 `undefined`를 허용하지 않으므로, 값이 있을 때만 key를 만든다.
   */
  const resolveExecutable = (
    executablePath: string | undefined,
  ): Promise<ChromiumExecutable> =>
    adapters.ensureChromium(
      executablePath === undefined ? {} : { executablePath },
    );

  return Object.freeze({
    run: async (options: {
      readonly origin: string;
      readonly executablePath?: string;
      readonly sandbox?: SandboxOption | SandboxDisabledOption;
      readonly injectBeforeNavigate?: string;
    }): Promise<SmokeReport> => {
      // origin은 Chromium을 확보하기 전에 검증한다. 오타 하나로 110MB
      // provisioning을 끝낸 뒤에야 LBS_ORIGIN_NOT_LOOPBACK을 만나면 안 된다.
      // runSmoke가 같은 검증을 다시 하고 정규화까지 하므로(멱등) 여기서는
      // 검증만 하고 원래 origin을 그대로 넘긴다.
      validateLoopbackOrigin(options.origin);
      validateInjectBeforeNavigate(options.injectBeforeNavigate);
      const executable = await resolveExecutable(options.executablePath);
      return adapters.runSmoke({
        origin: options.origin,
        executable,
        pages: normalizedConfig.pages,
        timeoutMs: normalizedConfig.timeoutMs,
        knownUnsupported: normalizedConfig.knownUnsupported ?? [],
        // RunSmokeInput.sandbox는 `exactOptionalPropertyTypes` 아래 명시적
        // undefined를 허용하지 않으므로, 값이 있을 때만 key를 만든다.
        ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
        // RunSmokeInput.injectBeforeNavigate는 `exactOptionalPropertyTypes` 아래
        // 명시적 undefined를 허용하지 않으므로, 값이 있을 때만 key를 만든다.
        ...(options.injectBeforeNavigate === undefined
          ? {}
          : { injectBeforeNavigate: options.injectBeforeNavigate }),
      });
    },
    selfTest: async (
      options: {
        readonly executablePath?: string;
        readonly sandbox?: SandboxOption | SandboxDisabledOption;
      } = {},
    ): Promise<SelfTestReport> => {
      const executable = await resolveExecutable(options.executablePath);
      // server는 executable 확보 이후에만 만든다 — 그래야 provisioning 실패
      // 경로에서 닫아야 할 server 자체가 존재하지 않는다.
      const server = await startSelfTestServer();
      try {
        const smokeReport = await adapters.runSmoke({
          origin: `http://127.0.0.1:${String(server.port)}`,
          executable,
          pages: selfTestPages,
          timeoutMs: selfTestTimeoutMs,
          // 소비자 config의 knownUnsupported를 쓰지 않는다. self-test가 유도한
          // parse 실패가 known 목록에 흡수되면 판정이 무의미해진다.
          knownUnsupported: [],
          ...(options.sandbox === undefined
            ? {}
            : { sandbox: options.sandbox }),
        });
        return toSelfTestReport(smokeReport);
      } finally {
        await server.close();
      }
    },
  });
};

/**
 * 소비자용 진입점. 검증된 config 하나로 `run`과 `selfTest`를 함께 제공한다.
 * config가 유효하지 않으면 이 시점에 `LBS_CONFIG_INVALID`로 실패한다.
 */
export const createLegacyBrowserSmoke = (
  input: LegacyBrowserSmokeConfig,
): LegacyBrowserSmoke => createLegacyBrowserSmokeWithAdapters(input);
