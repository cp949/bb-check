import { get as httpGet } from "node:http";
import { connect as netConnect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  defineSmokeConfig,
  type LegacyBrowserSmokeConfig,
} from "../src/config.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";
import type { ChromiumExecutable } from "../src/preflight.js";
import {
  createLegacyBrowserSmoke,
  createLegacyBrowserSmokeWithAdapters,
} from "../src/self-test.js";
import type { RunSmokeInput, SmokeReport } from "../src/smoke.js";

const executable: ChromiumExecutable = Object.freeze({
  path: "/managed/chrome",
  revision: "650583",
  version: "Chromium 75.0.3765.0",
});

const consumerConfig: LegacyBrowserSmokeConfig = {
  pages: [
    { name: "home", path: "/", ready: { kind: "selector", selector: "main" } },
  ],
  timeoutMs: 5_000,
  knownUnsupported: [
    { kind: "console", pattern: "legacy warning", count: 1, reason: "known" },
  ],
};

const consumerReport: SmokeReport = Object.freeze({
  status: "pass",
  browserVersion: "Chromium 75.0.3765.0",
  pages: Object.freeze([]),
});

/** self-test가 서비스해야 하는 baseline 문서 원문. */
const baselineDocument = `<!doctype html>
<script>
window.__legacyBrowserSmokeSelfTestReady = true;
</script>
`;

/** self-test가 서비스해야 하는 legacy-syntax 문서 원문. script 태그가 둘로 분리돼 있다. */
const legacySyntaxDocument = `<!doctype html>
<script>
({})?.a;
</script>
<script>
window.__legacyBrowserSmokeSelfTestReady = true;
</script>
`;

const selfTestReady = {
  kind: "expression",
  expression: "window.__legacyBrowserSmokeSelfTestReady === true",
};

interface HttpProbe {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: string;
}

/**
 * keep-alive 없이 한 번만 요청한다. connection이 남아 있으면 server.close()가
 * 지연되므로 test용 요청은 항상 `agent: false`로 보낸다.
 */
const probe = (url: string): Promise<HttpProbe> =>
  new Promise((resolve, reject) => {
    const request = httpGet(url, { agent: false }, (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Uint8Array) => {
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          contentType: response.headers["content-type"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("error", reject);
  });

/** 해당 포트에 더 이상 listener가 없으면 true. */
const refusesConnections = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = netConnect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(true);
    });
  });

const portOf = (origin: string): number => {
  const port = Number.parseInt(new URL(origin).port, 10);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new TypeError(`origin has no usable port: ${origin}`);
  }
  return port;
};

/** self-test용 SmokeReport를 손으로 조립한다. */
const selfTestSmokeReport = (
  baseline: Pick<SmokeReport["pages"][number], "status" | "unexpectedSignals">,
  legacySyntax: Pick<
    SmokeReport["pages"][number],
    "status" | "unexpectedSignals"
  >,
  browserVersion = "Chromium 75.0.3765.0",
): SmokeReport => ({
  status:
    baseline.status === "pass" && legacySyntax.status === "pass"
      ? "pass"
      : "fail",
  browserVersion,
  pages: [
    {
      name: "baseline",
      status: baseline.status,
      unexpectedSignals: baseline.unexpectedSignals,
      missingKnownUnsupported: [],
    },
    {
      name: "legacy-syntax",
      status: legacySyntax.status,
      unexpectedSignals: legacySyntax.unexpectedSignals,
      missingKnownUnsupported: [],
    },
  ],
});

