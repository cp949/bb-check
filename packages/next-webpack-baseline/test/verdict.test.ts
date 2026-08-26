import { describe, expect, it } from "vitest";
import type { NormalizedConfig } from "../src/config.js";
import { NextWebpackBaselineError } from "../src/errors.js";
import type { SyntaxAnalysis } from "../src/syntax.js";
import { createVerdict } from "../src/verdict.js";

const resource = "/consumer/node_modules/legacy-widget/dist/compat.cjs";
const incompatible: SyntaxAnalysis = {
  diagnostics: [
    {
      code: "NWB_SYNTAX_UNSUPPORTED" as const,
      feature: "optional-chaining" as const,
      message: "optional chaining은 legacy browser에서 지원되지 않습니다.",
    },
  ],
};

const configFor = ({
  included,
  waivers = [],
}: {
  included: boolean;
  waivers?: readonly {
    package: string;
    reason: string;
    allowedEntrypoints: readonly string[];
  }[];
}): NormalizedConfig => ({
  projectDir: "/consumer",
  policyByPackage: new Map(
    included
      ? [["legacy-widget", { package: "legacy-widget", reason: "legacy" }]]
      : [],
  ),
  waiversByPackage: new Map(
    waivers.length === 0 ? [] : [["legacy-widget", waivers]],
  ),
});

