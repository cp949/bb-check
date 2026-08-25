import { parse } from "@babel/parser";
import type { BrowserBaseline, SyntaxFeature } from "./baseline.js";

const SYNTAX_FEATURES: readonly SyntaxFeature[] = [
  "optional-chaining",
  "nullish-coalescing",
  "class-properties",
  "private-methods",
  "logical-assignment-operators",
  "numeric-separator",
  "async-generator-functions",
  "object-rest-spread",
];

export interface SyntaxDiagnostic {
  readonly code: "NWB_SYNTAX_UNSUPPORTED" | "NWB_SYNTAX_PARSE_INCOMPLETE";
  readonly feature?: SyntaxFeature;
  readonly message: string;
}

export interface SyntaxAnalysis {
  readonly diagnostics: readonly SyntaxDiagnostic[];
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
  detected: Set<SyntaxFeature>,
): void => {
  switch (node.type) {
    case "OptionalMemberExpression":
    case "OptionalCallExpression":
      detected.add("optional-chaining");
      break;
    case "LogicalExpression":
      if (node.operator === "??") detected.add("nullish-coalescing");
      break;
    case "ClassProperty":
      detected.add("class-properties");
      break;
    // private field와 private method는 contract의 private-methods compat key를 공유한다.
    case "ClassPrivateProperty":
    case "ClassPrivateMethod":
      detected.add("private-methods");
      break;
    case "AssignmentExpression":
      if (
        node.operator === "&&=" ||
        node.operator === "||=" ||
        node.operator === "??="
      ) {
        detected.add("logical-assignment-operators");
      }
      break;
    case "NumericLiteral":
    case "BigIntLiteral":
      if (hasNumericSeparator(node)) detected.add("numeric-separator");
      break;
    case "RestElement":
      if (parent?.type === "ObjectPattern") {
        detected.add("object-rest-spread");
      }
      break;
    case "SpreadElement":
      if (parent?.type === "ObjectExpression") {
        detected.add("object-rest-spread");
      }
      break;
    default:
      break;
  }

  if (isAsyncGenerator(node)) detected.add("async-generator-functions");

  for (const value of Object.values(node)) {
    if (isAstNode(value)) {
      collectFromNode(value, node, detected);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) collectFromNode(item, node, detected);
      }
    }
  }
};

/** Babel AST에서 contract feature만 수집하며 결과 순서는 traversal에 의존하지 않는다. */
export const collectSyntaxFeatures = (
  ast: unknown,
): readonly SyntaxFeature[] => {
  if (!isAstNode(ast)) return [];
  const detected = new Set<SyntaxFeature>();
  collectFromNode(ast, undefined, detected);
  return SYNTAX_FEATURES.filter((feature) => detected.has(feature));
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

const parserIncomplete = (cause: unknown): SyntaxAnalysis => {
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  return {
    diagnostics: [
      {
        code: "NWB_SYNTAX_PARSE_INCOMPLETE",
        message: `JavaScript source를 완전히 parse할 수 없습니다${detail}`,
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

  return {
    diagnostics: findUnsupportedSyntax(
      collectSyntaxFeatures(ast),
      baseline,
    ).map((feature) => ({
      code: "NWB_SYNTAX_UNSUPPORTED",
      feature,
      message: `${feature} 구문은 설정된 browser baseline에서 지원되지 않습니다.`,
    })),
  };
};