describe("createLegacyBrowserSmoke().run", () => {
  it("executablePath가 없으면 ensureChromium을 빈 options로 호출한다", async () => {
    const ensureChromium = vi.fn(async () => executable);
    const runSmoke = vi.fn(async () => consumerReport);
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium,
      runSmoke,
    });

    await smoke.run({ origin: "http://127.0.0.1:3000" });

    expect(ensureChromium.mock.calls).toStrictEqual([[{}]]);
  });

  it("executablePath가 있으면 ensureChromium에 executablePath만 전달한다", async () => {
    const ensureChromium = vi.fn(async () => executable);
    const runSmoke = vi.fn(async () => consumerReport);
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium,
      runSmoke,
    });

    await smoke.run({
      origin: "http://127.0.0.1:3000",
      executablePath: "/opt/chrome",
    });

    expect(ensureChromium.mock.calls).toStrictEqual([
      [{ executablePath: "/opt/chrome" }],
    ]);
  });

  it("정규화된 config로 runSmoke를 호출하고 SmokeReport를 그대로 돌려준다", async () => {
    const normalized = defineSmokeConfig(consumerConfig);
    const inputs: RunSmokeInput[] = [];
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        inputs.push(input);
        return consumerReport;
      },
    });

    const report = await smoke.run({ origin: "http://localhost:3000" });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toStrictEqual({
      origin: "http://localhost:3000",
      executable,
      pages: normalized.pages,
      timeoutMs: normalized.timeoutMs,
      knownUnsupported: normalized.knownUnsupported,
    });
    expect(report).toBe(consumerReport);
  });

  it("ensureChromium이 실패하면 runSmoke를 호출하지 않고 오류를 전파한다", async () => {
    const failure = new LegacyBrowserSmokeError(
      "LBS_BROWSER_EXECUTABLE_INVALID",
      "Chromium executable is invalid",
    );
    const runSmoke = vi.fn(async () => consumerReport);
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => {
        throw failure;
      },
      runSmoke,
    });

    await expect(smoke.run({ origin: "http://127.0.0.1:3000" })).rejects.toBe(
      failure,
    );
    expect(runSmoke).not.toHaveBeenCalled();
  });

  it("runSmoke 오류를 감싸지 않고 그대로 전파한다", async () => {
    const failure = new LegacyBrowserSmokeError(
      "LBS_ORIGIN_NOT_LOOPBACK",
      "origin must be loopback",
    );
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async () => {
        throw failure;
      },
    });

    await expect(smoke.run({ origin: "http://example.com" })).rejects.toBe(
      failure,
    );
  });

  it("sandbox 옵션을 RunSmokeInput.sandbox로 그대로 전달한다", async () => {
    const inputs: RunSmokeInput[] = [];
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        inputs.push(input);
        return consumerReport;
      },
    });

    await smoke.run({
      origin: "http://127.0.0.1:3000",
      sandbox: { mode: "disabled", reason: "test" },
    });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.sandbox).toStrictEqual({
      mode: "disabled",
      reason: "test",
    });
  });

  it("sandbox 옵션을 생략하면 RunSmokeInput에 sandbox key 자체가 없다", async () => {
    const inputs: RunSmokeInput[] = [];
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        inputs.push(input);
        return consumerReport;
      },
    });

    await smoke.run({ origin: "http://127.0.0.1:3000" });

    expect(inputs).toHaveLength(1);
    expect("sandbox" in (inputs[0] as RunSmokeInput)).toBe(false);
  });
});