describe("createVerdict", () => {
  it.each([
    {
      included: false,
      reachable: true,
      diagnostics: incompatible,
      waivers: [],
      status: "ignored",
    },
    {
      included: true,
      reachable: false,
      diagnostics: incompatible,
      waivers: [],
      status: "ignored",
    },
    {
      included: true,
      reachable: true,
      diagnostics: { diagnostics: [] },
      waivers: [],
      status: "pass",
    },
    {
      included: true,
      reachable: true,
      diagnostics: incompatible,
      waivers: [],
      status: "fail",
    },
    {
      included: true,
      reachable: true,
      diagnostics: incompatible,
      waivers: [
        {
          package: "legacy-widget",
          reason: "temporary compatibility exception",
          allowedEntrypoints: ["dist/compat.cjs"],
        },
      ],
      status: "waived",
    },
  ] satisfies ReadonlyArray<{
    included: boolean;
    reachable: boolean;
    diagnostics: SyntaxAnalysis;
    waivers: readonly {
      package: string;
      reason: string;
      allowedEntrypoints: readonly string[];
    }[];
    status: "ignored" | "pass" | "waived" | "fail";
  }>)(
    "정책 $included, client graph $reachable, syntax 행렬을 $status로 판정한다",
    ({ included, reachable, diagnostics, waivers, status }) => {
      const verdict = createVerdict({
        config: configFor({ included, waivers }),
        resource,
        syntax: diagnostics,
        isClientEntryReachable: reachable,
      });

      expect(verdict.status).toBe(status);
      expect(verdict.resource).toEqual(
        reachable
          ? { package: "legacy-widget", entrypoint: "dist/compat.cjs" }
          : undefined,
      );
      expect(verdict.diagnostics).toEqual(
        status === "ignored" ? [] : diagnostics.diagnostics,
      );
    },
  );

  it("prefix와 glob처럼 보이는 waiver를 정확한 entrypoint로 확장하지 않는다", () => {
    const verdict = createVerdict({
      config: configFor({
        included: true,
        waivers: [
          {
            package: "legacy-widget",
            reason: "near match only",
            allowedEntrypoints: ["dist/compat", "dist/*.cjs"],
          },
        ],
      }),
      resource,
      syntax: incompatible,
      isClientEntryReachable: true,
    });

    expect(verdict.status).toBe("fail");
  });

  it("parse-incomplete diagnostic은 정확한 waiver가 있어도 실패로 남긴다", () => {
    const verdict = createVerdict({
      config: configFor({
        included: true,
        waivers: [
          {
            package: "legacy-widget",
            reason: "syntax exception",
            allowedEntrypoints: ["dist/compat.cjs"],
          },
        ],
      }),
      resource,
      syntax: {
        diagnostics: [
          {
            code: "NWB_SYNTAX_UNSUPPORTED",
            feature: "optional-chaining",
            message: "unsupported",
          },
          {
            code: "NWB_SYNTAX_PARSE_INCOMPLETE",
            message: "parse incomplete",
          },
        ],
      },
      isClientEntryReachable: true,
    });

    expect(verdict.status).toBe("fail");
    expect(verdict.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "NWB_SYNTAX_PARSE_INCOMPLETE",
      "NWB_SYNTAX_UNSUPPORTED",
    ]);
  });

  it.each([
    "../compat.cjs",
    "/dist/compat.cjs",
    "dist\\compat.cjs",
    "C:compat.cjs",
    "./dist/compat.cjs",
    "dist//compat.cjs",
  ])(
    "unsafe waiver entrypoint %s를 NWB_WAIVER_INVALID로 fail-closed 한다",
    (entrypoint) => {
      expect(() =>
        createVerdict({
          config: configFor({
            included: true,
            waivers: [
              {
                package: "legacy-widget",
                reason: "unsafe waiver",
                allowedEntrypoints: [entrypoint],
              },
            ],
          }),
          resource,
          syntax: incompatible,
          isClientEntryReachable: true,
        }),
      ).toThrow(
        expect.objectContaining<Partial<NextWebpackBaselineError>>({
          code: "NWB_WAIVER_INVALID",
        }),
      );
    },
  );

  it.each([
    {
      name: "정책에 없는 package",
      included: false,
      reachable: true,
      syntax: incompatible,
    },
    {
      name: "client graph 밖 module",
      included: true,
      reachable: false,
      syntax: incompatible,
    },
    {
      name: "clean module",
      included: true,
      reachable: true,
      syntax: { diagnostics: [] },
    },
  ] satisfies ReadonlyArray<{
    name: string;
    included: boolean;
    reachable: boolean;
    syntax: SyntaxAnalysis;
  }>)(
    "unused package의 unsafe waiver도 $name 전에 fail-closed 한다",
    ({ included, reachable, syntax }) => {
      const config = configFor({ included });
      const unsafeWaiver = {
        package: "unused-widget",
        reason: "unsafe even when unused",
        allowedEntrypoints: ["../compat.cjs"],
      };
      const verdictConfig: NormalizedConfig = {
        ...config,
        waiversByPackage: new Map([["unused-widget", [unsafeWaiver]]]),
      };

      expect(() =>
        createVerdict({
          config: verdictConfig,
          resource,
          syntax,
          isClientEntryReachable: reachable,
        }),
      ).toThrow(
        expect.objectContaining<Partial<NextWebpackBaselineError>>({
          code: "NWB_WAIVER_INVALID",
        }),
      );
    },
  );

  it.each([
    "/consumer/src/application.js",
    "/consumer/src/__virtual__/application.js",
    "C:\\consumer\\src\\application.js",
    "\\\\server\\share\\consumer\\src\\application.js",
  ])("도달한 일반 application resource %s는 ignored 한다", (appResource) => {
    const verdict = createVerdict({
      config: configFor({ included: true }),
      resource: appResource,
      syntax: incompatible,
      isClientEntryReachable: true,
    });

    expect(verdict).toEqual({ status: "ignored", diagnostics: [] });
  });

  it("barrel 최적화 resource도 unsafe waiver를 ignore 전에 fail-closed 한다", () => {
    expect(() =>
      createVerdict({
        config: configFor({
          included: true,
          waivers: [
            {
              package: "legacy-widget",
              reason: "unsafe waiver",
              allowedEntrypoints: ["../compat.cjs"],
            },
          ],
        }),
        resource: "__barrel_optimize__",
        syntax: incompatible,
        isClientEntryReachable: true,
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_WAIVER_INVALID",
      }),
    );
  });

  it("Next.js barrel 최적화 condition resource는 도달 여부와 무관하게 ignored 한다", () => {
    for (const isClientEntryReachable of [true, false]) {
      const verdict = createVerdict({
        config: configFor({ included: true }),
        resource: "__barrel_optimize__",
        syntax: incompatible,
        isClientEntryReachable,
      });

      expect(verdict).toEqual({ status: "ignored", diagnostics: [] });
    }
  });

  it.each([
    "C:chunk.cjs",
    "relative/chunk.cjs",
    "",
    "\\consumer\\src\\application.js",
    "/consumer/.yarn/cache/legacy-widget-npm-1.0.0.ZIP/application.js",
    "/consumer/.yarn/__virtual__/legacy-widget/0/application.js",
    "__barrel_optimize__?names=LegacyButton",
    "__barrel_optimize__/index.js",
  ])(
    "malformed 또는 opaque resource %s는 도달 여부와 무관하게 unresolved 한다",
    (resource) => {
      for (const isClientEntryReachable of [true, false]) {
        expect(() =>
          createVerdict({
            config: configFor({ included: true }),
            resource,
            syntax: incompatible,
            isClientEntryReachable,
          }),
        ).toThrow(
          expect.objectContaining<Partial<NextWebpackBaselineError>>({
            code: "NWB_PACKAGE_PATH_UNRESOLVED",
          }),
        );
      }
    },
  );

  it("도달한 opaque node_modules claim은 unresolved 오류로 중단한다", () => {
    expect(() =>
      createVerdict({
        config: configFor({ included: true }),
        resource:
          "/consumer/.yarn/cache/legacy-widget-npm-1.0.0.ZIP/node_modules/legacy-widget/index.js",
        syntax: incompatible,
        isClientEntryReachable: true,
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_PACKAGE_PATH_UNRESOLVED",
      }),
    );
  });

  it.each([
    "/consumer/node_modules/legacy-widget",
    "/consumer/node_modules/@scope",
    "/consumer/node_modules/.invalid/index.js",
  ])(
    "unreachable malformed node_modules claim %s도 완전 해석 후 unresolved 한다",
    (resource) => {
      expect(() =>
        createVerdict({
          config: configFor({ included: true }),
          resource,
          syntax: incompatible,
          isClientEntryReachable: false,
        }),
      ).toThrow(
        expect.objectContaining<Partial<NextWebpackBaselineError>>({
          code: "NWB_PACKAGE_PATH_UNRESOLVED",
        }),
      );
    },
  );

  it("syntax diagnostics를 입력 순서와 무관하게 안정적으로 정렬한다", () => {
    const verdict = createVerdict({
      config: configFor({ included: true }),
      resource,
      syntax: {
        diagnostics: [
          {
            code: "NWB_SYNTAX_UNSUPPORTED",
            feature: "private-methods",
            message: "private method",
          },
          {
            code: "NWB_SYNTAX_PARSE_INCOMPLETE",
            message: "parse incomplete",
          },
          {
            code: "NWB_SYNTAX_UNSUPPORTED",
            feature: "optional-chaining",
            message: "optional chaining",
          },
        ],
      },
      isClientEntryReachable: true,
    });

    expect(verdict.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "NWB_SYNTAX_PARSE_INCOMPLETE",
      "NWB_SYNTAX_UNSUPPORTED",
      "NWB_SYNTAX_UNSUPPORTED",
    ]);
    expect(verdict.diagnostics.map((diagnostic) => diagnostic.feature)).toEqual(
      [undefined, "optional-chaining", "private-methods"],
    );
  });

  it("verdict diagnostics를 input array와 record mutation에서 분리한다", () => {
    const diagnostic = {
      code: "NWB_SYNTAX_UNSUPPORTED" as const,
      feature: "optional-chaining" as const,
      message: "initial message",
    };
    const diagnostics = [diagnostic];
    const verdict = createVerdict({
      config: configFor({ included: true }),
      resource,
      syntax: { diagnostics },
      isClientEntryReachable: true,
    });

    diagnostic.message = "mutated message";
    diagnostics.length = 0;

    expect(verdict.diagnostics).toEqual([
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        feature: "optional-chaining",
        message: "initial message",
      },
    ]);
  });
});
