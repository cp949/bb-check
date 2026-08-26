import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import * as nodeFs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { platform as nodePlatform, arch as nodeArch } from "node:process";
import { fileURLToPath } from "node:url";
import {
  openPromise as openZip,
  type Entry as YauzlEntry,
  type ZipFile,
} from "yauzl";
import type { BrowserRegistryEntry } from "./baseline.js";
import { LegacyBrowserSmokeError } from "./errors.js";
import { lookupBrowserRegistry } from "./registry.js";
import type { ChromiumExecutable, EnsureChromiumOptions } from "./preflight.js";
import {
  assertSupportedNode,
  resolveCacheRoot,
  toChromiumExecutable,
  validateExplicitExecutable,
} from "./preflight.js";

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<
    Record<string, string | readonly string[] | undefined>
  >;
  readonly body: AsyncIterable<Uint8Array>;
  dispose(): Promise<void>;
}

export interface HttpAdapter {
  request(url: string, signal: AbortSignal): Promise<HttpResponse>;
}

export type ArchiveEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "device"
  | "special"
  | "unknown";

export interface ArchiveEntry {
  readonly path: string;
  readonly kind: ArchiveEntryKind;
  readonly mode?: number;
}

export interface ArchiveHandle {
  readonly entries: readonly ArchiveEntry[];
  extract(
    entry: ArchiveEntry,
    destination: string,
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface ArchiveAdapter {
  open(archivePath: string, signal: AbortSignal): Promise<ArchiveHandle>;
}

export interface FileSystemAdapter {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  mkdir(
    path: string,
    options?: { recursive?: boolean; mode?: number },
  ): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  rm(
    path: string,
    options: { recursive: boolean; force: boolean },
  ): Promise<void>;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readChunks(path: string): AsyncIterable<Uint8Array>;
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

export interface ProcessIdentityAdapter {
  current(): Promise<{ readonly pid: number; readonly startTime: string }>;
  lookup(
    pid: number,
  ): Promise<
    | { readonly alive: false }
    | { readonly alive: true; readonly startTime: string }
  >;
}

export interface ClockAdapter {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  randomToken(): string;
}

export interface ChromiumProvisionerAdapters {
  readonly nodeVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly entry: BrowserRegistryEntry;
  readonly fs: Partial<FileSystemAdapter>;
  readonly http: HttpAdapter;
  readonly archive: ArchiveAdapter;
  readonly runVersion: (
    executablePath: string,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ) => Promise<string>;
  readonly processIdentity: ProcessIdentityAdapter;
  readonly userId: number | undefined;
  readonly clock: ClockAdapter;
  /** Test seam; production always uses the 256 MiB policy value. */
  readonly maxArchiveBytes: number;
}

const maxArchiveBytes = 256 * 1024 * 1024;
const defaultVersionTimeoutMs = 10_000;
const defaultLockTimeoutMs = 30_000;
const defaultLockPollIntervalMs = 50;
const installedPackageDirectory = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
);

interface ManagedPaths {
  readonly root: string;
  readonly archive: string;
  readonly finalDirectory: string;
  readonly executable: string;
  readonly manifest: string;
  readonly lock: string;
}

interface LockOwner {
  readonly pid: number;
  readonly token: string;
  readonly startTime: string;
}

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: unknown }).code === code;

const cacheError = (message: string, cause: unknown): LegacyBrowserSmokeError =>
  new LegacyBrowserSmokeError("LBS_CACHE_IO", message, { cause });

const abortError = (
  signal: AbortSignal,
  cause?: unknown,
): LegacyBrowserSmokeError =>
  new LegacyBrowserSmokeError("LBS_ABORTED", "operation was aborted", {
    cause: cause ?? signal.reason,
  });

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError(signal);
};