describe("createLegacyBrowserSmoke().selfTest", () => {
  const passingSelfTestReport = selfTestSmokeReport(
    { status: "pass", unexpectedSignals: [] },
    {
      status: "fail",
      unexpectedSignals: [{ kind: "page-error", text: "SyntaxError" }],
    },
  );

  it("executablePath가 없으면 ensureChromium을 빈 options로 호출한다", async () => {
    const ensureChromium = vi.fn(async () => executable);
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium,
      runSmoke: async () => passingSelfTestReport,
    });

    await smoke.selfTest();

    expect(ensureChromium.mock.calls).toStrictEqual([[{}]]);
  });

  it("executablePath가 있으면 ensureChromium에 executablePath만 전달한다", async () => {
    const ensureChromium = vi.fn(async () => executable);
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium,
      runSmoke: async () => passingSelfTestReport,
    });

    await smoke.selfTest({ executablePath: "/opt/chrome" });

    expect(ensureChromium.mock.calls).toStrictEqual([
      [{ executablePath: "/opt/chrome" }],
    ]);
  });

  it("loopback origin과 고정된 self test page 두 개로 runSmoke를 호출한다", async () => {
    const inputs: RunSmokeInput[] = [];
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        inputs.push(input);
        return passingSelfTestReport;
      },
    });

    await smoke.selfTest();

    expect(inputs).toHaveLength(1);
    const input = inputs[0];
    expect(input?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(input?.executable).toBe(executable);
    expect(input?.timeoutMs).toBe(10_000);
    expect(input?.knownUnsupported).toStrictEqual([]);
    expect(input?.pages).toStrictEqual([
      { name: "baseline", path: "/baseline", ready: selfTestReady },
      { name: "legacy-syntax", path: "/legacy-syntax", ready: selfTestReady },
    ]);
  });

  it("sandbox 옵션을 RunSmokeInput.sandbox로 그대로 전달한다", async () => {
    const inputs: RunSmokeInput[] = [];
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        inputs.push(input);
        return passingSelfTestReport;
      },
    });

    await smoke.selfTest({ sandbox: { mode: "disabled", reason: "test" } });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.sandbox).toStrictEqual({
      mode: "disabled",
      reason: "test",
    });
  });

  it("sandbox 옵션을 생략하면 RunSmokeInput에 sandbox key 자체가 없다", async () => {
    const inputs: RunSmokeInput[] = [];
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        inputs.push(input);
        return passingSelfTestReport;
      },
    });

    await smoke.selfTest();

    expect(inputs).toHaveLength(1);
    expect("sandbox" in (inputs[0] as RunSmokeInput)).toBe(false);
  });

  it("소비자 config의 pages와 knownUnsupported를 self test에 쓰지 않는다", async () => {
    const inputs: RunSmokeInput[] = [];
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        inputs.push(input);
        return passingSelfTestReport;
      },
    });

    await smoke.selfTest();

    expect(inputs[0]?.pages.some((page) => page.name === "home")).toBe(false);
    expect(inputs[0]?.knownUnsupported).toHaveLength(0);
  });

  it("임시 서버가 baseline과 legacy-syntax 문서를 그대로 제공한다", async () => {
    let baseline: HttpProbe | undefined;
    let legacySyntax: HttpProbe | undefined;
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        baseline = await probe(`${input.origin}/baseline`);
        legacySyntax = await probe(`${input.origin}/legacy-syntax`);
        return passingSelfTestReport;
      },
    });

    await smoke.selfTest();

    expect(baseline?.status).toBe(200);
    expect(baseline?.contentType).toBe("text/html; charset=utf-8");
    expect(baseline?.body).toBe(baselineDocument);
    expect(legacySyntax?.status).toBe(200);
    expect(legacySyntax?.contentType).toBe("text/html; charset=utf-8");
    expect(legacySyntax?.body).toBe(legacySyntaxDocument);
    expect(legacySyntax?.body.match(/<script>/gu)).toHaveLength(2);
    expect(legacySyntax?.body).toContain("({})?.a;");
  });

  it("임시 서버는 알려지지 않은 경로에 404로 응답한다", async () => {
    let unknown: HttpProbe | undefined;
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        unknown = await probe(`${input.origin}/favicon.ico`);
        return passingSelfTestReport;
      },
    });

    await smoke.selfTest();

    expect(unknown?.status).toBe(404);
  });

  it("성공적으로 끝나면 임시 서버를 닫는다", async () => {
    let origin = "";
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        origin = input.origin;
        return passingSelfTestReport;
      },
    });

    await smoke.selfTest();

    expect(await refusesConnections(portOf(origin))).toBe(true);
  });

  it("runSmoke가 실패해도 임시 서버를 닫고 오류를 그대로 전파한다", async () => {
    const failure = new LegacyBrowserSmokeError(
      "LBS_CONNECT_TIMEOUT",
      "timed out waiting for the browser",
    );
    let origin = "";
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async (input) => {
        origin = input.origin;
        throw failure;
      },
    });

    await expect(smoke.selfTest()).rejects.toBe(failure);
    expect(await refusesConnections(portOf(origin))).toBe(true);
  });

  it("ensureChromium이 실패하면 서버를 만들지 않고 오류를 전파한다", async () => {
    const failure = new LegacyBrowserSmokeError(
      "LBS_PLATFORM_UNSUPPORTED",
      "only linux x64 browser provisioning is supported",
    );
    const runSmoke = vi.fn(async () => passingSelfTestReport);
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => {
        throw failure;
      },
      runSmoke,
    });

    await expect(smoke.selfTest()).rejects.toBe(failure);
    expect(runSmoke).not.toHaveBeenCalled();
  });
});

