import type { NormalizedConfig } from "./config.js";
import type { PackageResource } from "./package-name.js";

/** 설정 policy에 명시된 package만 downlevel 구문 검사의 대상이다. */
export const isDownlevelPackage = (
  config: NormalizedConfig,
  resource: PackageResource,
): boolean => config.policyByPackage.has(resource.package);