const nodeFileSystem: FileSystemAdapter = {
  lstat: (path) => nodeFs.lstat(path),
  realpath: (path) => nodeFs.realpath(path),
  mkdir: (path, options) => nodeFs.mkdir(path, options),
  open: (path, flags, mode) => nodeFs.open(path, flags, mode),
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  rename: (source, destination) => nodeFs.rename(source, destination),
  rm: (path, options) => nodeFs.rm(path, options),
  unlink: (path) => nodeFs.unlink(path),
  chmod: (path, mode) => nodeFs.chmod(path, mode),
  readChunks: (path) => createReadStream(path),
  syncFile: async (path) => {
    const handle = await nodeFs.open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  syncDirectory: async (path) => {
    const handle = await nodeFs.open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

const nodeResponseDisposals = new WeakMap<object, Promise<void>>();

export const disposeNodeResponse = (
  response: Pick<
    IncomingMessage,
    "closed" | "destroy" | "destroyed" | "off" | "on" | "once" | "resume"
  >,
): Promise<void> => {
  const existing = nodeResponseDisposals.get(response);
  if (existing !== undefined) return existing;
  const disposal = (async (): Promise<void> => {
    response.resume();
    if (response.closed) return;
    await new Promise<void>((resolveDispose, rejectDispose) => {
      let firstError: Error | undefined;
      const onError = (error: Error): void => {
        firstError ??= error;
      };
      const onClose = (): void => {
        response.off("error", onError);
        if (firstError === undefined) resolveDispose();
        else rejectDispose(firstError);
      };
      response.once("close", onClose);
      response.on("error", onError);
      if (!response.destroyed) response.destroy();
    });
  })();
  nodeResponseDisposals.set(response, disposal);
  return disposal;
};

const nodeHttp: HttpAdapter = {
  request: (url, signal) =>
    new Promise((resolveResponse, reject) => {
      const request = httpsRequest(
        url,
        { method: "GET", signal },
        (response) => {
          resolveResponse({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
            dispose: () => disposeNodeResponse(response),
          });
        },
      );
      request.once("error", reject);
      request.end();
    }),
};

const unixFileTypeMask = 0o170000;
const unixRegularFile = 0o100000;
const unixDirectory = 0o040000;
const unixSymbolicLink = 0o120000;
const unixCharacterDevice = 0o020000;
const unixBlockDevice = 0o060000;

const classifyZipEntry = (
  zipEntry: YauzlEntry,
): {
  readonly path: string;
  readonly kind: ArchiveEntryKind;
  readonly mode?: number;
} => {
  const madeBy = zipEntry.versionMadeBy >>> 8;
  const unixMode =
    madeBy === 3
      ? (zipEntry.externalFileAttributes >>> 16) & 0xffff
      : undefined;
  const fileType = unixMode === undefined ? 0 : unixMode & unixFileTypeMask;
  const directoryMarker = zipEntry.fileName.endsWith("/");
  const path = directoryMarker
    ? zipEntry.fileName.slice(0, -1)
    : zipEntry.fileName;
  if (directoryMarker && (path === "" || path.endsWith("/"))) {
    return { path: zipEntry.fileName, kind: "unknown" };
  }
  if (zipEntry.isEncrypted() || !zipEntry.canDecodeFileData()) {
    return { path, kind: "unknown" };
  }
  if (fileType === unixSymbolicLink) return { path, kind: "symlink" };
  if (fileType === unixCharacterDevice || fileType === unixBlockDevice) {
    return { path, kind: "device" };
  }
  if (
    fileType !== 0 &&
    fileType !== unixRegularFile &&
    fileType !== unixDirectory
  ) {
    return { path, kind: "special" };
  }
  if (directoryMarker) {
    if (fileType === unixRegularFile) return { path, kind: "unknown" };
    return {
      path,
      kind: "directory",
      ...(unixMode === undefined ? {} : { mode: unixMode & 0o777 }),
    };
  }
  if (fileType === unixDirectory) return { path, kind: "unknown" };
  return {
    path,
    kind: "file",
    ...(unixMode === undefined ? {} : { mode: unixMode & 0o777 }),
  };
};

const yauzlUnsafeError = (
  error: unknown,
): LegacyBrowserSmokeError | undefined => {
  if (!(error instanceof Error)) return undefined;
  if (
    error.message.startsWith("invalid characters in fileName:") ||
    error.message.startsWith("absolute path:") ||
    error.message.startsWith("invalid relative path:")
  ) {
    return new LegacyBrowserSmokeError(
      "LBS_ARCHIVE_UNSAFE",
      "Chromium archive contains an unsafe path",
      { cause: error },
    );
  }
  return undefined;
};

export const extractZipEntry = async (
  zipFile: ZipFile,
  zipEntry: YauzlEntry,
  destination: string,
  signal: AbortSignal,
): Promise<void> => {
  throwIfAborted(signal);
  const stream = await zipFile.openReadStreamPromise(zipEntry);
  let handle: FileHandle;
  try {
    handle = await nodeFs.open(destination, "wx", 0o600);
  } catch (error) {
    stream.destroy();
    throw error;
  }
  const onAbort = (): void => {
    stream.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  let extractionFailed = false;
  let extractionError: unknown;
  try {
    throwIfAborted(signal);
    for await (const chunk of stream) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("ZIP stream chunks must be Uint8Array values");
      }
      await handle.writeFile(chunk);
    }
    throwIfAborted(signal);
    await handle.sync();
  } catch (error) {
    extractionFailed = true;
    extractionError = error;
  }
  signal.removeEventListener("abort", onAbort);
  stream.destroy();
  let closeFailed = false;
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }
  if (extractionFailed) throw extractionError;
  if (closeFailed) throw closeError;
};

export const closeYauzlFile = (
  zipFile: Pick<ZipFile, "close" | "isOpen" | "off" | "once">,
): Promise<void> => {
  if (!zipFile.isOpen) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    const onClose = (): void => {
      zipFile.off("error", onError);
      resolveClose();
    };
    const onError = (error: Error): void => {
      zipFile.off("close", onClose);
      rejectClose(error);
    };
    zipFile.once("close", onClose);
    zipFile.once("error", onError);
    try {
      zipFile.close();
    } catch (error) {
      zipFile.off("close", onClose);
      zipFile.off("error", onError);
      rejectClose(error);
    }
  });
};

const yauzlArchive: ArchiveAdapter = {
  open: async (archivePath, signal) => {
    throwIfAborted(signal);
    let zipFile: ZipFile;
    try {
      zipFile = await openZip(archivePath, {
        autoClose: false,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      });
    } catch (error) {
      throw yauzlUnsafeError(error) ?? error;
    }
    const entries: ArchiveEntry[] = [];
    const rawEntries = new Map<ArchiveEntry, YauzlEntry>();
    try {
      for await (const zipEntry of zipFile.eachEntry()) {
        throwIfAborted(signal);
        const archiveEntry = Object.freeze(classifyZipEntry(zipEntry));
        entries.push(archiveEntry);
        rawEntries.set(archiveEntry, zipEntry);
      }
    } catch (error) {
      await closeYauzlFile(zipFile).catch(() => undefined);
      throw yauzlUnsafeError(error) ?? error;
    }
    let closePromise: Promise<void> | undefined;
    return {
      entries: Object.freeze(entries),
      extract: async (archiveEntry, destination, extractSignal) => {
        const zipEntry = rawEntries.get(archiveEntry);
        if (zipEntry === undefined) {
          throw new TypeError(
            "archive entry does not belong to this ZIP handle",
          );
        }
        await extractZipEntry(zipFile, zipEntry, destination, extractSignal);
      },
      close: async () => {
        closePromise ??= closeYauzlFile(zipFile);
        await closePromise;
      },
    };
  },
};

