import { describe, expect, it } from "vitest";
import type { BrowserBaseline, SyntaxFeature } from "../src/baseline.js";
import type { NormalizedConfig } from "../src/config.js";
import { createWebpackPlugin } from "../src/webpack-plugin.js";
import {
  createWebpackFixture,
  type WebpackModuleDefinition,
} from "./fixtures/webpack.js";

const packageRoot = "/consumer/node_modules/legacy-widget";

const config: NormalizedConfig = {
  projectDir: "/consumer",
  policyByPackage: new Map([
    ["legacy-widget", { package: "legacy-widget", reason: "legacy syntax" }],
  ]),
  waiversByPackage: new Map(),
};

const baselineFor = (
  unsupportedSyntax: ReadonlySet<SyntaxFeature> = new Set([
    "optional-chaining",
    "nullish-coalescing",
  ]),
): BrowserBaseline => ({
  targets: ["chrome 75"],
  unsupportedSyntax,
});

const pageModule = (
  entrypoint: string,
  loaderSource: WebpackModuleDefinition["loaderSource"],
): WebpackModuleDefinition => ({
  resource: `${packageRoot}/${entrypoint}`,
  loaderSource,
  entrypoints: ["pages/index"],
});

const runPlugin = ({
  definitions,
  target = "web",
  dev = false,
  baseline = baselineFor(),
}: {
  definitions: readonly WebpackModuleDefinition[];
  target?: "web" | "node";
  dev?: boolean;
  baseline?: BrowserBaseline;
}) => {
  const fixture = createWebpackFixture({ target, modules: definitions });
  createWebpackPlugin({ config, baseline }, { dev }).apply(fixture.compiler);
  return { fixture, errors: fixture.run() };
};

const errorRecords = (errors: readonly Error[]) =>
  errors.map((error) => ({
    code: "code" in error ? error.code : undefined,
    message: error.message,
  }));

const expectStableWebpackShapeError = (operation: () => unknown): void => {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }

  expect(caught).toEqual(
    expect.objectContaining({ code: "NWB_WEBPACK_UNSUPPORTED" }),
  );
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) return;
  expect(caught.message).not.toContain("fixture");
  expect(caught.message).not.toContain("sentinel");
};

