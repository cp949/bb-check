import { describe, expect, it } from "vitest";
import type { NormalizedConfig } from "../src/config.js";
import { NextWebpackBaselineError } from "../src/errors.js";
import type { PackageResource } from "../src/package-name.js";
import type { SyntaxAnalysis } from "../src/syntax.js";
import { createRegisteredVerdict } from "../src/verdict.js";

const resource: PackageResource = {
  package: "legacy-widget",
  entrypoint: "dist/compat.cjs",
};
const incompatible: SyntaxAnalysis = {
  occurrences: [{ feature: "optional-chaining", count: 1 }],
  diagnostics: [
    {
      code: "NWB_SYNTAX_UNSUPPORTED",
      feature: "optional-chaining",
      message: "optional chaining은 legacy browser에서 지원되지 않습니다.",
    },
  ],
};

const configFor = (
  waivers: readonly {
    package: string;
    reason: string;
    allowedEntrypoints: readonly string[];
  }[] = [],
): NormalizedConfig => ({
  projectDir: "/consumer",
  unlistedPackages: "warn",
  policyByPackage: new Map([
    ["legacy-widget", { package: "legacy-widget", reason: "legacy" }],
  ]),
  waiversByPackage: new Map(
    waivers.length === 0 ? [] : [["legacy-widget", waivers]],
  ),
});

describe("createRegisteredVerdict", () => {
  it.each([
    {
      name: "clean",
      syntax: { diagnostics: [], occurrences: [] },
      waivers: [],
      status: "pass",
    },
    {
      name: "unsupported",
      syntax: incompatible,
      waivers: [],
      status: "fail",
    },
    {
      name: "exact waiver",
      syntax: incompatible,
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
    name: string;
    syntax: SyntaxAnalysis;
    waivers: readonly {
      package: string;
      reason: string;
      allowedEntrypoints: readonly string[];
    }[];
    status: "pass" | "waived" | "fail";
  }>)("$name syntax를 $status로 판정한다", ({ syntax, waivers, status }) => {
    const verdict = createRegisteredVerdict({
      config: configFor(waivers),
      resource,
      syntax,
    });

    expect(verdict).toEqual({
      status,
      resource,
      diagnostics: syntax.diagnostics,
    });
  });

  it("prefix와 glob처럼 보이는 waiver를 exact entrypoint로 확장하지 않는다", () => {
    const verdict = createRegisteredVerdict({
      config: configFor([
        {
          package: "legacy-widget",
          reason: "near match only",
          allowedEntrypoints: ["dist/compat", "dist/*.cjs"],
        },
      ]),
      resource,
      syntax: incompatible,
    });

    expect(verdict.status).toBe("fail");
  });

  it("parse-incomplete는 exact waiver가 있어도 fail로 남긴다", () => {
    const verdict = createRegisteredVerdict({
      config: configFor([
        {
          package: "legacy-widget",
          reason: "syntax exception",
          allowedEntrypoints: ["dist/compat.cjs"],
        },
      ]),
      resource,
      syntax: {
        occurrences: [],
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
    });

    expect(verdict.status).toBe("fail");
    expect(verdict.diagnostics.map(({ code }) => code)).toEqual([
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
  ])("unsafe waiver entrypoint %s를 fail-closed 한다", (entrypoint) => {
    expect(() =>
      createRegisteredVerdict({
        config: configFor([
          {
            package: "legacy-widget",
            reason: "unsafe waiver",
            allowedEntrypoints: [entrypoint],
          },
        ]),
        resource,
        syntax: incompatible,
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_WAIVER_INVALID",
      }),
    );
  });

  it("다른 package의 unsafe waiver도 verdict 전에 fail-closed 한다", () => {
    const unsafeConfig: NormalizedConfig = {
      ...configFor(),
      waiversByPackage: new Map([
        [
          "unused-widget",
          [
            {
              package: "unused-widget",
              reason: "unsafe even when unused",
              allowedEntrypoints: ["../compat.cjs"],
            },
          ],
        ],
      ]),
    };

    expect(() =>
      createRegisteredVerdict({
        config: unsafeConfig,
        resource,
        syntax: { diagnostics: [], occurrences: [] },
      }),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_WAIVER_INVALID",
      }),
    );
  });

  it("diagnostics를 입력 순서와 mutation에서 분리해 안정적으로 정렬한다", () => {
    const privateMethod = {
      code: "NWB_SYNTAX_UNSUPPORTED" as const,
      feature: "private-methods" as const,
      message: "private method",
    };
    const diagnostics = [
      privateMethod,
      {
        code: "NWB_SYNTAX_PARSE_INCOMPLETE" as const,
        message: "parse incomplete",
      },
      {
        code: "NWB_SYNTAX_UNSUPPORTED" as const,
        feature: "optional-chaining" as const,
        message: "optional chaining",
      },
    ];
    const verdict = createRegisteredVerdict({
      config: configFor(),
      resource,
      syntax: { diagnostics, occurrences: [] },
    });

    privateMethod.message = "mutated";
    diagnostics.length = 0;
    expect(verdict.diagnostics).toEqual([
      { code: "NWB_SYNTAX_PARSE_INCOMPLETE", message: "parse incomplete" },
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        feature: "optional-chaining",
        message: "optional chaining",
      },
      {
        code: "NWB_SYNTAX_UNSUPPORTED",
        feature: "private-methods",
        message: "private method",
      },
    ]);
  });
});