/**
 * `--version` stdout을 registry 문자열과 정확 비교 가능한 형태로 정규화한다.
 * 실측: Chromium 75 Linux 빌드는 버전 뒤에 후행 공백 한 칸을 붙여 출력하므로
 * 개행만 제거하면 registry와의 정확 비교가 항상 실패한다.
 */
export const normalizeVersionOutput = (stdout: string): string => stdout.trim();

const runNodeVersion = (
  executablePath: string,
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
): Promise<string> =>
  new Promise((resolveVersion, reject) => {
    execFile(
      executablePath,
      ["--version"],
      {
        encoding: "utf8",
        signal: options.signal,
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolveVersion(normalizeVersionOutput(stdout));
      },
    );
  });

const readLinuxProcessStartTime = async (pid: number): Promise<string> => {
  const stat = await nodeFs.readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new TypeError("invalid Linux process stat");
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u);
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    throw new TypeError("invalid Linux process start time");
  }
  return startTime;
};

const nodeProcessIdentity: ProcessIdentityAdapter = {
  current: async () => ({
    pid: process.pid,
    startTime: await readLinuxProcessStartTime(process.pid),
  }),
  lookup: async (pid) => {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isErrno(error, "ESRCH")) return { alive: false };
      if (!isErrno(error, "EPERM")) throw error;
    }
    try {
      return { alive: true, startTime: await readLinuxProcessStartTime(pid) };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { alive: false };
      throw error;
    }
  },
};

const nodeClock: ClockAdapter = {
  now: () => performance.now(),
  sleep: (milliseconds, signal) =>
    new Promise((resolveSleep, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolveSleep();
      }, milliseconds);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }),
  randomToken: () => randomBytes(16).toString("hex"),
};

const defaultAdapters = (): ChromiumProvisionerAdapters => ({
  nodeVersion: process.versions.node,
  platform: nodePlatform,
  arch: nodeArch,
  environment: process.env,
  entry: lookupBrowserRegistry("linux", "x64"),
  fs: nodeFileSystem,
  http: nodeHttp,
  archive: yauzlArchive,
  runVersion: runNodeVersion,
  processIdentity: nodeProcessIdentity,
  userId: typeof process.getuid === "function" ? process.getuid() : undefined,
  clock: nodeClock,
  maxArchiveBytes,
});

const mergeAdapters = (
  overrides: Partial<ChromiumProvisionerAdapters>,
): ChromiumProvisionerAdapters => {
  const defaults = defaultAdapters();
  return {
    ...defaults,
    ...overrides,
    fs: { ...nodeFileSystem, ...overrides.fs },
  };
};

const managedPaths = (
  cacheRoot: string,
  entry: BrowserRegistryEntry,
): ManagedPaths => {
  const root = join(
    cacheRoot,
    "@cp949",
    "legacy-browser-smoke",
    entry.platform,
    entry.revision,
    entry.sha256,
  );
  const finalDirectory = join(root, "browser");
  return {
    root,
    archive: join(root, "chromium.zip"),
    finalDirectory,
    executable: join(
      finalDirectory,
      ...entry.executableRelativePath.split("/"),
    ),
    manifest: join(finalDirectory, "manifest.json"),
    lock: join(root, "provision.lock"),
  };
};

const pathIsInside = (parent: string, candidate: string): boolean => {
  const child = relative(parent, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
};

const rejectInstalledPackageCache = (cacheRoot: string): void => {
  const namespaceDirectory = resolve(
    cacheRoot,
    "@cp949",
    "legacy-browser-smoke",
  );
  if (pathIsInside(installedPackageDirectory, namespaceDirectory)) {
    throw new LegacyBrowserSmokeError(
      "LBS_CACHE_IO",
      "Chromium cache must not be inside the installed package directory",
    );
  }
};

const ensureManagedPaths = async (
  fs: FileSystemAdapter,
  cacheRoot: string,
  entry: BrowserRegistryEntry,
  userId: number | undefined,
): Promise<ManagedPaths> => {
  try {
    await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const realCacheRoot = await fs.realpath(cacheRoot);
    rejectInstalledPackageCache(realCacheRoot);
    const cacheRootStats = await fs.lstat(realCacheRoot);
    if (
      cacheRootStats.isSymbolicLink() ||
      !cacheRootStats.isDirectory() ||
      ((cacheRootStats.mode & 0o022) !== 0 &&
        (cacheRootStats.mode & 0o1000) === 0)
    ) {
      throw new Error("Chromium cache root permits unsafe path replacement");
    }
    const segments = [
      "@cp949",
      "legacy-browser-smoke",
      entry.platform,
      entry.revision,
      entry.sha256,
    ];
    let parent = realCacheRoot;
    for (const [index, segment] of segments.entries()) {
      const directory = join(parent, segment);
      let created = false;
      try {
        await fs.mkdir(directory, { recursive: false, mode: 0o700 });
        created = true;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      const stats = await fs.lstat(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          "managed Chromium cache path is not a private directory",
        );
      }
      if ((await fs.realpath(directory)) !== directory) {
        throw new Error("managed Chromium cache path resolves outside itself");
      }
      if (userId !== undefined && stats.uid !== userId) {
        throw new Error("managed Chromium cache path has a foreign owner");
      }
      if ((stats.mode & 0o022) !== 0) {
        throw new Error("managed Chromium cache path is group/world writable");
      }
      if (index === 1 && (stats.mode & 0o777) !== 0o700) {
        throw new Error("Chromium package cache namespace is not private");
      }
      if (created) await fs.syncDirectory(parent);
      parent = directory;
    }
    return managedPaths(realCacheRoot, entry);
  } catch (error) {
    if (error instanceof LegacyBrowserSmokeError) throw error;
    throw cacheError("failed to create safe Chromium cache paths", error);
  }
};

const writeDurable = async (
  fs: FileSystemAdapter,
  path: string,
  contents: string | Uint8Array,
  flags: string,
  mode: number,
): Promise<void> => {
  const handle = await fs.open(path, flags, mode);
  let writeFailed = false;
  let writeError: unknown;
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    writeFailed = true;
    writeError = error;
  }
  let closeFailed = false;
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeFailed = true;
    closeError = error;
  }
  if (writeFailed) throw writeError;
  if (closeFailed) throw closeError;
};

