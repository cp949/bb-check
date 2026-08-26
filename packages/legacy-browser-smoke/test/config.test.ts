import { describe, expect, it } from "vitest";
import { defineSmokeConfig } from "../src/index.js";
import type { LegacyBrowserSmokeConfig } from "../src/index.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";

const selectorPage = {
  name: "  home  ",
  path: "/" as const,
  ready: { kind: "selector" as const, selector: "  main  " },
};

const expressionPage = {
  name: "state",
  path: "/state" as const,
  ready: {
    kind: "expression" as const,
    expression: "  window.ready === true  ",
  },
};

const validConfig = () => ({
  pages: [
    { ...selectorPage, ready: { ...selectorPage.ready } },
    { ...expressionPage, ready: { ...expressionPage.ready } },
  ],
  timeoutMs: 1_000,
  knownUnsupported: [
    {
      kind: "console" as const,
      pattern: "\r\n  known unsupported\rtext  \r",
      count: 2,
      reason: "  documented browser gap  ",
    },
  ],
});

const normalize = (input: unknown) =>
  defineSmokeConfig(input as LegacyBrowserSmokeConfig);

const expectConfigInvalid = (operation: () => unknown): void => {
  expect(operation).toThrow(
    expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
      code: "LBS_CONFIG_INVALID",
      name: "LegacyBrowserSmokeError",
    }),
  );
};

