import { describe, expect, it } from "vitest";
import type { BrowserBaseline, SyntaxFeature } from "../src/baseline.js";
import { analyzeSyntax } from "../src/syntax.js";

const baselineFor = (
  unsupportedSyntax: readonly SyntaxFeature[],
): BrowserBaseline => ({
  targets: ["chrome 75", "firefox 68"],
  unsupportedSyntax: new Set(unsupportedSyntax),
});

describe("analyzeSyntax", () => {
  it.each([
    {
      feature: "optional-chaining",
      source: "const name = account?.profile?.name;",
    },
    {
      feature: "optional-chaining",
      source: "const result = load?.();",
    },
    {
      feature: "nullish-coalescing",
      source: 'const locale = requestedLocale ?? "ko-KR";',
    },
    {
      feature: "class-properties",
      source: "class Counter { count = 0; }",
    },
    {
      feature: "class-properties",
      source: 'class Vault { #token = "secret"; }',
    },
    {
      feature: "class-properties",
      source: "class Registry { static #instance = new Registry(); }",
    },
    {
      feature: "private-methods",
      source: "class Vault { #readToken() { return \"secret\"; } }",
    },
    {
      feature: "class-properties",
      source: "class Registry { static instance = new Registry(); }",
    },
    {
      feature: "logical-assignment-operators",
      source: "options.enabled ??= true;",
    },
    {
      feature: "logical-assignment-operators",
      source: "options.enabled &&= isEnabled();",
    },
    {
      feature: "logical-assignment-operators",
      source: "options.enabled ||= true;",
    },
    {
      feature: "numeric-separator",
      source: "const annualBudget = 1_000_000;",
    },
    {
      feature: "numeric-separator",
      source: "const identifier = 1_000n;",
    },
    {
      feature: "async-generator-functions",
      source: "async function* pages() { yield 1; }",
    },
    {
      feature: "object-rest-spread",
      source: "const { id, ...rest } = record;",
    },
    {
      feature: "object-rest-spread",
      source: "const copy = { ...record };",
    },
  ] satisfies ReadonlyArray<{ feature: SyntaxFeature; source: string }>)(
    "$feature 구문을 legacy target의 NWB_SYNTAX_UNSUPPORTED로 보고한다",
    ({ feature, source }) => {
      const analysis = analyzeSyntax(source, baselineFor([feature]));

      expect(analysis.diagnostics).toEqual([
        {
          code: "NWB_SYNTAX_UNSUPPORTED",
          feature,
          message: `${feature} 구문은 설정된 browser baseline에서 지원되지 않습니다.`,
        },
      ]);
    },
  );

  it("downlevel된 ES5 source는 지원하지 않는 구문이 없어 clean으로 판정한다", () => {
    const analysis = analyzeSyntax(
      "var count = 0; function increment() { count = count + 1; return count; }",
      baselineFor(["optional-chaining"]),
    );

    expect(analysis.diagnostics).toEqual([]);
  });

  it.each([
    "const [first, ...remaining] = values;",
    "const copy = [...values];",
    "class Example { run() {} static create() {} }",
  ])("object rest/spread 및 class property가 아닌 source는 clean으로 판정한다", (source) => {
    const analysis = analyzeSyntax(
      source,
      baselineFor(["object-rest-spread", "class-properties"]),
    );

    expect(analysis.diagnostics).toEqual([]);
  });

  it("여러 feature diagnostic을 AST 순회 순서와 무관하게 안정적으로 정렬한다", () => {
    const analysis = analyzeSyntax(
      'class Vault { #token() { return account?.token ?? "none"; } }',
      baselineFor([
        "private-methods",
        "nullish-coalescing",
        "optional-chaining",
      ]),
    );

    expect(
      analysis.diagnostics.map((diagnostic) => diagnostic.feature),
    ).toEqual(["optional-chaining", "nullish-coalescing", "private-methods"]);
  });

  it.each([
    {
      name: "잔류 TypeScript",
      source: "const score: number = 1;",
      message:
        "JavaScript source를 완전히 parse할 수 없습니다: JavaScript 문법이 올바르지 않습니다.",
    },
    {
      name: "잔류 JSX",
      source: "const node = <main />;",
      message:
        "JavaScript source를 완전히 parse할 수 없습니다: 지원하지 않는 parser mode가 남아 있습니다.",
    },
    {
      name: "손상된 JavaScript",
      source: "const = ;",
      message:
        "JavaScript source를 완전히 parse할 수 없습니다: JavaScript 문법이 올바르지 않습니다.",
    },
    {
      name: "중복 private identifier",
      source: "class Vault { #consumerSecret; #consumerSecret; }",
      message:
        "JavaScript source를 완전히 parse할 수 없습니다: JavaScript 문법이 올바르지 않습니다.",
    },
  ])(
    "$name source는 NWB_SYNTAX_PARSE_INCOMPLETE의 안전한 category로 중단한다",
    ({ source, message }) => {
      const analysis = analyzeSyntax(
        source,
        baselineFor(["optional-chaining"]),
      );

      expect(analysis.diagnostics).toEqual([
        {
          code: "NWB_SYNTAX_PARSE_INCOMPLETE",
          message,
        },
      ]);
      expect(analysis.diagnostics[0]?.message).not.toContain("consumerSecret");
    },
  );
});