const readLockOwner = async (
  fs: FileSystemAdapter,
  lockPath: string,
): Promise<LockOwner | undefined> => {
  let serialized: string;
  try {
    serialized = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value !== "object" ||
      value === null ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      Reflect.ownKeys(record).length !== 3 ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      typeof record.token !== "string" ||
      record.token === "" ||
      typeof record.startTime !== "string" ||
      record.startTime === ""
    ) {
      return undefined;
    }
    return {
      pid: record.pid as number,
      token: record.token,
      startTime: record.startTime,
    };
  } catch {
    return undefined;
  }
};

const sameLockOwner = (left: LockOwner, right: LockOwner): boolean =>
  left.pid === right.pid &&
  left.token === right.token &&
  left.startTime === right.startTime;

const removeOwnedLock = async (
  fs: FileSystemAdapter,
  lockPath: string,
  owner: LockOwner,
): Promise<void> => {
  const quarantinePath = `${lockPath}.quarantine-${owner.token}`;
  try {
    await fs.rename(lockPath, quarantinePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  let quarantined: LockOwner | undefined;
  try {
    quarantined = await readLockOwner(fs, quarantinePath);
  } catch (error) {
    await fs.rename(quarantinePath, lockPath).catch(() => undefined);
    throw error;
  }
  if (quarantined === undefined || !sameLockOwner(quarantined, owner)) {
    await fs.rename(quarantinePath, lockPath);
    await fs.syncDirectory(dirname(lockPath));
    return;
  }
  await fs.unlink(quarantinePath);
  await fs.syncDirectory(dirname(lockPath));
};

const acquireLock = async (
  adapters: ChromiumProvisionerAdapters,
  lockPath: string,
  signal: AbortSignal,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<LockOwner> => {
  const startedAt = adapters.clock.now();
  const throwLockTimeout = (): never => {
    throw new LegacyBrowserSmokeError(
      "LBS_PROVISION_LOCK_TIMEOUT",
      "timed out waiting for Chromium provision lock",
    );
  };
  const deadlineReached = (): boolean =>
    adapters.clock.now() - startedAt >= timeoutMs;
  let attemptedAcquisition = false;
  while (true) {
    throwIfAborted(signal);
    if (attemptedAcquisition && deadlineReached()) throwLockTimeout();
    let identity: { readonly pid: number; readonly startTime: string };
    try {
      identity = await adapters.processIdentity.current();
    } catch (error) {
      throw cacheError("failed to read current process identity", error);
    }
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      typeof identity.startTime !== "string" ||
      identity.startTime === ""
    ) {
      throw new TypeError("process identity adapter returned an invalid owner");
    }
    const token = adapters.clock.randomToken();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(token)) {
      throw new TypeError("clock adapter returned an invalid ownership token");
    }
    const owner: LockOwner = {
      pid: identity.pid,
      token,
      startTime: identity.startTime,
    };
    if (attemptedAcquisition && deadlineReached()) throwLockTimeout();
    let handle: FileHandle | undefined;
    attemptedAcquisition = true;
    try {
      handle = await (adapters.fs as FileSystemAdapter).open(
        lockPath,
        "wx",
        0o600,
      );
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw cacheError("failed to acquire Chromium provision lock", error);
      }
    }
    if (handle !== undefined) {
      let closed = false;
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
        await handle.sync();
        await handle.close();
        closed = true;
        await (adapters.fs as FileSystemAdapter).syncDirectory(
          dirname(lockPath),
        );
        return owner;
      } catch (error) {
        if (!closed) await handle.close().catch(() => undefined);
        await (adapters.fs as FileSystemAdapter)
          .unlink(lockPath)
          .catch(() => undefined);
        await (adapters.fs as FileSystemAdapter)
          .syncDirectory(dirname(lockPath))
          .catch(() => undefined);
        throw cacheError("failed to write Chromium provision lock", error);
      }
    }

    const remaining = timeoutMs - (adapters.clock.now() - startedAt);
    if (remaining <= 0) throwLockTimeout();
    try {
      await adapters.clock.sleep(Math.min(pollIntervalMs, remaining), signal);
    } catch (error) {
      throw abortError(signal, error);
    }
    if (deadlineReached()) throwLockTimeout();
  }
};

