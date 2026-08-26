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
  resource.startsWith("\\\\");

const isWindowsDriveAbsolute = (resource: string): boolean =>
  /^[a-z]:[\\/]/iu.test(resource) && win32.isAbsolute(resource);

const usesWindowsSemantics = (resource: string): boolean =>
  isCurrentDriveRooted(resource) ||
  isWindowsDriveAbsolute(resource) ||
  isUncResource(resource);

interface UncRoot {
  readonly segmentCount: number;
}

const normalUncRoot = (resource: string): UncRoot | undefined => {
  if (!isUncResource(resource)) return undefined;
  const root = win32.parse(resource).root;
  const segments = root.split("\\").filter((segment) => segment !== "");
  if (
    segments.length !== 2 ||
    segments.some(
      (segment) => segment === "." || segment === ".." || segment === "?",
    )
  ) {
    return undefined;
  }
  return { segmentCount: segments.length };
};

const normalizedSegments = (resource: string): readonly string[] =>
  (usesWindowsSemantics(resource)
    ? win32.normalize(resource).replaceAll("\\", "/")
    : posix.normalize(resource)
  )
    .split("/")
    .filter((segment) => segment !== "");

const isCompleteUncResource = (resource: string): boolean =>
  normalUncRoot(resource) !== undefined;

const rootSegmentCount = (resource: string): number => {
  const uncRoot = normalUncRoot(resource);
  if (uncRoot !== undefined) return uncRoot.segmentCount;
  return isWindowsDriveAbsolute(resource) ? 1 : 0;
};

const hasContentBeyondRoot = (resource: string): boolean =>
  normalizedSegments(resource).length > rootSegmentCount(resource);

const isAbsoluteResource = (resource: string): boolean =>
  ((posix.isAbsolute(resource) && !isUncResource(resource)) ||
    isWindowsDriveAbsolute(resource) ||
    isCompleteUncResource(resource)) &&
  hasContentBeyondRoot(resource);

const hasOpaqueYarnPath = (resource: string): boolean => {
  const segments = normalizedSegments(resource).map((segment) =>
    segment.toLowerCase(),
  );
  return segments.some(
    (segment, index) =>
      segment.endsWith(".zip") ||
      (segment === ".yarn" && segments[index + 1] === "__virtual__"),
  );
};

const nodeModulesBoundary = (resource: string): number => {
  const segments = normalizedSegments(resource);
  let boundary = -1;
  const firstSearchIndex = rootSegmentCount(resource);
  for (let index = firstSearchIndex; index < segments.length; index += 1) {
    if (segments[index] === "node_modules") boundary = index;
  }
  return boundary;
};

/** resource가 node_modules package인 것처럼 보이는지, verdict의 unresolved 처리를 위해 보수적으로 확인한다. */
export const hasNodeModulesBoundaryClaim = (resource: string): boolean =>
  nodeModulesBoundary(resource) !== -1;

/**
 * Next.js barrel 최적화 proxy module의 condition resource인지 확인한다.
 * webpack NormalModule.nameForCondition()은 matchResource(`__barrel_optimize__?names=...`)를
 * 첫 query 앞에서 잘라 반환하므로 정확히 이 문자열만 매칭한다. proxy는 재노출 글루만 담고
 * 재노출 대상 package 파일은 별도 module로 게이트되므로 무시해도 게이트 우회가 생기지 않는다.
 */
export const isBarrelOptimizeResource = (resource: string): boolean =>
  resource === "__barrel_optimize__";

/** verdict의 early ignore 전에 절대 resource 형상과 비-opaque filesystem 경로를 보장한다. */
export const assertResourceShape = (resource: string): void => {
  if (!isAbsoluteResource(resource) || hasOpaqueYarnPath(resource)) {
    unresolved(resource);
  }
};

/** package 경계 주장이 없는 검증된 application resource만 verdict에서 무시할 수 있다. */
export const isProvenOrdinaryAppResource = (resource: string): boolean =>
  isAbsoluteResource(resource) &&
  !hasOpaqueYarnPath(resource) &&
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
