import { parse } from "@babel/parser";
import type { BrowserBaseline, SyntaxFeature } from "./baseline.js";

export const SYNTAX_FEATURES: readonly SyntaxFeature[] = [
  "optional-chaining",
  "nullish-coalescing",
  "class-properties",
  "private-methods",
  "logical-assignment-operators",
  "numeric-separator",
  "async-generator-functions",
  "object-rest-spread",
];

export const SYNTAX_FEATURE_METADATA = {
  "optional-chaining": { reasonLabel: "?." },
  "nullish-coalescing": { reasonLabel: "??" },
  "class-properties": { reasonLabel: "클래스 필드" },
  "private-methods": { reasonLabel: "#메서드" },
  "logical-assignment-operators": { reasonLabel: "논리 할당 연산자" },
  "numeric-separator": { reasonLabel: "숫자 구분자" },
  "async-generator-functions": { reasonLabel: "async generator" },
  "object-rest-spread": { reasonLabel: "object rest/spread" },
} satisfies Readonly<Record<SyntaxFeature, { readonly reasonLabel: string }>>;

export interface SyntaxDiagnostic {
  readonly code: "NWB_SYNTAX_UNSUPPORTED" | "NWB_SYNTAX_PARSE_INCOMPLETE";
  readonly feature?: SyntaxFeature;
  readonly message: string;
}

export interface SyntaxAnalysis {
  readonly diagnostics: readonly SyntaxDiagnostic[];
  readonly occurrences: readonly SyntaxOccurrence[];
}

export interface SyntaxOccurrence {
  readonly feature: SyntaxFeature;
  readonly count: number;
}

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const hasNumericSeparator = (node: AstNode): boolean => {
  const extra = node.extra;
  return (
    typeof extra === "object" &&
    extra !== null &&
    "raw" in extra &&
    typeof extra.raw === "string" &&
    extra.raw.includes("_")
  );
};

const isAsyncGenerator = (node: AstNode): boolean =>
  node.async === true && node.generator === true;

const collectFromNode = (
  node: AstNode,
  parent: AstNode | undefined,
  counts: Map<SyntaxFeature, number>,
): void => {
  const increment = (feature: SyntaxFeature): void => {
    counts.set(feature, (counts.get(feature) ?? 0) + 1);
  };
  switch (node.type) {
    case "OptionalMemberExpression":
    case "OptionalCallExpression":
      increment("optional-chaining");
      break;
    case "LogicalExpression":
      if (node.operator === "??") increment("nullish-coalescing");
      break;
    case "ClassProperty":
      increment("class-properties");
      break;
    // private field는 public/static field와 같은 class-properties contract를 사용한다.
    case "ClassPrivateProperty":
      increment("class-properties");
      break;
    case "ClassPrivateMethod":
      increment("private-methods");
      break;
    case "AssignmentExpression":
      if (
        node.operator === "&&=" ||
        node.operator === "||=" ||
        node.operator === "??="
      ) {
        increment("logical-assignment-operators");
      }
      break;
    case "NumericLiteral":
    case "BigIntLiteral":
      if (hasNumericSeparator(node)) increment("numeric-separator");
      break;
    case "RestElement":
      if (parent?.type === "ObjectPattern") {
        increment("object-rest-spread");
      }
      break;
    case "SpreadElement":
      if (parent?.type === "ObjectExpression") {
        increment("object-rest-spread");
      }
      break;
    default:
      break;
  }

  if (isAsyncGenerator(node)) increment("async-generator-functions");

  for (const value of Object.values(node)) {
    if (isAstNode(value)) {
      collectFromNode(value, node, counts);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) collectFromNode(item, node, counts);
      }
    }
  }
};

/** Babel AST에서 contract feature만 수집하며 결과 순서는 traversal에 의존하지 않는다. */
export const collectSyntaxFeatures = (ast: unknown): readonly SyntaxFeature[] =>
  collectSyntaxOccurrences(ast).map(({ feature }) => feature);

/** Babel AST를 한 번 순회해 contract feature의 실제 출현 횟수를 센다. */
export const collectSyntaxOccurrences = (
  ast: unknown,
): readonly SyntaxOccurrence[] => {
  if (!isAstNode(ast)) return [];
  const counts = new Map<SyntaxFeature, number>();
  collectFromNode(ast, undefined, counts);
  return SYNTAX_FEATURES.flatMap((feature) => {
    const count = counts.get(feature);
    return count === undefined ? [] : [{ feature, count }];
  });
};

/** Baseline 지원 여부 조회는 AST 순회와 분리하여 parser fixture 없이 사용할 수 있다. */
export const findUnsupportedSyntax = (
  features: readonly SyntaxFeature[],
  baseline: BrowserBaseline,
): readonly SyntaxFeature[] => {
  const detected = new Set(features);
  return SYNTAX_FEATURES.filter(
    (feature) =>
      detected.has(feature) && baseline.unsupportedSyntax.has(feature),
  );
};

const isMissingOneOfPlugins = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reasonCode" in cause &&
  cause.reasonCode === "MissingOneOfPlugins";

const parserIncomplete = (cause: unknown): SyntaxAnalysis => {
  const category = isMissingOneOfPlugins(cause)
    ? "지원하지 않는 parser mode가 남아 있습니다."
    : "JavaScript 문법이 올바르지 않습니다.";
  return {
    occurrences: [],
    diagnostics: [
      {
        code: "NWB_SYNTAX_PARSE_INCOMPLETE",
        message: `JavaScript source를 완전히 parse할 수 없습니다: ${category}`,
      },
    ],
  };
};

export const analyzeSyntax = (
  source: string,
  baseline: BrowserBaseline,
): SyntaxAnalysis => {
  let ast: unknown;
  try {
    ast = parse(source, { sourceType: "unambiguous" });
  } catch (cause) {
    return parserIncomplete(cause);
  }

  const occurrences = collectSyntaxOccurrences(ast).filter(({ feature }) =>
    baseline.unsupportedSyntax.has(feature),
  );
  return {
    occurrences,
    diagnostics: occurrences.map(({ feature }) => ({
      code: "NWB_SYNTAX_UNSUPPORTED",
      feature,
      message: `${feature} 구문은 설정된 browser baseline에서 지원되지 않습니다.`,
    })),
  };
};