const fileExists = async (
  fs: FileSystemAdapter,
  path: string,
): Promise<boolean> => {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw cacheError(`failed to inspect cache path ${path}`, error);
  }
};

const downloadArchive = async (
  adapters: ChromiumProvisionerAdapters,
  paths: ManagedPaths,
  signal: AbortSignal,
  token: string,
): Promise<void> => {
  const fs = adapters.fs as FileSystemAdapter;
  const partPath = `${paths.archive}.part-${token}`;
  let partOwned = false;
  try {
    let archiveUrl: URL;
    try {
      archiveUrl = new URL(adapters.entry.archiveUrl);
      if (archiveUrl.protocol !== "https:") {
        throw new Error("Chromium archive URL must use HTTPS");
      }
    } catch (error) {
      throw new LegacyBrowserSmokeError(
        "LBS_DOWNLOAD_FAILED",
        "Chromium archive URL is not secure",
        { cause: error },
      );
    }
    let response: HttpResponse;
    try {
      response = await adapters.http.request(adapters.entry.archiveUrl, signal);
    } catch (error) {
      if (signal.aborted) throw abortError(signal, error);
      throw new LegacyBrowserSmokeError(
        "LBS_DOWNLOAD_FAILED",
        "Chromium download request failed",
        { cause: error },
      );
    }
    if (
      typeof response !== "object" ||
      response === null ||
      !Number.isInteger(response.statusCode) ||
      response.body === undefined ||
      typeof response.body[Symbol.asyncIterator] !== "function" ||
      typeof response.dispose !== "function"
    ) {
      throw new TypeError("HTTP adapter returned an invalid response");
    }
    let responseFailed = false;
    let responseError: unknown;
    try {
      if (response.statusCode !== 200) {
        throw new LegacyBrowserSmokeError(
          "LBS_DOWNLOAD_FAILED",
          `Chromium download returned HTTP ${response.statusCode}`,
          { cause: new Error(`unexpected HTTP status ${response.statusCode}`) },
        );
      }

      const handle = await fs.open(partPath, "wx", 0o600).catch((error) => {
        throw cacheError("failed to create Chromium download part", error);
      });
      partOwned = true;
      const hash = createHash("sha256");
      let size = 0;
      let transferFailed = false;
      let transferError: unknown;
      try {
        for await (const chunk of response.body) {
          throwIfAborted(signal);
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError("HTTP body chunks must be Uint8Array values");
          }
          size += chunk.byteLength;
          if (size > adapters.maxArchiveBytes) {
            throw new LegacyBrowserSmokeError(
              "LBS_DOWNLOAD_FAILED",
              "Chromium download exceeded the 256 MiB limit",
              { cause: new Error("download size limit exceeded") },
            );
          }
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } catch (error) {
        transferFailed = true;
        transferError =
          error instanceof LegacyBrowserSmokeError || error instanceof TypeError
            ? error
            : signal.aborted
              ? abortError(signal, error)
              : new LegacyBrowserSmokeError(
                  "LBS_DOWNLOAD_FAILED",
                  "Chromium download stream failed",
                  { cause: error },
                );
      }
      let closeFailed = false;
      let closeError: unknown;
      try {
        await handle.close();
      } catch (error) {
        closeFailed = true;
        closeError = error;
      }
      if (transferFailed) throw transferError;
      if (closeFailed) {
        throw new LegacyBrowserSmokeError(
          "LBS_DOWNLOAD_FAILED",
          "failed to close Chromium download part",
          { cause: closeError },
        );
      }

      if (hash.digest("hex") !== adapters.entry.sha256) {
        throw new LegacyBrowserSmokeError(
          "LBS_CHECKSUM_MISMATCH",
          "Chromium archive checksum does not match the registry",
        );
      }
      await fs.rename(partPath, paths.archive).catch((error) => {
        throw cacheError("failed to finalize Chromium archive", error);
      });
      partOwned = false;
      await fs.syncDirectory(paths.root).catch((error) => {
        throw cacheError("failed to sync Chromium archive cache", error);
      });
    } catch (error) {
      responseFailed = true;
      responseError = error;
    }
    try {
      await response.dispose();
    } catch (error) {
      if (!responseFailed) {
        responseFailed = true;
        responseError = new LegacyBrowserSmokeError(
          "LBS_DOWNLOAD_FAILED",
          "failed to dispose Chromium download response",
          { cause: error },
        );
      }
    }
    if (responseFailed) throw responseError;
  } finally {
    if (partOwned) {
      await fs
        .rm(partPath, { recursive: false, force: true })
        .catch(() => undefined);
    }
  }
};

const verifyCachedArchive = async (
  adapters: ChromiumProvisionerAdapters,
  archivePath: string,
  signal: AbortSignal,
): Promise<void> => {
  const fs = adapters.fs as FileSystemAdapter;
  try {
    const archive = await fs.lstat(archivePath);
    if (
      archive.isSymbolicLink() ||
      !archive.isFile() ||
      (await fs.realpath(archivePath)) !== archivePath
    ) {
      throw new LegacyBrowserSmokeError(
        "LBS_CHECKSUM_MISMATCH",
        "cached Chromium archive is not a regular owned file",
      );
    }
  } catch (error) {
    if (error instanceof LegacyBrowserSmokeError) throw error;
    if (signal.aborted) throw abortError(signal, error);
    throw cacheError("failed to inspect cached Chromium archive", error);
  }
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of fs.readChunks(archivePath)) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("filesystem chunks must be Uint8Array values");
      }
      size += chunk.byteLength;
      if (size > adapters.maxArchiveBytes) {
        throw new LegacyBrowserSmokeError(
          "LBS_CHECKSUM_MISMATCH",
          "cached Chromium archive exceeds the size policy",
        );
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (
      error instanceof LegacyBrowserSmokeError ||
      error instanceof TypeError
    ) {
      throw error;
    }
    if (signal.aborted) throw abortError(signal, error);
    throw cacheError("failed to hash cached Chromium archive", error);
  }
  if (hash.digest("hex") !== adapters.entry.sha256) {
    throw new LegacyBrowserSmokeError(
      "LBS_CHECKSUM_MISMATCH",
      "cached Chromium archive checksum does not match the registry",
    );
  }
};

