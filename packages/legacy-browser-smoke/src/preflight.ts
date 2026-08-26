import { isAbsolute, join } from "node:path";
import {
  chromiumRevision,
  chromiumVersion,
  type BrowserRegistryEntry,
} from "./baseline.js";
import { LegacyBrowserSmokeError } from "./errors.js";

export interface ChromiumExecutable {
  readonly path: string;
  readonly revision: typeof chromiumRevision;
  readonly version: typeof chromiumVersion;
}

export interface EnsureChromiumOptions {
  readonly executablePath?: string;
  readonly cacheDirectory?: string;
  readonly signal?: AbortSignal;
  readonly versionTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly lockPollIntervalMs?: number;
}

interface ExecutableFileSystem {
  lstat(path: string): Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
    readonly mode: number;
  }>;
  realpath(path: string): Promise<string>;
}

interface VersionOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

const aborted = (signal: AbortSignal, cause?: unknown): never => {
  throw new LegacyBrowserSmokeError("LBS_ABORTED", "operation was aborted", {
    cause: cause ?? signal.reason,
  });
};

const executableInvalid = (cause?: unknown): never => {
  throw new LegacyBrowserSmokeError(
    "LBS_BROWSER_EXECUTABLE_INVALID",
    "Chromium executable is invalid",
    cause === undefined ? undefined : { cause },
  );
};

export const assertSupportedNode = (nodeVersion: string): void => {
  const majorText = nodeVersion.split(".", 1)[0];
  const major = Number.parseInt(majorText ?? "", 10);
  if (!Number.isSafeInteger(major) || major < 22) {
    throw new LegacyBrowserSmokeError(
      "LBS_NODE_UNSUPPORTED",
      "Chromium provisioning requires Node.js 22 or newer",
    );
  }
};

export const resolveCacheRoot = (
  cacheDirectory: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  if (cacheDirectory !== undefined) {
    if (!isAbsolute(cacheDirectory)) {
      throw new LegacyBrowserSmokeError(
        "LBS_CACHE_IO",
        "cacheDirectory must be absolute",
      );
    }
    return cacheDirectory;
  }
  const xdg = environment.XDG_CACHE_HOME;
  if (xdg !== undefined && isAbsolute(xdg)) return xdg;
  const home = environment.HOME;
  if (home === undefined || !isAbsolute(home)) {
    throw new LegacyBrowserSmokeError(
      "LBS_CACHE_IO",
      "an absolute HOME is required when no cache directory is configured",
    );
  }
  return join(home, ".cache");
};

export const validateExplicitExecutable = async (
  executablePath: string,
  fs: ExecutableFileSystem,
  runVersion: (
    executablePath: string,
    options: VersionOptions,
  ) => Promise<string>,
  options: VersionOptions,
): Promise<ChromiumExecutable> => {
  if (!isAbsolute(executablePath)) executableInvalid();
  const resolvedPath = await (async (): Promise<string> => {
    try {
      const source = await fs.lstat(executablePath);
      if (
        source.isSymbolicLink() ||
        !source.isFile() ||
        (source.mode & 0o111) === 0
      ) {
        executableInvalid();
      }
      const realPath = await fs.realpath(executablePath);
      const resolved = await fs.lstat(realPath);
      if (
        resolved.isSymbolicLink() ||
        !resolved.isFile() ||
        (resolved.mode & 0o111) === 0
      ) {
        executableInvalid();
      }
      return realPath;
    } catch (error) {
      if (error instanceof LegacyBrowserSmokeError) throw error;
      if (options.signal.aborted) aborted(options.signal, error);
      return executableInvalid(error);
    }
  })();

  const version = await (async (): Promise<string> => {
    try {
      return await runVersion(resolvedPath, options);
    } catch (error) {
      if (options.signal.aborted) aborted(options.signal, error);
      return executableInvalid(error);
    }
  })();
  if (typeof version !== "string") {
    throw new TypeError("version adapter must return a string");
  }
  if (version !== chromiumVersion) {
    throw new LegacyBrowserSmokeError(
      "LBS_BROWSER_VERSION_MISMATCH",
      "Chromium executable version does not match the registry",
    );
  }
  return Object.freeze({
    path: resolvedPath,
    revision: chromiumRevision,
    version: chromiumVersion,
  });
};

export const toChromiumExecutable = (
  path: string,
  entry: BrowserRegistryEntry,
): ChromiumExecutable =>
  Object.freeze({ path, revision: entry.revision, version: entry.version });
