import type { NormalizedConfig } from "./config.js";
import { isDownlevelPackage } from "./downlevel.js";
import {
  assertResourceShape,
  isProvenOrdinaryAppResource,
  resolvePackageResource,
} from "./package-name.js";
import type { PackageResource } from "./package-name.js";
import type { SyntaxAnalysis, SyntaxDiagnostic } from "./syntax.js";
import { validateWaivers } from "./waiver.js";

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

/** validateWaivers 이후에만 사용하는 exact matcher라 caller가 validation을 우회할 수 없다. */
const hasExactWaiver = (
  config: NormalizedConfig,
  resource: PackageResource,
): boolean =>
  (config.waiversByPackage.get(resource.package) ?? []).some((waiver) =>
    waiver.allowedEntrypoints.includes(resource.entrypoint),
  );

/** module resource, client graph, syntax 결과를 정책과 waiver에 따라 하나의 안정된 verdict로 결합한다. */
export const createVerdict = (input: CreateVerdictInput): ModuleVerdict => {
  validateWaivers(input.config.waiversByPackage);
  assertResourceShape(input.resource);
  if (isProvenOrdinaryAppResource(input.resource)) {
    return { status: "ignored", diagnostics: [] };
  }

  const resource: PackageResource = resolvePackageResource(input.resource);
  if (!input.isClientEntryReachable) {
    return { status: "ignored", diagnostics: [] };
  }
  if (!isDownlevelPackage(input.config, resource)) {
    return { status: "ignored", resource, diagnostics: [] };
  }

  const diagnostics = sortedDiagnostics(input.syntax.diagnostics);
  if (diagnostics.length === 0) {
    return { status: "pass", resource, diagnostics };
  }
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.code === "NWB_SYNTAX_PARSE_INCOMPLETE",
    )
  ) {
    return { status: "fail", resource, diagnostics };
  }
  if (hasExactWaiver(input.config, resource)) {
    return { status: "waived", resource, diagnostics };
  }
  return { status: "fail", resource, diagnostics };
};