const safeArchiveDestination = (
  staging: string,
  archivePath: string,
): string => {
  if (
    archivePath === "" ||
    archivePath.includes("\0") ||
    archivePath.includes("\\") ||
    archivePath.startsWith("/") ||
    archivePath.endsWith("/") ||
    /^[A-Za-z]:/u.test(archivePath)
  ) {
    throw new LegacyBrowserSmokeError(
      "LBS_ARCHIVE_UNSAFE",
      "Chromium archive contains an unsafe path",
    );
  }
  const segments = archivePath.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new LegacyBrowserSmokeError(
      "LBS_ARCHIVE_UNSAFE",
      "Chromium archive contains an unsafe path segment",
    );
  }
  const destination = resolve(staging, ...segments);
  const destinationRelative = relative(staging, destination);
  if (
    destinationRelative === "" ||
    destinationRelative === ".." ||
    destinationRelative.startsWith(`..${sep}`) ||
    isAbsolute(destinationRelative)
  ) {
    throw new LegacyBrowserSmokeError(
      "LBS_ARCHIVE_UNSAFE",
      "Chromium archive destination escapes staging",
    );
  }
  return destination;
};

const validateArchive = (
  entries: readonly ArchiveEntry[],
  staging: string,
  expectedPath: string,
): ReadonlyMap<ArchiveEntry, string> => {
  if (!Array.isArray(entries)) {
    throw new TypeError("archive entries must be an array");
  }
  const destinations = new Map<ArchiveEntry, string>();
  const kindsByPath = new Map<string, ArchiveEntryKind>();
  let expectedCount = 0;
  for (const archiveEntry of entries) {
    if (
      typeof archiveEntry !== "object" ||
      archiveEntry === null ||
      typeof archiveEntry.path !== "string"
    ) {
      throw new TypeError("archive entry is invalid");
    }
    if (
      archiveEntry.mode !== undefined &&
      (!Number.isSafeInteger(archiveEntry.mode) ||
        archiveEntry.mode < 0 ||
        archiveEntry.mode > 0xffff)
    ) {
      throw new TypeError("archive entry mode is invalid");
    }
    if (archiveEntry.kind !== "file" && archiveEntry.kind !== "directory") {
      throw new LegacyBrowserSmokeError(
        "LBS_ARCHIVE_UNSAFE",
        "Chromium archive contains a link or special entry",
      );
    }
    const destination = safeArchiveDestination(staging, archiveEntry.path);
    if (kindsByPath.has(archiveEntry.path)) {
      throw new LegacyBrowserSmokeError(
        "LBS_ARCHIVE_UNSAFE",
        "Chromium archive contains duplicate paths",
      );
    }
    const segments = archiveEntry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      if (kindsByPath.get(prefix) === "file") {
        throw new LegacyBrowserSmokeError(
          "LBS_ARCHIVE_UNSAFE",
          "Chromium archive contains a file/directory collision",
        );
      }
    }
    if (
      archiveEntry.kind === "file" &&
      [...kindsByPath.keys()].some((known) =>
        known.startsWith(`${archiveEntry.path}/`),
      )
    ) {
      throw new LegacyBrowserSmokeError(
        "LBS_ARCHIVE_UNSAFE",
        "Chromium archive contains a file/directory collision",
      );
    }
    kindsByPath.set(archiveEntry.path, archiveEntry.kind);
    destinations.set(archiveEntry, destination);
    if (archiveEntry.path === expectedPath && archiveEntry.kind === "file") {
      expectedCount += 1;
    }
  }
  if (expectedCount !== 1) {
    throw new LegacyBrowserSmokeError(
      "LBS_ARCHIVE_INVALID",
      "Chromium archive must contain exactly one expected executable",
    );
  }
  return destinations;
};

const manifestValue = (entry: BrowserRegistryEntry): string =>
  `${JSON.stringify({
    platform: entry.platform,
    revision: entry.revision,
    version: entry.version,
    archiveUrl: entry.archiveUrl,
    executableRelativePath: entry.executableRelativePath,
    sha256: entry.sha256,
  })}\n`;

const manifestMatches = (
  value: unknown,
  entry: BrowserRegistryEntry,
): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const expected = {
    platform: entry.platform,
    revision: entry.revision,
    version: entry.version,
    archiveUrl: entry.archiveUrl,
    executableRelativePath: entry.executableRelativePath,
    sha256: entry.sha256,
  };
  const keys = Object.keys(expected);
  return (
    Reflect.ownKeys(record).length === keys.length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(record, key) &&
        record[key] === expected[key as keyof typeof expected],
    )
  );
};

const warmCacheMismatch = (cause?: unknown): LegacyBrowserSmokeError =>
  new LegacyBrowserSmokeError(
    "LBS_BROWSER_VERSION_MISMATCH",
    "existing Chromium cache does not match the registry",
    cause === undefined ? undefined : { cause },
  );

