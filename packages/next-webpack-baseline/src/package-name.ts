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

const isAbsoluteResource = (resource: string): boolean =>
  posix.isAbsolute(resource) || win32.isAbsolute(resource);

const normalizedSegments = (resource: string): readonly string[] =>
  posix
    .normalize(resource.replaceAll("\\", "/"))
    .split("/")
    .filter((segment) => segment !== "");

/** npm의 실제 node_modules 경계를 path 문자열만으로 안전하게 복원한다. */
export const resolvePackageResource = (resource: string): PackageResource => {
  if (!isAbsoluteResource(resource)) return unresolved(resource);

  const segments = normalizedSegments(resource);
  let boundary = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === "node_modules") boundary = index;
  }
  if (boundary === -1) return unresolved(resource);

  // zip archive 내부 경로는 PnP virtual filesystem일 수 있어 host file 경계를 증명하지 못한다.
  if (segments.slice(0, boundary).some((segment) => segment.endsWith(".zip"))) {
    return unresolved(resource);
  }

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
