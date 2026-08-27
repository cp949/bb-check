import { describe, expect, it } from "vitest";
import type { BrowserBaseline, SyntaxFeature } from "../src/baseline.js";
import type { NormalizedConfig } from "../src/config.js";
import type { ReportFileSystem } from "../src/unlisted-report.js";
import { createWebpackPlugin } from "../src/webpack-plugin.js";
import {
  createWebpackFixture,
  type WebpackModuleDefinition,
} from "./fixtures/webpack.js";

const packageRoot = "/consumer/node_modules/legacy-widget";

const config: NormalizedConfig = {
  projectDir: "/consumer",
  unlistedPackages: "ignore",
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

const unlistedPageModule = (
  entrypoint: string,
  loaderSource: WebpackModuleDefinition["loaderSource"],
): WebpackModuleDefinition => ({
  resource: `/consumer/node_modules/unlisted-widget/${entrypoint}`,
  loaderSource,
  entrypoints: ["pages/index"],
});

const createReportFileSystem = (options?: {
  readonly onWrite?: (data: string) => void;
  readonly writeError?: Error;
  readonly removeError?: NodeJS.ErrnoException;
}) => {
  const writes: string[] = [];
  const removed: string[] = [];
  const fileSystem: ReportFileSystem = {
    temporaryPath: (target) => `${target}.tmp-test`,
    mkdirSync() {},
    writeFileSync(_path, data) {
      options?.onWrite?.(data);
      if (options?.writeError !== undefined) throw options.writeError;
      writes.push(data);
    },
    renameSync() {},
    unlinkSync(path) {
      removed.push(path);
      if (options?.removeError !== undefined) throw options.removeError;
    },
  };
  return { fileSystem, removed, writes };
};

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
  it("production warn은 미등록 package를 집계해 warning과 JSON을 남긴다", () => {
    const report = createReportFileSystem();
    const fixture = createWebpackFixture({
      modules: [
        unlistedPageModule(
          "dist/index.js",
          "class Widget { value = input?.first?.second; }",
        ),
      ],
    });
    createWebpackPlugin(
      {
        config: {
          ...config,
          unlistedPackages: "warn",
          policyByPackage: new Map(),
        },
        baseline: baselineFor(
          new Set(["optional-chaining", "class-properties"]),
        ),
        reportFileSystem: report.fileSystem,
      },
      { dev: false },
    ).apply(fixture.compiler);

    expect(fixture.run()).toEqual([]);
    expect(fixture.modules[0]?.sourceReads).toBe(1);
    expect(
      fixture.compilation.warnings.map(({ name, message }) => ({
        name,
        message,
      })),
    ).toEqual([
      {
        name: "NextWebpackBaselineUnlistedPackageWarning",
        message:
          "unlisted-widget: ?. 2건 · 클래스 필드 1건 — policy 등록 또는 waiver 검토\npolicy 제안: { package: 'unlisted-widget', reason: '?. 2건 · 클래스 필드 1건' },",
      },
      {
        name: "NextWebpackBaselineUnlistedSummaryWarning",
        message:
          "미등록 1패키지 · 미지원 문법 3건 · 분석 불가 0건 — 상세: .next/diagnostics/baseline-unlisted.json",
      },
    ]);
    expect(report.writes).toHaveLength(1);
    expect(JSON.parse(report.writes[0] ?? "")).toEqual({
      schemaVersion: 1,
      mode: "warn",
      packages: [
        {
          package: "unlisted-widget",
          diagnostics: [
            { feature: "optional-chaining", count: 2 },
            { feature: "class-properties", count: 1 },
          ],
          suggestedReason: "?. 2건 · 클래스 필드 1건",
        },
      ],
      unanalyzable: [],
    });
  });

  it("미등록 동일 resource/content hash는 한 번만 세고 다른 source count는 합산한다", () => {
    const report = createReportFileSystem();
    const duplicate = unlistedPageModule(
      "dist/index.js",
      "const value = input?.value;",
    );
    const fixture = createWebpackFixture({
      modules: [
        duplicate,
        { ...duplicate },
        unlistedPageModule("dist/index.js", "const value = input ?? fallback;"),
      ],
    });
    createWebpackPlugin(
      {
        config: {
          ...config,
          unlistedPackages: "warn",
          policyByPackage: new Map(),
        },
        baseline: baselineFor(
          new Set(["optional-chaining", "nullish-coalescing"]),
        ),
        reportFileSystem: report.fileSystem,
      },
      { dev: false },
    ).apply(fixture.compiler);

    fixture.run();
    expect(JSON.parse(report.writes[0] ?? "").packages).toEqual([
      {
        package: "unlisted-widget",
        diagnostics: [
          { feature: "optional-chaining", count: 1 },
          { feature: "nullish-coalescing", count: 1 },
        ],
        suggestedReason: "?. 1건 · ?? 1건",
      },
    ]);
  });

  it("production error는 JSON을 먼저 쓴 뒤 같은 report를 compilation error로 주입한다", () => {
    const fixture = createWebpackFixture({
      modules: [
        unlistedPageModule("dist/index.js", "const value = input?.value;"),
      ],
    });
    const report = createReportFileSystem({
      onWrite() {
        expect(fixture.compilation.errors).toEqual([]);
      },
    });
    createWebpackPlugin(
      {
        config: {
          ...config,
          unlistedPackages: "error",
          policyByPackage: new Map(),
        },
        baseline: baselineFor(new Set(["optional-chaining"])),
        reportFileSystem: report.fileSystem,
      },
      { dev: false },
    ).apply(fixture.compiler);

    expect(fixture.run()).toHaveLength(2);
    expect(fixture.compilation.errors.map(({ name }) => name)).toEqual([
      "NextWebpackBaselineUnlistedPackageError",
      "NextWebpackBaselineUnlistedSummaryError",
    ]);
    expect(JSON.parse(report.writes[0] ?? "")).toEqual(
      expect.objectContaining({ mode: "error" }),
    );
  });

  it.each([
    { name: "production ignore", dev: false, mode: "ignore", removes: 1 },
    { name: "development warn", dev: true, mode: "warn", removes: 0 },
  ] as const)(
    "$name은 미등록 source를 읽지 않는다",
    ({ dev, mode, removes }) => {
      const report = createReportFileSystem();
      const fixture = createWebpackFixture({
        modules: [
          unlistedPageModule("dist/index.js", "const value = input?.value;"),
        ],
      });
      createWebpackPlugin(
        {
          config: {
            ...config,
            unlistedPackages: mode,
            policyByPackage: new Map(),
          },
          baseline: baselineFor(),
          reportFileSystem: report.fileSystem,
        },
        { dev },
      ).apply(fixture.compiler);

      expect(fixture.run()).toEqual([]);
      expect(fixture.modules[0]?.sourceReads).toBe(0);
      expect(report.writes).toEqual([]);
      expect(report.removed).toHaveLength(removes);
    },
  );

  it("미등록 exact waiver는 기존 waiver warning만 남기고 report 제안에서 제외한다", () => {
    const report = createReportFileSystem();
    const fixture = createWebpackFixture({
      modules: [
        unlistedPageModule("dist/index.js", "const value = input?.value;"),
      ],
    });
    createWebpackPlugin(
      {
        config: {
          ...config,
          unlistedPackages: "warn",
          policyByPackage: new Map(),
          waiversByPackage: new Map([
            [
              "unlisted-widget",
              [
                {
                  package: "unlisted-widget",
                  reason: "reviewed exact entrypoint",
                  allowedEntrypoints: ["dist/index.js"],
                },
              ],
            ],
          ]),
        },
        baseline: baselineFor(new Set(["optional-chaining"])),
        reportFileSystem: report.fileSystem,
      },
      { dev: false },
    ).apply(fixture.compiler);

    expect(fixture.run()).toEqual([]);
    expect(
      fixture.compilation.warnings.map(({ name, message }) => ({
        name,
        message,
      })),
    ).toEqual([
      {
        name: "NextWebpackBaselineWaiverWarning",
        message: "waiver applied: unlisted-widget/dist/index.js",
      },
    ]);
    expect(JSON.parse(report.writes[0] ?? "")).toEqual({
      schemaVersion: 1,
      mode: "warn",
      packages: [],
      unanalyzable: [],
    });
  });

  it("같은 미등록 package의 waived entrypoint만 집계에서 제외한다", () => {
    const report = createReportFileSystem();
    const fixture = createWebpackFixture({
      modules: [
        unlistedPageModule("dist/a-waived.js", "const value = input?.value;"),
        unlistedPageModule("dist/b-reported.js", "const value = input?.value;"),
      ],
    });
    createWebpackPlugin(
      {
        config: {
          ...config,
          unlistedPackages: "warn",
          policyByPackage: new Map(),
          waiversByPackage: new Map([
            [
              "unlisted-widget",
              [
                {
                  package: "unlisted-widget",
                  reason: "one reviewed entrypoint",
                  allowedEntrypoints: ["dist/a-waived.js"],
                },
              ],
            ],
          ]),
        },
        baseline: baselineFor(new Set(["optional-chaining"])),
        reportFileSystem: report.fileSystem,
      },
      { dev: false },
    ).apply(fixture.compiler);

    fixture.run();
    expect(JSON.parse(report.writes[0] ?? "").packages).toEqual([
      {
        package: "unlisted-widget",
        diagnostics: [{ feature: "optional-chaining", count: 1 }],
        suggestedReason: "?. 1건",
      },
    ]);
    expect(fixture.compilation.warnings[0]?.message).toBe(
      "waiver applied: unlisted-widget/dist/a-waived.js",
    );
  });

  it("미등록 parse-incomplete에는 exact waiver를 적용하지 않는다", () => {
    const report = createReportFileSystem();
    const fixture = createWebpackFixture({
      modules: [unlistedPageModule("dist/index.js", "const = ;")],
    });
    createWebpackPlugin(
      {
        config: {
          ...config,
          unlistedPackages: "warn",
          policyByPackage: new Map(),
          waiversByPackage: new Map([
            [
              "unlisted-widget",
              [
                {
                  package: "unlisted-widget",
                  reason: "must not waive incomplete parse",
                  allowedEntrypoints: ["dist/index.js"],
                },
              ],
            ],
          ]),
        },
        baseline: baselineFor(),
        reportFileSystem: report.fileSystem,
      },
      { dev: false },
    ).apply(fixture.compiler);

    fixture.run();
    expect(fixture.compilation.warnings.map(({ name }) => name)).toEqual([
      "NextWebpackBaselineUnlistedPackageWarning",
      "NextWebpackBaselineUnlistedSummaryWarning",
    ]);
    expect(JSON.parse(report.writes[0] ?? "").unanalyzable).toEqual([
      {
        package: "unlisted-widget",
        entrypoint: "dist/index.js",
        cause: "NWB_SYNTAX_PARSE_INCOMPLETE",
      },
    ]);
  });

  it.each(["warn", "error"] as const)(
    "미등록 분석 불가는 %s mode severity와 JSON cause를 따른다",
    (mode) => {
      const report = createReportFileSystem();
      const fixture = createWebpackFixture({
        modules: [
          {
            ...unlistedPageModule("dist/index.js", "const value = 1;"),
            sourceFailure: "missing-original-source",
          },
        ],
      });
      createWebpackPlugin(
        {
          config: {
            ...config,
            unlistedPackages: mode,
            policyByPackage: new Map(),
          },
          baseline: baselineFor(),
          reportFileSystem: report.fileSystem,
        },
        { dev: false },
      ).apply(fixture.compiler);

      fixture.run();
      expect(
        (mode === "warn"
          ? fixture.compilation.warnings
          : fixture.compilation.errors
        ).map(({ name }) => name),
      ).toEqual([
        `NextWebpackBaselineUnlistedPackage${mode === "warn" ? "Warning" : "Error"}`,
        `NextWebpackBaselineUnlistedSummary${mode === "warn" ? "Warning" : "Error"}`,
      ]);
      expect(JSON.parse(report.writes[0] ?? "").unanalyzable).toEqual([
        {
          package: "unlisted-widget",
          entrypoint: "dist/index.js",
          cause: "NWB_WEBPACK_UNSUPPORTED",
        },
      ]);
    },
  );

  it.each(["warn", "error"] as const)(
    "report 작성 실패는 %s mode severity의 NWB_REPORT_IO_FAILED로 드러낸다",
    (mode) => {
      const report = createReportFileSystem({
        writeError: new Error("write sentinel"),
      });
      const fixture = createWebpackFixture({
        modules: [
          unlistedPageModule("dist/index.js", "const value = input?.value;"),
        ],
      });
      createWebpackPlugin(
        {
          config: {
            ...config,
            unlistedPackages: mode,
            policyByPackage: new Map(),
          },
          baseline: baselineFor(new Set(["optional-chaining"])),
          reportFileSystem: report.fileSystem,
        },
        { dev: false },
      ).apply(fixture.compiler);

      fixture.run();
      const diagnostics =
        mode === "warn"
          ? fixture.compilation.warnings
          : fixture.compilation.errors;
      expect(diagnostics[0]).toEqual(
        expect.objectContaining({ code: "NWB_REPORT_IO_FAILED" }),
      );
      expect(diagnostics.map(({ name }) => name).slice(1)).toEqual(
        mode === "warn"
          ? [
              "NextWebpackBaselineUnlistedPackageWarning",
              "NextWebpackBaselineUnlistedSummaryWarning",
            ]
          : [],
      );
    },
  );

  it("production ignore의 stale report 삭제 실패는 warning이고 build를 차단하지 않는다", () => {
    const removeError = new Error("remove sentinel") as NodeJS.ErrnoException;
    removeError.code = "EACCES";
    const report = createReportFileSystem({ removeError });
    const fixture = createWebpackFixture({
      modules: [
        unlistedPageModule("dist/index.js", "const value = input?.value;"),
      ],
    });
    createWebpackPlugin(
      {
        config: {
          ...config,
          unlistedPackages: "ignore",
          policyByPackage: new Map(),
        },
        baseline: baselineFor(),
        reportFileSystem: report.fileSystem,
      },
      { dev: false },
    ).apply(fixture.compiler);

    expect(fixture.run()).toEqual([]);
    expect(fixture.compilation.warnings).toEqual([
      expect.objectContaining({ code: "NWB_REPORT_IO_FAILED" }),
    ]);
    expect(fixture.modules[0]?.sourceReads).toBe(0);
  });

  it("등록 package의 오류와 waiver warning을 입력 순서와 무관하게 그대로 유지한다", () => {
    const characterizedConfig: NormalizedConfig = {
      ...config,
      waiversByPackage: new Map([
        [
          "legacy-widget",
          [
            {
              package: "legacy-widget",
              reason: "characterization waiver",
              allowedEntrypoints: ["dist/d-waived.js"],
            },
          ],
        ],
      ]),
    };
    const definitions = [
      pageModule("dist/e-nullish.js", "const value = input ?? fallback;"),
      pageModule("dist/c-invalid.js", "const = ;"),
      pageModule("dist/d-waived.js", "const value = input?.value;"),
      pageModule("dist/b-optional.js", "const value = input?.value;"),
      {
        ...pageModule("dist/a-unavailable.js", "const value = 1;"),
        sourceFailure: "missing-original-source" as const,
      },
    ];
    const run = (modules: readonly WebpackModuleDefinition[]) => {
      const fixture = createWebpackFixture({ modules });
      createWebpackPlugin(
        { config: characterizedConfig, baseline: baselineFor() },
        { dev: false },
      ).apply(fixture.compiler);
      fixture.run();
      return {
        errors: fixture.compilation.errors.map((error) => ({
          name: error.name,
          code: "code" in error ? error.code : undefined,
          message: error.message,
        })),
        warnings: fixture.compilation.warnings.map((warning) => ({
          name: warning.name,
          message: warning.message,
          stack: warning.stack,
        })),
      };
    };

    const expected = {
      errors: [
        {
          name: "NextWebpackBaselineError",
          code: "NWB_WEBPACK_UNSUPPORTED",
          message:
            "[NWB_WEBPACK_UNSUPPORTED] legacy-widget/dist/a-unavailable.js: loader 처리 후 JavaScript source를 읽을 수 없습니다.",
        },
        {
          name: "NextWebpackBaselineError",
          code: "NWB_SYNTAX_UNSUPPORTED",
          message:
            "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/b-optional.js: optional-chaining 구문은 설정된 browser baseline에서 지원되지 않습니다.",
        },
        {
          name: "NextWebpackBaselineError",
          code: "NWB_SYNTAX_PARSE_INCOMPLETE",
          message:
            "[NWB_SYNTAX_PARSE_INCOMPLETE] legacy-widget/dist/c-invalid.js: JavaScript source를 완전히 parse할 수 없습니다: JavaScript 문법이 올바르지 않습니다.",
        },
        {
          name: "NextWebpackBaselineError",
          code: "NWB_SYNTAX_UNSUPPORTED",
          message:
            "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/e-nullish.js: nullish-coalescing 구문은 설정된 browser baseline에서 지원되지 않습니다.",
        },
      ],
      warnings: [
        {
          name: "NextWebpackBaselineWaiverWarning",
          message: "waiver applied: legacy-widget/dist/d-waived.js",
          stack:
            "NextWebpackBaselineWaiverWarning: waiver applied: legacy-widget/dist/d-waived.js",
        },
      ],
    };

    expect(run(definitions)).toEqual(expected);
    expect(run([...definitions].reverse())).toEqual(expected);
  });

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

  it("query가 있는 resource도 query-free entrypoint의 exact waiver를 적용한다", () => {
    const waivedConfig: NormalizedConfig = {
      ...config,
      waiversByPackage: new Map([
        [
          "legacy-widget",
          [
            {
              package: "legacy-widget",
              reason: "query-free waiver",
              allowedEntrypoints: ["dist/query.js"],
            },
          ],
        ],
      ]),
    };
    const fixture = createWebpackFixture({
      modules: [
        pageModule(
          "dist/query.js?raw",
          "const value = input?.value ?? fallback;",
        ),
      ],
    });
    createWebpackPlugin(
      { config: waivedConfig, baseline: baselineFor() },
      { dev: false },
    ).apply(fixture.compiler);

    expect(errorRecords(fixture.run())).toEqual([]);
    expect(fixture.compilation.warnings.map(({ message }) => message)).toEqual([
      "waiver applied: legacy-widget/dist/query.js",
    ]);
  });

  it("resource query 내부의 가짜 node_modules 경계를 package 판정에서 제외한다", () => {
    const { errors } = runPlugin({
      definitions: [
        pageModule(
          "dist/query.js?source=/fake/node_modules/unlisted-widget/dist/index.js",
          "const value = input?.value;",
        ),
      ],
    });

    expect(errorRecords(errors)).toEqual([
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        message:
          "[NWB_SYNTAX_UNSUPPORTED] legacy-widget/dist/query.js: optional-chaining 구문은 설정된 browser baseline에서 지원되지 않습니다.",
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

  it("Next.js barrel 최적화 module은 source를 읽지 않고 검사에서 제외한다", () => {
    const { fixture, errors } = runPlugin({
      definitions: [
        {
          ...pageModule("dist/barrel.js", "const value = input?.value;"),
          matchResource: "__barrel_optimize__?names=LegacyButton",
        },
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
    { name: "condition name method 부재", conditionNameShape: "missing" },
    {
      name: "condition name method getter 예외",
      conditionNameShape: "getter-throws",
    },
    {
      name: "condition name method 호출 예외",
      conditionNameShape: "call-throws",
    },
    {
      name: "condition name method의 비문자열 반환값",
      conditionNameShape: "non-string",
    },
    { name: "module type getter 예외", typeShape: "getter-throws" },
  ] satisfies ReadonlyArray<{
    name: string;
    groupShape?: "name-getter-throws";
    entrypointsShape?: "get-throws" | "primitive-result";
    resourceShape?: "getter-throws";
    conditionNameShape?: WebpackModuleDefinition["conditionNameShape"];
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
          ...(shape.conditionNameShape === undefined
            ? {}
            : { conditionNameShape: shape.conditionNameShape }),
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