const validateWarmCache = async (
  adapters: ChromiumProvisionerAdapters,
  paths: ManagedPaths,
  signal: AbortSignal,
  versionTimeoutMs: number,
): Promise<ChromiumExecutable> => {
  const fs = adapters.fs as FileSystemAdapter;
  const assertTrusted = (stats: Stats): void => {
    if (adapters.userId !== undefined && stats.uid !== adapters.userId) {
      throw warmCacheMismatch();
    }
    if ((stats.mode & 0o022) !== 0) throw warmCacheMismatch();
  };
  try {
    const directory = await fs.lstat(paths.finalDirectory);
    if (directory.isSymbolicLink() || !directory.isDirectory()) {
      throw warmCacheMismatch();
    }
    assertTrusted(directory);
    const manifestStats = await fs.lstat(paths.manifest);
    if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
      throw warmCacheMismatch();
    }
    assertTrusted(manifestStats);
    const parsed: unknown = JSON.parse(
      await fs.readFile(paths.manifest, "utf8"),
    );
    if (!manifestMatches(parsed, adapters.entry)) throw warmCacheMismatch();
    const executable = await fs.lstat(paths.executable);
    if (
      executable.isSymbolicLink() ||
      !executable.isFile() ||
      (executable.mode & 0o777) !== 0o755
    ) {
      throw warmCacheMismatch();
    }
    assertTrusted(executable);
    let executableParent = dirname(paths.executable);
    while (executableParent !== paths.finalDirectory) {
      const parentStats = await fs.lstat(executableParent);
      if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
        throw warmCacheMismatch();
      }
      assertTrusted(parentStats);
      if ((await fs.realpath(executableParent)) !== executableParent) {
        throw warmCacheMismatch();
      }
      executableParent = dirname(executableParent);
    }
    if ((await fs.realpath(paths.executable)) !== paths.executable) {
      throw warmCacheMismatch();
    }
  } catch (error) {
    if (error instanceof LegacyBrowserSmokeError) throw error;
    if (signal.aborted) throw abortError(signal, error);
    throw warmCacheMismatch(error);
  }
  let version: string;
  try {
    version = await adapters.runVersion(paths.executable, {
      signal,
      timeoutMs: versionTimeoutMs,
    });
  } catch (error) {
    if (signal.aborted) throw abortError(signal, error);
    throw new LegacyBrowserSmokeError(
      "LBS_BROWSER_EXECUTABLE_INVALID",
      "failed to run cached Chromium executable",
      { cause: error },
    );
  }
  if (typeof version !== "string") {
    throw new TypeError("version adapter must return a string");
  }
  if (version !== adapters.entry.version) throw warmCacheMismatch();
  return toChromiumExecutable(paths.executable, adapters.entry);
};

