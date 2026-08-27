import { posix, win32 } from "node:path";
import {
  NEXT_WEBPACK_BASELINE_ERROR_CODES,
  NextWebpackBaselineError,
} from "./errors.js";
import type { PackageWaiver } from "./index.js";
import type { PackageResource } from "./package-name.js";

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

/** 모든 normalized waiver를 module 판단 전에 검증해 도달하지 않는 module도 fail-closed로 유지한다. */
export const validateWaivers = (
  waiversByPackage: ReadonlyMap<string, readonly PackageWaiver[]>,
): void => {
  for (const waivers of waiversByPackage.values()) {
    for (const waiver of waivers) {
      for (const entrypoint of waiver.allowedEntrypoints) {
        if (!isSafeEntrypoint(entrypoint)) invalidEntrypoint();
      }
    }
  }
};

/** validateWaivers 이후 package-relative exact entrypoint만 매칭한다. */
export const hasExactWaiver = (
  waiversByPackage: ReadonlyMap<string, readonly PackageWaiver[]>,
  resource: PackageResource,
): boolean =>
  (waiversByPackage.get(resource.package) ?? []).some((waiver) =>
    waiver.allowedEntrypoints.includes(resource.entrypoint),
  );
