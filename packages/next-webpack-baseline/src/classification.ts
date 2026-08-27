import type { NormalizedConfig } from "./config.js";
import { isDownlevelPackage } from "./downlevel.js";
import {
  assertResourceShape,
  isBarrelOptimizeResource,
  isProvenOrdinaryAppResource,
  resolvePackageResource,
} from "./package-name.js";
import type { PackageResource } from "./package-name.js";

export type ModuleClassification =
  | { readonly kind: "ignored" }
  | { readonly kind: "registered"; readonly resource: PackageResource }
  | { readonly kind: "unlisted"; readonly resource: PackageResource };

export interface ClassifyModuleInput {
  readonly config: NormalizedConfig;
  readonly resource: string;
  readonly isClientEntryReachable: boolean;
}

/** resource와 Pages client 도달성만으로 syntax 분석 대상을 분류한다. */
export const classifyModule = (
  input: ClassifyModuleInput,
): ModuleClassification => {
  if (isBarrelOptimizeResource(input.resource)) return { kind: "ignored" };
  assertResourceShape(input.resource);
  if (isProvenOrdinaryAppResource(input.resource)) return { kind: "ignored" };

  const resource = resolvePackageResource(input.resource);
  if (!input.isClientEntryReachable) return { kind: "ignored" };
  return isDownlevelPackage(input.config, resource)
    ? { kind: "registered", resource }
    : { kind: "unlisted", resource };
};