const extractArchive = async (
  adapters: ChromiumProvisionerAdapters,
  paths: ManagedPaths,
  signal: AbortSignal,
  token: string,
  versionTimeoutMs: number,
): Promise<void> => {
  const fs = adapters.fs as FileSystemAdapter;
  const staging = `${paths.finalDirectory}.staging-${token}`;
  let stagingOwned = false;
  let archive: ArchiveHandle | undefined;
  const directoriesToSync = new Set<string>();
  const rememberDirectory = (directory: string): void => {
    let current = directory;
    while (pathIsInside(staging, current)) {
      directoriesToSync.add(current);
      if (current === staging) break;
      current = dirname(current);
    }
  };
  try {
    try {
      archive = await adapters.archive.open(paths.archive, signal);
    } catch (error) {
      if (signal.aborted) throw abortError(signal, error);
      if (
        error instanceof LegacyBrowserSmokeError ||
        error instanceof TypeError
      ) {
        throw error;
      }
      throw new LegacyBrowserSmokeError(
        "LBS_ARCHIVE_INVALID",
        "failed to open Chromium archive",
        { cause: error },
      );
    }
    const destinations = validateArchive(
      archive.entries,
      staging,
      adapters.entry.executableRelativePath,
    );
    await fs
      .mkdir(staging, { recursive: false, mode: 0o700 })
      .catch((error) => {
        throw cacheError("failed to create Chromium staging directory", error);
      });
    stagingOwned = true;
    rememberDirectory(staging);
    for (const archiveEntry of archive.entries) {
      throwIfAborted(signal);
      const destination = destinations.get(archiveEntry);
      if (destination === undefined) {
        throw new TypeError("archive destination is missing");
      }
      if (archiveEntry.kind === "directory") {
        await fs
          .mkdir(destination, { recursive: true, mode: 0o755 })
          .catch((error) => {
            throw cacheError("failed to create extracted directory", error);
          });
        rememberDirectory(destination);
        continue;
      }
      const destinationDirectory = dirname(destination);
      await fs
        .mkdir(destinationDirectory, { recursive: true, mode: 0o755 })
        .catch((error) => {
          throw cacheError("failed to create extracted file directory", error);
        });
      rememberDirectory(destinationDirectory);
      try {
        await archive.extract(archiveEntry, destination, signal);
      } catch (error) {
        if (signal.aborted) throw abortError(signal, error);
        if (
          error instanceof LegacyBrowserSmokeError ||
          error instanceof TypeError
        ) {
          throw error;
        }
        throw new LegacyBrowserSmokeError(
          "LBS_ARCHIVE_INVALID",
          "failed to extract Chromium archive",
          { cause: error },
        );
      }
      const mode =
        archiveEntry.path === adapters.entry.executableRelativePath
          ? 0o755
          : (archiveEntry.mode ?? 0o644) & 0o777;
      await fs.chmod(destination, mode).catch((error) => {
        throw cacheError("failed to set extracted file permissions", error);
      });
      await fs.syncFile(destination).catch((error) => {
        throw cacheError("failed to sync extracted file", error);
      });
    }

    try {
      await archive.close();
      archive = undefined;
    } catch (error) {
      throw new LegacyBrowserSmokeError(
        "LBS_ARCHIVE_INVALID",
        "failed to close Chromium archive",
        { cause: error },
      );
    }
    for (const directory of [...directoriesToSync].sort(
      (left, right) => right.length - left.length,
    )) {
      await fs.syncDirectory(directory).catch((error) => {
        throw cacheError("failed to sync extracted directory", error);
      });
    }

    const stagingExecutable = join(
      staging,
      ...adapters.entry.executableRelativePath.split("/"),
    );
    let version: string;
    try {
      version = await adapters.runVersion(stagingExecutable, {
        signal,
        timeoutMs: versionTimeoutMs,
      });
    } catch (error) {
      if (signal.aborted) throw abortError(signal, error);
      throw new LegacyBrowserSmokeError(
        "LBS_BROWSER_EXECUTABLE_INVALID",
        "failed to run staged Chromium executable",
        { cause: error },
      );
    }
    if (typeof version !== "string") {
      throw new TypeError("version adapter must return a string");
    }
    if (version !== adapters.entry.version) {
      throw new LegacyBrowserSmokeError(
        "LBS_BROWSER_VERSION_MISMATCH",
        "staged Chromium version does not match the registry",
      );
    }
    await writeDurable(
      fs,
      join(staging, "manifest.json"),
      manifestValue(adapters.entry),
      "wx",
      0o600,
    ).catch((error) => {
      throw error instanceof LegacyBrowserSmokeError
        ? error
        : cacheError("failed to write Chromium cache manifest", error);
    });
    await fs.syncDirectory(staging).catch((error) => {
      throw cacheError("failed to sync Chromium staging directory", error);
    });
    await fs.rename(staging, paths.finalDirectory).catch((error) => {
      throw cacheError("failed to finalize Chromium browser cache", error);
    });
    stagingOwned = false;
    await fs.syncDirectory(paths.root).catch((error) => {
      throw cacheError("failed to sync Chromium browser cache", error);
    });
  } finally {
    if (archive !== undefined) await archive.close().catch(() => undefined);
    if (stagingOwned) {
      await fs
        .rm(staging, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }
};

const positiveDuration = (
  value: number | undefined,
  fallback: number,
): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;

export const createChromiumProvisioner = (
  overrides: Partial<ChromiumProvisionerAdapters> = {},
): ((options?: EnsureChromiumOptions) => Promise<ChromiumExecutable>) => {
  const adapters = mergeAdapters(overrides);
  const fs = adapters.fs as FileSystemAdapter;
  return async (options = {}) => {
    assertSupportedNode(adapters.nodeVersion);
    const signal = options.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    const versionTimeoutMs = positiveDuration(
      options.versionTimeoutMs,
      defaultVersionTimeoutMs,
    );
    if (options.executablePath !== undefined) {
      return validateExplicitExecutable(
        options.executablePath,
        fs,
        adapters.runVersion,
        { signal, timeoutMs: versionTimeoutMs },
      );
    }
    if (adapters.platform !== "linux" || adapters.arch !== "x64") {
      throw new LegacyBrowserSmokeError(
        "LBS_PLATFORM_UNSUPPORTED",
        "only linux x64 browser provisioning is supported",
      );
    }
    const cacheRoot = resolveCacheRoot(
      options.cacheDirectory,
      adapters.environment,
    );
    rejectInstalledPackageCache(cacheRoot);
    const paths = await ensureManagedPaths(
      fs,
      cacheRoot,
      adapters.entry,
      adapters.userId,
    );

    if (await fileExists(fs, paths.finalDirectory)) {
      return validateWarmCache(adapters, paths, signal, versionTimeoutMs);
    }

    const lock = await acquireLock(
      adapters,
      paths.lock,
      signal,
      positiveDuration(options.lockTimeoutMs, defaultLockTimeoutMs),
      positiveDuration(options.lockPollIntervalMs, defaultLockPollIntervalMs),
    );
    let failed = false;
    let primaryError: unknown;
    let result: ChromiumExecutable | undefined;
    try {
      if (await fileExists(fs, paths.finalDirectory)) {
        result = await validateWarmCache(
          adapters,
          paths,
          signal,
          versionTimeoutMs,
        );
      } else {
        if (!(await fileExists(fs, paths.archive))) {
          await downloadArchive(adapters, paths, signal, lock.token);
        } else {
          await verifyCachedArchive(adapters, paths.archive, signal);
        }
        await extractArchive(
          adapters,
          paths,
          signal,
          lock.token,
          versionTimeoutMs,
        );
        result = toChromiumExecutable(paths.executable, adapters.entry);
      }
    } catch (error) {
      failed = true;
      primaryError = error;
    }
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      await removeOwnedLock(fs, paths.lock, lock);
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (failed) throw primaryError;
    if (releaseFailed) {
      throw cacheError(
        "failed to release Chromium provision lock",
        releaseError,
      );
    }
    if (result === undefined) {
      throw new TypeError("Chromium provision completed without a result");
    }
    return result;
  };
};

export const ensureChromium = createChromiumProvisioner();
