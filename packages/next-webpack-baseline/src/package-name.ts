import { posix, win32 } from "node:path";
import {
  NEXT_WEBPACK_BASELINE_ERROR_CODES,
  NextWebpackBaselineError,
} from "./errors.js";

export interface PackageResource {
  readonly package: string;
  readonly entrypoint: string;
}

const packageSegment = /^[a-z0-9][a-z0-9._-]*$/u;
const scopeSegment = /^@[a-z0-9][a-z0-9._-]*$/u;

const unresolved = (resource: string): never => {
  const error = new NextWebpackBaselineError(
    NEXT_WEBPACK_BASELINE_ERROR_CODES.PACKAGE_PATH_UNRESOLVED,
    "npm package 경계를 파일 경로만으로 확인할 수 없습니다.",
  );
  Object.defineProperty(error, "detail", {
    value: { resource },
    enumerable: false,
  });
  throw error;
};

const isCurrentDriveRooted = (resource: string): boolean =>
  resource.startsWith("\\") && !resource.startsWith("\\\\");

const isUncResource = (resource: string): boolean =>
  resource.startsWith("\\\\") || resource.startsWith("//");

const isWindowsDriveAbsolute = (resource: string): boolean =>
  /^[a-z]:[\\/]/iu.test(resource) && win32.isAbsolute(resource);

const usesWindowsSemantics = (resource: string): boolean =>
  isCurrentDriveRooted(resource) ||
  isWindowsDriveAbsolute(resource) ||
  isUncResource(resource);

const normalizedSegments = (resource: string): readonly string[] =>
  (usesWindowsSemantics(resource)
    ? win32.normalize(resource).replaceAll("\\", "/")
    : posix.normalize(resource)
  )
    .split("/")
    .filter((segment) => segment !== "");

const isCompleteUncResource = (resource: string): boolean =>
  isUncResource(resource) && normalizedSegments(resource).length >= 2;

const isAbsoluteResource = (resource: string): boolean =>
  (posix.isAbsolute(resource) && !isUncResource(resource)) ||
  isWindowsDriveAbsolute(resource) ||
  isCompleteUncResource(resource);

const hasOpaqueZipSegment = (resource: string): boolean =>
  normalizedSegments(resource).some((segment) =>
    segment.toLowerCase().endsWith(".zip"),
  );

const nodeModulesBoundary = (resource: string): number => {
  const segments = normalizedSegments(resource);
  let boundary = -1;
  const firstSearchIndex = isUncResource(resource) ? 2 : 0;
  for (let index = firstSearchIndex; index < segments.length; index += 1) {
    if (segments[index] === "node_modules") boundary = index;
  }
  return boundary;
};

/** resource가 node_modules package인 것처럼 보이는지, verdict의 unresolved 처리를 위해 보수적으로 확인한다. */
export const hasNodeModulesBoundaryClaim = (resource: string): boolean =>
  nodeModulesBoundary(resource) !== -1;

/** verdict의 early ignore 전에 절대 resource 형상과 비-opaque filesystem 경로를 보장한다. */
export const assertResourceShape = (resource: string): void => {
  if (!isAbsoluteResource(resource) || hasOpaqueZipSegment(resource)) {
    unresolved(resource);
  }
};

/** package 경계 주장이 없는 검증된 application resource만 verdict에서 무시할 수 있다. */
export const isProvenOrdinaryAppResource = (resource: string): boolean =>
  isAbsoluteResource(resource) &&
  !hasOpaqueZipSegment(resource) &&
  !hasNodeModulesBoundaryClaim(resource);

/** npm의 실제 node_modules 경계를 path 문자열만으로 안전하게 복원한다. */
export const resolvePackageResource = (resource: string): PackageResource => {
  assertResourceShape(resource);

  const segments = normalizedSegments(resource);
  const boundary = nodeModulesBoundary(resource);
  if (boundary === -1) return unresolved(resource);

  const first = segments[boundary + 1];
  if (first === undefined) return unresolved(resource);

  let packageName: string;
  let entrypointStart: number;
  if (scopeSegment.test(first)) {
    const second = segments[boundary + 2];
    if (second === undefined || !packageSegment.test(second)) {
      return unresolved(resource);
    }
    packageName = `${first}/${second}`;
    entrypointStart = boundary + 3;
  } else {
    if (!packageSegment.test(first)) return unresolved(resource);
    packageName = first;
    entrypointStart = boundary + 2;
  }

  const entrypoint = segments.slice(entrypointStart).join("/");
  if (entrypoint === "") return unresolved(resource);
  return { package: packageName, entrypoint };
};
