import type { NormalizedConfig } from "./config.js";
import { isDownlevelPackage } from "./downlevel.js";
import type { PackageResource } from "./package-name.js";
import { resolvePackageResource } from "./package-name.js";
import type { SyntaxAnalysis, SyntaxDiagnostic } from "./syntax.js";
import { findExactWaiver } from "./waiver.js";

export interface ModuleVerdict {
  readonly status: "ignored" | "pass" | "waived" | "fail";
  readonly resource?: PackageResource;
  readonly diagnostics: readonly SyntaxDiagnostic[];
}

export interface CreateVerdictInput {
  readonly config: NormalizedConfig;
  readonly resource: string;
  readonly syntax: SyntaxAnalysis;
  readonly isClientEntryReachable: boolean;
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
): readonly SyntaxDiagnostic[] => [...diagnostics].sort(compareDiagnostics);

/** module resource, client graph, syntax 결과를 정책과 waiver에 따라 하나의 안정된 verdict로 결합한다. */
export const createVerdict = (input: CreateVerdictInput): ModuleVerdict => {
  const resource = resolvePackageResource(input.resource);
  if (
    !isDownlevelPackage(input.config, resource) ||
    !input.isClientEntryReachable
  ) {
    return { status: "ignored", resource, diagnostics: [] };
  }

  const diagnostics = sortedDiagnostics(input.syntax.diagnostics);
  if (diagnostics.length === 0) {
    return { status: "pass", resource, diagnostics };
  }
  if (findExactWaiver(input.config.waiversByPackage, resource) !== undefined) {
    return { status: "waived", resource, diagnostics };
  }
  return { status: "fail", resource, diagnostics };
};
