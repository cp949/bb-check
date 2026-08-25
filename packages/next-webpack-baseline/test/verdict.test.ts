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
      expect(verdict.resource).toEqual({
        package: "legacy-widget",
        entrypoint: "dist/compat.cjs",
      });
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

  it.each([
    "../compat.cjs",
    "/dist/compat.cjs",
    "dist\\compat.cjs",
    "C:compat.cjs",
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
});