describe("selfTest의 SmokeReport → SelfTestReport 판정", () => {
  const reportFor = async (smokeReport: SmokeReport) => {
    const smoke = createLegacyBrowserSmokeWithAdapters(consumerConfig, {
      ensureChromium: async () => executable,
      runSmoke: async () => smokeReport,
    });
    return smoke.selfTest();
  };

  it("legacy-syntax page가 pass면 구문이 거부되지 않은 것이므로 fail로 판정한다", async () => {
    const report = await reportFor(
      selfTestSmokeReport(
        { status: "pass", unexpectedSignals: [] },
        { status: "pass", unexpectedSignals: [] },
      ),
    );

    expect(report.checks).toStrictEqual([
      { name: "baseline", status: "pass" },
      { name: "legacy-syntax", status: "fail" },
    ]);
    expect(report.status).toBe("fail");
  });

  it("legacy-syntax page가 page-error로 fail이면 두 check 모두 pass다", async () => {
    const report = await reportFor(
      selfTestSmokeReport(
        { status: "pass", unexpectedSignals: [] },
        {
          status: "fail",
          unexpectedSignals: [
            { kind: "page-error", text: "SyntaxError: Unexpected token" },
          ],
        },
      ),
    );

    expect(report.checks).toStrictEqual([
      { name: "baseline", status: "pass" },
      { name: "legacy-syntax", status: "pass" },
    ]);
    expect(report.status).toBe("pass");
  });

  it("baseline page가 fail이면 전체를 fail로 판정한다", async () => {
    const report = await reportFor(
      selfTestSmokeReport(
        {
          status: "fail",
          unexpectedSignals: [{ kind: "console", text: "boom" }],
        },
        {
          status: "fail",
          unexpectedSignals: [{ kind: "page-error", text: "SyntaxError" }],
        },
      ),
    );

    expect(report.checks).toStrictEqual([
      { name: "baseline", status: "fail" },
      { name: "legacy-syntax", status: "pass" },
    ]);
    expect(report.status).toBe("fail");
  });

  it("legacy-syntax page가 page-error 없이 fail이면 해당 check를 fail로 판정한다", async () => {
    const report = await reportFor(
      selfTestSmokeReport(
        { status: "pass", unexpectedSignals: [] },
        {
          status: "fail",
          unexpectedSignals: [
            { kind: "request-failed", text: "GET /missing net::ERR_FAILED" },
          ],
        },
      ),
    );

    expect(report.checks).toStrictEqual([
      { name: "baseline", status: "pass" },
      { name: "legacy-syntax", status: "fail" },
    ]);
    expect(report.status).toBe("fail");
  });

  it("page 순서가 뒤바뀌어도 이름으로 찾아 판정한다", async () => {
    const smokeReport: SmokeReport = {
      status: "fail",
      browserVersion: "Chromium 75.0.3765.0",
      pages: [
        {
          name: "legacy-syntax",
          status: "fail",
          unexpectedSignals: [{ kind: "page-error", text: "SyntaxError" }],
          missingKnownUnsupported: [],
        },
        {
          name: "baseline",
          status: "pass",
          unexpectedSignals: [],
          missingKnownUnsupported: [],
        },
      ],
    };

    const report = await reportFor(smokeReport);

    expect(report.checks).toStrictEqual([
      { name: "baseline", status: "pass" },
      { name: "legacy-syntax", status: "pass" },
    ]);
    expect(report.status).toBe("pass");
  });

  it("SmokeReport의 browserVersion을 그대로 전달하고 결과를 freeze한다", async () => {
    const report = await reportFor(
      selfTestSmokeReport(
        { status: "pass", unexpectedSignals: [] },
        {
          status: "fail",
          unexpectedSignals: [{ kind: "page-error", text: "SyntaxError" }],
        },
        "Chromium 75.0.3765.0-selftest",
      ),
    );

    expect(report.browserVersion).toBe("Chromium 75.0.3765.0-selftest");
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);
    expect(Object.isFrozen(report.checks[0])).toBe(true);
  });
});

describe("createLegacyBrowserSmoke 기본 wiring", () => {
  it("run과 selfTest만 가진 freeze된 facade를 만든다", () => {
    const smoke = createLegacyBrowserSmoke(consumerConfig);

    expect(Reflect.ownKeys(smoke)).toStrictEqual(["run", "selfTest"]);
    expect(typeof smoke.run).toBe("function");
    expect(typeof smoke.selfTest).toBe("function");
    expect(Object.isFrozen(smoke)).toBe(true);
  });

  it("잘못된 config는 생성 시점에 LBS_CONFIG_INVALID로 거부한다", () => {
    expect(() =>
      createLegacyBrowserSmoke({
        pages: [],
        timeoutMs: 1_000,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LBS_CONFIG_INVALID" }) as Error,
    );
  });
});