describe("defineSmokeConfig", () => {
  it("selector와 expression ready 조건을 독립된 동결 값으로 정상화한다", () => {
    const input = validConfig();
    const normalized = normalize(input);

    expect(normalized).toEqual({
      pages: [
        {
          name: "home",
          path: "/",
          ready: { kind: "selector", selector: "main" },
        },
        {
          name: "state",
          path: "/state",
          ready: { kind: "expression", expression: "window.ready === true" },
        },
      ],
      timeoutMs: 1_000,
      knownUnsupported: [
        {
          kind: "console",
          pattern: "known unsupported\ntext",
          count: 2,
          reason: "documented browser gap",
        },
      ],
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.pages)).toBe(true);
    expect(Object.isFrozen(normalized.pages[0])).toBe(true);
    expect(Object.isFrozen(normalized.pages[0]?.ready)).toBe(true);
    expect(Object.isFrozen(normalized.knownUnsupported)).toBe(true);
    expect(Object.isFrozen(normalized.knownUnsupported?.[0])).toBe(true);
  });

  it("호출자 배열과 중첩 객체를 보관하지 않아 이후 변경과 함께 바뀌지 않는다", () => {
    const input = validConfig();
    const normalized = normalize(input);

    input.pages[0]!.name = "changed";
    if (input.pages[0]?.ready.kind === "selector") {
      input.pages[0].ready.selector = "changed";
    }
    input.knownUnsupported![0]!.reason = "changed";
    input.pages.pop();

    expect(normalized.pages).toHaveLength(2);
    expect(normalized.pages[0]).toEqual({
      name: "home",
      path: "/",
      ready: { kind: "selector", selector: "main" },
    });
    expect(normalized.knownUnsupported?.[0]?.reason).toBe(
      "documented browser gap",
    );
  });

  it("unknown string, symbol, non-enumerable 및 inherited 설정 키를 거부한다", () => {
    const stringKey = { ...validConfig(), extra: true };
    const symbolKey = validConfig();
    Object.defineProperty(symbolKey, Symbol("extra"), { value: true });
    const hiddenKey = validConfig();
    Object.defineProperty(hiddenKey, "hidden", { value: true });
    const inherited = Object.create({ pages: [selectorPage] }) as {
      timeoutMs: number;
    };
    inherited.timeoutMs = 1_000;

    expectConfigInvalid(() => normalize(stringKey));
    expectConfigInvalid(() => normalize(symbolKey));
    expectConfigInvalid(() => normalize(hiddenKey));
    expectConfigInvalid(() => normalize(inherited));
  });

  it("accessor를 실행하지 않고 LBS_CONFIG_INVALID로 거부한다", () => {
    const input = validConfig();
    Object.defineProperty(input, "pages", {
      get: () => {
        throw new Error("getter must stay uncalled");
      },
    });

    let caught: unknown;
    try {
      normalize(input);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_CONFIG_INVALID",
      }),
    );
    expect((caught as Error).message).not.toContain(
      "getter must stay uncalled",
    );
  });

  it("sparse, inherited index, extra own key 및 메서드를 바꾼 배열을 거부한다", () => {
    const sparse = [selectorPage] as (typeof selectorPage)[];
    delete sparse[0];
    const inheritedIndex = [] as (typeof selectorPage)[];
    Object.setPrototypeOf(inheritedIndex, [selectorPage]);
    const extraKey = [selectorPage] as (typeof selectorPage)[] & {
      note?: string;
    };
    extraKey.note = "extra";
    const changedMethod = [selectorPage] as (typeof selectorPage)[] & {
      map?: unknown;
    };
    changedMethod.map = () => [];

    expectConfigInvalid(() => normalize({ pages: sparse, timeoutMs: 1 }));
    expectConfigInvalid(() =>
      normalize({ pages: inheritedIndex, timeoutMs: 1 }),
    );
    expectConfigInvalid(() => normalize({ pages: extraKey, timeoutMs: 1 }));
    expectConfigInvalid(() =>
      normalize({ pages: changedMethod, timeoutMs: 1 }),
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "안전한 양의 정수가 아닌 timeoutMs %s를 거부한다",
    (timeoutMs) => {
      expectConfigInvalid(() =>
        normalize({ pages: [selectorPage], timeoutMs }),
      );
    },
  );

  it("빈 pages, 중복 이름, 빈 이름 및 잘못된 ready 분기를 거부한다", () => {
    expectConfigInvalid(() => normalize({ pages: [], timeoutMs: 1 }));
    expectConfigInvalid(() =>
      normalize({
        pages: [
          { ...selectorPage, name: "home" },
          { ...selectorPage, name: "home" },
        ],
        timeoutMs: 1,
      }),
    );
    expectConfigInvalid(() =>
      normalize({ pages: [{ ...selectorPage, name: " \t " }], timeoutMs: 1 }),
    );
    expectConfigInvalid(() =>
      normalize({
        pages: [
          {
            ...selectorPage,
            ready: { kind: "selector", selector: "main", expression: "true" },
          },
        ],
        timeoutMs: 1,
      }),
    );
    expectConfigInvalid(() =>
      normalize({
        pages: [
          { ...selectorPage, ready: { kind: "expression", expression: " " } },
        ],
        timeoutMs: 1,
      }),
    );
  });

  it.each(["", "//double", "/back\\slash", "/bad\u0000path", "relative"])(
    "안전하지 않은 path %j를 거부한다",
    (path) => {
      expectConfigInvalid(() =>
        normalize({ pages: [{ ...selectorPage, path }], timeoutMs: 1 }),
      );
    },
  );

  it.each(["/extended\u0080", "/extended\u009f"])(
    "C1 control %j를 포함한 path는 보존한다",
    (path) => {
      const normalized = normalize({
        pages: [{ ...selectorPage, path }],
        timeoutMs: 1,
      });

      expect(normalized.pages[0]?.path).toBe(path);
    },
  );

  it("invalid count, duplicate signal 및 비어 있는 canonical pattern을 거부한다", () => {
    const signal = validConfig().knownUnsupported![0]!;
    expectConfigInvalid(() =>
      normalize({
        pages: [selectorPage],
        timeoutMs: 1,
        knownUnsupported: [{ ...signal, count: 0 }],
      }),
    );
    expectConfigInvalid(() =>
      normalize({
        pages: [selectorPage],
        timeoutMs: 1,
        knownUnsupported: [
          signal,
          { ...signal, pattern: "\n known unsupported\ntext \n" },
        ],
      }),
    );
    expectConfigInvalid(() =>
      normalize({
        pages: [selectorPage],
        timeoutMs: 1,
        knownUnsupported: [{ ...signal, pattern: " \r\n\t " }],
      }),
    );
  });

  it("optional knownUnsupported는 빈 동결 배열로 정상화한다", () => {
    const normalized = normalize({ pages: [selectorPage], timeoutMs: 1 });

    expect(normalized.knownUnsupported).toEqual([]);
    expect(Object.isFrozen(normalized.knownUnsupported)).toBe(true);
  });

  it("expectedPath는 path와 같은 규칙으로 검증되고 정규화 결과에 보존된다", () => {
    const config = defineSmokeConfig({
      pages: [
        {
          name: "my-info",
          path: "/mypage/my-info",
          expectedPath: "/mypage/my-info",
          ready: { kind: "selector", selector: "#app" },
        },
      ],
      timeoutMs: 1_000,
    });

    expect(config.pages[0]?.expectedPath).toBe("/mypage/my-info");
  });

  it("expectedPath를 생략하면 정규화된 page에 key 자체가 없다", () => {
    const config = defineSmokeConfig({
      pages: [
        { name: "home", path: "/", ready: { kind: "selector", selector: "#app" } },
      ],
      timeoutMs: 1_000,
    });

    expect(Object.hasOwn(config.pages[0] ?? {}, "expectedPath")).toBe(false);
  });

  it.each([
    ["슬래시로 시작하지 않음", "mypage"],
    ["이중 슬래시 시작", "//evil"],
    ["backslash 포함", "/my\\page"],
    ["제어문자 포함", "/my\npage"],
  ])("expectedPath가 %s이면 LBS_CONFIG_INVALID다", (_label, expectedPath) => {
    expect(() =>
      defineSmokeConfig({
        pages: [
          {
            name: "home",
            path: "/",
            expectedPath: expectedPath as `/${string}`,
            ready: { kind: "selector", selector: "#app" },
          },
        ],
        timeoutMs: 1_000,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LBS_CONFIG_INVALID" }) as Error,
    );
  });

  it("script-parse known-unsupported는 위치 필드로 선언한다", () => {
    const config = defineSmokeConfig({
      pages: [
        { name: "home", path: "/", ready: { kind: "selector", selector: "#app" } },
      ],
      timeoutMs: 1_000,
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
    });

    expect(config.knownUnsupported).toEqual([
      {
        kind: "script-parse",
        sourcePath: "/_next/static/chunks/a.js",
        lineNumber: 0,
        columnNumber: 0,
        count: 1,
        reason: "Chrome 75의 chunk 문법 미지원",
      },
    ]);
  });

  it("script-parse의 lineNumber/columnNumber는 0을 허용하고 음수·비정수를 거절한다", () => {
    const declare = (lineNumber: number, columnNumber: number) =>
      defineSmokeConfig({
        pages: [
          { name: "home", path: "/", ready: { kind: "selector", selector: "#app" } },
        ],
        timeoutMs: 1_000,
        knownUnsupported: [
          {
            kind: "script-parse",
            sourcePath: "/a.js",
            lineNumber,
            columnNumber,
            count: 1,
            reason: "이유",
          },
        ],
      });

    expect(declare(0, 0).knownUnsupported).toHaveLength(1);
    for (const [line, column] of [
      [-1, 0],
      [0, -1],
      [0.5, 0],
      [0, Number.NaN],
    ] as const) {
      expect(() => declare(line, column)).toThrowError(
        expect.objectContaining({ code: "LBS_CONFIG_INVALID" }) as Error,
      );
    }
  });

  it("script-parse sourcePath는 page path와 같은 규칙으로 검증된다", () => {
    expect(() =>
      defineSmokeConfig({
        pages: [
          { name: "home", path: "/", ready: { kind: "selector", selector: "#app" } },
        ],
        timeoutMs: 1_000,
        knownUnsupported: [
          {
            kind: "script-parse",
            sourcePath: "http://evil.example/a.js" as `/${string}`,
            lineNumber: 0,
            columnNumber: 0,
            count: 1,
            reason: "이유",
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LBS_CONFIG_INVALID" }) as Error,
    );
  });

  it("같은 위치의 script-parse 중복 선언은 거절한다", () => {
    expect(() =>
      defineSmokeConfig({
        pages: [
          { name: "home", path: "/", ready: { kind: "selector", selector: "#app" } },
        ],
        timeoutMs: 1_000,
        knownUnsupported: [
          {
            kind: "script-parse",
            sourcePath: "/a.js",
            lineNumber: 0,
            columnNumber: 0,
            count: 1,
            reason: "이유",
          },
          {
            kind: "script-parse",
            sourcePath: "/a.js",
            lineNumber: 0,
            columnNumber: 0,
            count: 2,
            reason: "다른 이유",
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LBS_CONFIG_INVALID" }) as Error,
    );
  });

  it("script-pending은 텍스트 pattern known-unsupported로 선언할 수 있다", () => {
    const config = defineSmokeConfig({
      pages: [
        { name: "home", path: "/", ready: { kind: "selector", selector: "#app" } },
      ],
      timeoutMs: 1_000,
      knownUnsupported: [
        { kind: "script-pending", pattern: "path=/slow.js", count: 1, reason: "이유" },
      ],
    });

    expect(config.knownUnsupported?.[0]?.kind).toBe("script-pending");
  });

  it("path-mismatch는 known-unsupported kind로 선언할 수 없다", () => {
    expect(() =>
      defineSmokeConfig({
        pages: [
          { name: "home", path: "/", ready: { kind: "selector", selector: "#app" } },
        ],
        timeoutMs: 1_000,
        knownUnsupported: [
          {
            kind: "path-mismatch",
            pattern: "expected=/a; final=/b",
            count: 1,
            reason: "이유",
          } as never,
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LBS_CONFIG_INVALID" }) as Error,
    );
  });
});
