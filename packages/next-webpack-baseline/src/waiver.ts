import { posix, win32 } from "node:path";
import {
  NEXT_WEBPACK_BASELINE_ERROR_CODES,
  NextWebpackBaselineError,
} from "./errors.js";
import type { PackageResource } from "./package-name.js";
import type { PackageWaiver } from "./index.js";

const invalidEntrypoint = (): never => {
  throw new NextWebpackBaselineError(
    NEXT_WEBPACK_BASELINE_ERROR_CODES.WAIVER_INVALID,
    "waiver entrypoint는 안전한 package-relative 경로여야 합니다.",
  );
};

const isSafeEntrypoint = (entrypoint: string): boolean => {
  if (entrypoint === "" || entrypoint.trim() !== entrypoint) return false;
  if (entrypoint.includes("\\")) return false;
  if (posix.isAbsolute(entrypoint) || win32.isAbsolute(entrypoint))
    return false;
  if (/^[a-z]:/iu.test(entrypoint)) return false;
  if (entrypoint === "." || entrypoint === "..") return false;
  if (
    entrypoint.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return false;
  }
  return posix.normalize(entrypoint) === entrypoint;
};

/** waiver는 package와 완전한 package-relative entrypoint가 모두 같을 때만 찾는다. */
export const findExactWaiver = (
  waiversByPackage: ReadonlyMap<string, readonly PackageWaiver[]>,
  resource: PackageResource,
): PackageWaiver | undefined => {
  const waivers = waiversByPackage.get(resource.package) ?? [];
  const matches: PackageWaiver[] = [];
  for (const waiver of waivers) {
    for (const entrypoint of waiver.allowedEntrypoints) {
      if (!isSafeEntrypoint(entrypoint)) invalidEntrypoint();
      if (entrypoint === resource.entrypoint) matches.push(waiver);
    }
  }
  return matches.sort((left, right) => {
    if (left.reason < right.reason) return -1;
    if (left.reason > right.reason) return 1;
    return 0;
  })[0];
};
