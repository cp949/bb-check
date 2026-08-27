import type { NormalizedConfig } from "./config.js";
import type { PackageResource } from "./package-name.js";
import type { SyntaxAnalysis, SyntaxDiagnostic } from "./syntax.js";
import { hasExactWaiver, validateWaivers } from "./waiver.js";

export interface RegisteredModuleVerdict {
  readonly status: "pass" | "waived" | "fail";
  readonly resource: PackageResource;
  readonly diagnostics: readonly SyntaxDiagnostic[];
}

export interface CreateRegisteredVerdictInput {
  readonly config: NormalizedConfig;
  readonly resource: PackageResource;
  readonly syntax: SyntaxAnalysis;
}

const compareDiagnostics = (
  left: SyntaxDiagnostic,
  right: SyntaxDiagnostic,
): number => {
  const leftKey = `${left.code}\u0000${left.feature ?? ""}\u0000${left.message}`;
  const rightKey = `${right.code}\u0000${right.feature ?? ""}\u0000${right.message}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
};

const sortedDiagnostics = (
  diagnostics: readonly SyntaxDiagnostic[],
): readonly SyntaxDiagnostic[] =>
  [...diagnostics].sort(compareDiagnostics).map((diagnostic) =>
    diagnostic.feature === undefined
      ? { code: diagnostic.code, message: diagnostic.message }
      : {
          code: diagnostic.code,
          feature: diagnostic.feature,
          message: diagnostic.message,
        },
  );

/** 분류가 끝난 등록 package의 syntax와 exact waiver만 판정한다. */
export const createRegisteredVerdict = (
  input: CreateRegisteredVerdictInput,
): RegisteredModuleVerdict => {
  validateWaivers(input.config.waiversByPackage);
  const diagnostics = sortedDiagnostics(input.syntax.diagnostics);
  if (diagnostics.length === 0) {
    return { status: "pass", resource: input.resource, diagnostics };
  }
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.code === "NWB_SYNTAX_PARSE_INCOMPLETE",
    )
  ) {
    return { status: "fail", resource: input.resource, diagnostics };
  }
  if (hasExactWaiver(input.config.waiversByPackage, input.resource)) {
    return { status: "waived", resource: input.resource, diagnostics };
  }
  return { status: "fail", resource: input.resource, diagnostics };
};