describe("createWebpackPlugin", () => {
  it("사용된 exact waiver를 package-relative warning으로 중복 제거해 정렬한다", () => {
    const waivedConfig: NormalizedConfig = {
      ...config,
      waiversByPackage: new Map([
        [
          "legacy-widget",
          [
            {
              package: "legacy-widget",
              reason: "must not leak this reason",
              allowedEntrypoints: ["dist/z.js", "dist/a.js"],
            },
          ],
        ],
      ]),
    };
    const duplicate = pageModule(
      "dist/z.js",
      "const value = input?.value ?? fallback;",
    );
    const fixture = createWebpackFixture({
      modules: [
        duplicate,
        { ...duplicate },
        pageModule("dist/a.js", "const value = input?.value;"),
      ],
    });
    createWebpackPlugin(
      { config: waivedConfig, baseline: baselineFor() },
      { dev: false },
    ).apply(fixture.compiler);

    expect(fixture.run()).toEqual([]);
    expect(
      fixture.compilation.warnings.map((warning) => ({
        name: warning.name,
        message: warning.message,
        stack: warning.stack,
      })),
    ).toEqual([
      {
        name: "NextWebpackBaselineWaiverWarning",
        message: "waiver applied: legacy-widget/dist/a.js",
        stack:
          "NextWebpackBaselineWaiverWarning: waiver applied: legacy-widget/dist/a.js",
      },
      {
        name: "NextWebpackBaselineWaiverWarning",
        message: "waiver applied: legacy-widget/dist/z.js",
        stack:
          "NextWebpackBaselineWaiverWarning: waiver applied: legacy-widget/dist/z.js",
      },
    ]);
  });

  it("chunkGraph가 afterSeal 직전에 준비되는 Webpack lifecycle을 지원한다", () => {
    const fixture = createWebpackFixture({
      chunkGraphTiming: "after-seal",
      modules: [pageModule("dist/lifecycle.js", "const value = input?.value;")],
    });
    createWebpackPlugin(
      { config, baseline: baselineFor() },
      { dev: false },
    ).apply(fixture.compiler);

    expect(errorRecords(fixture.run())).toEqual([
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        message:
          "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/lifecycle.js: optional-chaining 구문은 설정된 browser baseline에서 지원되지 않습니다.",
      },
    ]);
  });

  it("server compilation은 module source를 읽지 않고 검사에서 제외한다", () => {
    const { fixture, errors } = runPlugin({
      target: "node",
      definitions: [
        pageModule("dist/server.js", "const value = input?.value;"),
      ],
    });

    expect(errors).toEqual([]);
    expect(fixture.modules[0]?.sourceReads).toBe(0);
  });

  it("실제 resource가 없는 virtual module은 source를 읽지 않는다", () => {
    const { fixture, errors } = runPlugin({
      definitions: [
        {
          loaderSource: "const value = input?.value;",
          entrypoints: ["pages/index"],
        },
        {
          resource: 42,
          loaderSource: "const value = input?.value;",
          entrypoints: ["pages/index"],
        },
      ],
    });

    expect(errors).toEqual([]);
    expect(fixture.modules.map((module) => module.sourceReads)).toEqual([0, 0]);
  });

  it("도달한 정책 package의 loader source를 읽을 수 없으면 안정된 오류로 차단한다", () => {
    const { errors } = runPlugin({
      definitions: [
        {
          ...pageModule("dist/a-missing.js", "const value = 1;"),
          sourceFailure: "missing-original-source",
        },
        pageModule("dist/b-null.js", null),
        {
          ...pageModule("dist/c-original-throws.js", "const value = 1;"),
          sourceFailure: "original-source-throws",
        },
        {
          ...pageModule("dist/d-source-throws.js", "const value = 1;"),
          sourceFailure: "source-throws",
        },
        pageModule("dist/e-unsupported.js", { unsupported: true }),
      ],
    });

    expect(errorRecords(errors)).toEqual(
      [
        "dist/a-missing.js",
        "dist/b-null.js",
        "dist/c-original-throws.js",
        "dist/d-source-throws.js",
        "dist/e-unsupported.js",
      ].map((entrypoint) => ({
        code: "NWB_WEBPACK_UNSUPPORTED",
        message: `[NWB_WEBPACK_UNSUPPORTED] legacy-widget/${entrypoint}: loader 처리 후 JavaScript source를 읽을 수 없습니다.`,
      })),
    );
  });

  it("loader 처리 전 source가 아니라 originalSource의 처리 결과를 검사한다", () => {
    const { errors } = runPlugin({
      definitions: [
        {
          ...pageModule("dist/transformed.js", "const value = input?.value;"),
          beforeLoadersSource: "var value = input && input.value;",
        },
        {
          ...pageModule(
            "dist/downleveled.js",
            "var value = input && input.value;",
          ),
          beforeLoadersSource: "const value = input?.value;",
        },
      ],
    });

    expect(errorRecords(errors)).toEqual([
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        message:
          "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/transformed.js: optional-chaining 구문은 설정된 browser baseline에서 지원되지 않습니다.",
      },
    ]);
  });

  it("Pages Router client entry에서 도달한 module만 오류에 포함한다", () => {
    const { fixture, errors } = runPlugin({
      definitions: [
        pageModule("dist/page.js", "const value = input?.value;"),
        {
          resource: `${packageRoot}/dist/app-router.js`,
          loaderSource: "const value = input?.value;",
          entrypoints: ["app/dashboard/page"],
        },
        {
          resource: `${packageRoot}/dist/unreachable.js`,
          loaderSource: "const value = input?.value;",
          entrypoints: [],
        },
      ],
    });

    expect(errorRecords(errors)).toEqual([
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        message:
          "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/page.js: optional-chaining 구문은 설정된 browser baseline에서 지원되지 않습니다.",
      },
    ]);
    expect(fixture.modules.map((module) => module.sourceReads)).toEqual([
      1, 0, 0,
    ]);
  });

  it.each([
    { name: "module chunk iterable 부재", moduleChunksShape: "non-iterable" },
    {
      name: "module chunk API getter 예외",
      moduleChunksShape: "method-getter-throws",
    },
    { name: "chunk group iterable 부재", groupShape: "missing-groups" },
    {
      name: "chunk group iterable의 원시 원소",
      groupShape: "primitive-group-element",
    },
    {
      name: "chunk group iterable getter 예외",
      groupShape: "groups-getter-throws",
    },
    { name: "chunk group parent API 부재", groupShape: "missing-parents" },
    {
      name: "chunk group parents iterable의 원시 원소",
      groupShape: "primitive-parent-element",
    },
    {
      name: "chunk group parent API getter 예외",
      groupShape: "parents-getter-throws",
    },
  ] satisfies ReadonlyArray<{
    name: string;
    moduleChunksShape?: "non-iterable" | "method-getter-throws";
    groupShape?:
      | "missing-groups"
      | "missing-parents"
      | "primitive-group-element"
      | "primitive-parent-element"
      | "groups-getter-throws"
      | "parents-getter-throws";
  }>)("$name은 NWB_WEBPACK_UNSUPPORTED로 fail-closed 한다", (shape) => {
    const fixture = createWebpackFixture({
      modules: [
        {
          ...pageModule("dist/graph.js", "const value = input?.value;"),
          ...(shape.groupShape === undefined
            ? {}
            : { groupShape: shape.groupShape }),
        },
      ],
      ...(shape.moduleChunksShape === undefined
        ? {}
        : { moduleChunksShape: shape.moduleChunksShape }),
    });
    createWebpackPlugin(
      { config, baseline: baselineFor() },
      { dev: false },
    ).apply(fixture.compiler);

    expectStableWebpackShapeError(() => fixture.run());
  });

  it.each([
    { name: "chunk group name getter 예외", groupShape: "name-getter-throws" },
    { name: "entrypoints get 호출 예외", entrypointsShape: "get-throws" },
    {
      name: "entrypoints get의 원시 반환값",
      entrypointsShape: "primitive-result",
    },
    { name: "module resource getter 예외", resourceShape: "getter-throws" },
    { name: "module type getter 예외", typeShape: "getter-throws" },
  ] satisfies ReadonlyArray<{
    name: string;
    groupShape?: "name-getter-throws";
    entrypointsShape?: "get-throws" | "primitive-result";
    resourceShape?: "getter-throws";
    typeShape?: "getter-throws";
  }>)("$name도 sentinel을 노출하지 않고 fail-closed 한다", (shape) => {
    const fixture = createWebpackFixture({
      modules: [
        {
          ...pageModule("dist/hostile.js", "const value = input?.value;"),
          ...(shape.groupShape === undefined
            ? {}
            : { groupShape: shape.groupShape }),
          ...(shape.resourceShape === undefined
            ? {}
            : { resourceShape: shape.resourceShape }),
          ...(shape.typeShape === undefined
            ? {}
            : { typeShape: shape.typeShape }),
        },
      ],
      ...(shape.entrypointsShape === undefined
        ? {}
        : { entrypointsShape: shape.entrypointsShape }),
    });
    createWebpackPlugin(
      { config, baseline: baselineFor() },
      { dev: false },
    ).apply(fixture.compiler);

    expectStableWebpackShapeError(() => fixture.run());
  });

  it("iterable inner modules를 가진 합성 module은 각 loader source를 검사한다", () => {
    const { errors } = runPlugin({
      definitions: [
        {
          loaderSource: null,
          entrypoints: ["pages/index"],
          children: [
            pageModule(
              "dist/concatenated-child.js",
              "const value = input?.value;",
            ),
          ],
        },
      ],
    });

    expect(errorRecords(errors)).toEqual([
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        message:
          "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/concatenated-child.js: optional-chaining 구문은 설정된 browser baseline에서 지원되지 않습니다.",
      },
    ]);
  });

  it.each(["non-iterable", "throws", "iterator-getter-throws"] as const)(
    "inner module container가 %s이면 조용히 제외하지 않는다",
    (nestedModulesShape) => {
      const fixture = createWebpackFixture({
        modules: [
          {
            loaderSource: null,
            entrypoints: ["pages/index"],
            nestedModulesShape,
          },
        ],
      });
      createWebpackPlugin(
        { config, baseline: baselineFor() },
        { dev: false },
      ).apply(fixture.compiler);

      expectStableWebpackShapeError(() => fixture.run());
    },
  );

  it("동일 resource와 content hash는 한 번만 분석하고 다른 content는 분리한다", () => {
    class CountingSyntaxSet extends Set<SyntaxFeature> {
      hasCalls = 0;

      override has(value: SyntaxFeature): boolean {
        this.hasCalls += 1;
        return super.has(value);
      }
    }

    const unsupportedSyntax = new CountingSyntaxSet([
      "optional-chaining",
      "nullish-coalescing",
    ]);
    const duplicate = pageModule(
      "dist/duplicate.js",
      "const value = input?.value;",
    );
    const { errors } = runPlugin({
      definitions: [
        duplicate,
        { ...duplicate },
        pageModule("dist/duplicate.js", "const value = input ?? fallback;"),
      ],
      baseline: baselineFor(unsupportedSyntax),
    });

    expect(unsupportedSyntax.hasCalls).toBe(2);
    expect(errorRecords(errors).map(({ code }) => code)).toEqual([
      "NWB_SYNTAX_UNSUPPORTED",
      "NWB_SYNTAX_UNSUPPORTED",
    ]);
  });

  it("unsupported syntax와 parse-incomplete를 안정된 package-relative 오류로 추가한다", () => {
    const definitions = [
      pageModule("dist/z-optional.js", "const value = input?.value;"),
      pageModule("dist/a-invalid.js", "const = ;"),
    ];

    const forward = runPlugin({ definitions }).errors;
    const reverse = runPlugin({
      definitions: [...definitions].reverse(),
    }).errors;
    const expected = [
      {
        code: "NWB_SYNTAX_PARSE_INCOMPLETE",
        message:
          "[NWB_SYNTAX_PARSE_INCOMPLETE] legacy-widget/dist/a-invalid.js: JavaScript source를 완전히 parse할 수 없습니다: JavaScript 문법이 올바르지 않습니다.",
      },
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        message:
          "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/z-optional.js: optional-chaining 구문은 설정된 browser baseline에서 지원되지 않습니다.",
      },
    ];

    expect(errorRecords(forward)).toEqual(expected);
    expect(errorRecords(reverse)).toEqual(expected);
  });

  it.each([false, true])(
    "dev=%s에서도 같은 verdict를 사용하고 compilation 밖 cache를 공유하지 않는다",
    (dev) => {
      class CountingSyntaxSet extends Set<SyntaxFeature> {
        hasCalls = 0;

        override has(value: SyntaxFeature): boolean {
          this.hasCalls += 1;
          return super.has(value);
        }
      }

      const unsupportedSyntax = new CountingSyntaxSet(["optional-chaining"]);
      const plugin = createWebpackPlugin(
        { config, baseline: baselineFor(unsupportedSyntax) },
        { dev },
      );
      const definitions = [
        pageModule("dist/watch.js", "const value = input?.value;"),
      ];
      const first = createWebpackFixture({ modules: definitions });
      const second = createWebpackFixture({ modules: definitions });

      plugin.apply(first.compiler);
      plugin.apply(second.compiler);

      expect(errorRecords(first.run())).toEqual(errorRecords(second.run()));
      expect(errorRecords(first.compilation.errors)).toEqual([
        {
          code: "NWB_SYNTAX_UNSUPPORTED",
          message:
            "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/watch.js: optional-chaining 구문은 설정된 browser baseline에서 지원되지 않습니다.",
        },
      ]);
      expect(unsupportedSyntax.hasCalls).toBe(2);
    },
  );

  it("지원할 수 없는 compiler hook 형상은 NWB_WEBPACK_UNSUPPORTED로 중단한다", () => {
    const plugin = createWebpackPlugin(
      { config, baseline: baselineFor() },
      { dev: false },
    );

    expect(() => plugin.apply({ hooks: {} })).toThrow(
      expect.objectContaining({ code: "NWB_WEBPACK_UNSUPPORTED" }),
    );
  });
});
