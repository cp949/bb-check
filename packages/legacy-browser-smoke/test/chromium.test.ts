import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open as fsOpen,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  rename as fsRename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeYauzlFile,
  createChromiumProvisioner,
  disposeNodeResponse,
  extractZipEntry,
  type ChromiumProvisionerAdapters,
} from "../src/chromium.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";

const archiveBytes = Buffer.from("deterministic synthetic chromium archive");
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const entry = Object.freeze({
  platform: "linux-x64" as const,
  revision: "650583" as const,
  version: "Chromium 75.0.3765.0" as const,
  archiveUrl: "https://example.test/chromium.zip",
  executableRelativePath: "chrome-linux/chrome" as const,
  sha256: archiveSha256,
});

const pathsFor = (cacheDirectory: string) => {
  const root = join(
    cacheDirectory,
    "@cp949",
    "legacy-browser-smoke",
    "linux-x64",
    "650583",
    archiveSha256,
  );
  const finalDirectory = join(root, "browser");
  return {
    root,
    archive: join(root, "chromium.zip"),
    finalDirectory,
    executable: join(finalDirectory, "chrome-linux", "chrome"),
    manifest: join(finalDirectory, "manifest.json"),
    lock: join(root, "provision.lock"),
  };
};

const manifest = (override: Readonly<Record<string, unknown>> = {}) => ({
  platform: entry.platform,
  revision: entry.revision,
  version: entry.version,
  archiveUrl: entry.archiveUrl,
  executableRelativePath: entry.executableRelativePath,
  sha256: entry.sha256,
  ...override,
});

const chunks = async function* (
  values: readonly Uint8Array[],
): AsyncGenerator<Uint8Array> {
  for (const value of values) yield value;
};

describe("Chromium secure provisioning", () => {
  const temporaryDirectories: string[] = [];

  const temporaryDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "lbs-chromium-"));
    temporaryDirectories.push(directory);
    return directory;
  };

  const createPrivateManagedRoot = async (
    cacheDirectory: string,
  ): Promise<void> => {
    await mkdir(pathsFor(cacheDirectory).root, { recursive: true });
    await chmod(join(cacheDirectory, "@cp949", "legacy-browser-smoke"), 0o700);
  };

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  const adapters = (
    home: string,
    overrides: Partial<ChromiumProvisionerAdapters> = {},
  ): Partial<ChromiumProvisionerAdapters> => ({
    entry,
    environment: { HOME: home },
    http: {
      request: async () => ({
        statusCode: 200,
        headers: {},
        body: chunks([archiveBytes]),
        dispose: async () => undefined,
      }),
    },
    archive: {
      open: async () => ({
        entries: [
          {
            path: "chrome-linux/chrome",
            kind: "file" as const,
            mode: 0o755,
          },
        ],
        extract: async (_archiveEntry, destination) => {
          await writeFile(destination, "synthetic chromium executable");
        },
        close: async () => undefined,
      }),
    },
    runVersion: async () => entry.version,
    processIdentity: {
      current: async () => ({ pid: 101, startTime: "current-start" }),
      lookup: async () => ({ alive: false }),
    },
    ...overrides,
  });

  it("production yauzl close는 close event settlement까지 기다린다", async () => {
    class FakeZipFile extends EventEmitter {
      isOpen = true;
      close(): void {
        this.isOpen = false;
        setImmediate(() => this.emit("close"));
      }
    }
    const zipFile = new FakeZipFile();
    let settled = false;
    const closing = closeYauzlFile(zipFile as never).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    await closing;
    expect(settled).toBe(true);
  });

  it("production yauzl close event 오류를 원래 cause로 reject한다", async () => {
    const cause = new Error("fd close failed");
    class FakeZipFile extends EventEmitter {
      isOpen = true;
      close(): void {
        this.isOpen = false;
        setImmediate(() => this.emit("error", cause));
      }
    }

    await expect(closeYauzlFile(new FakeZipFile() as never)).rejects.toBe(
      cause,
    );
  });

  it("production HTTP dispose는 destroyed지만 close 전인 response settlement를 기다린다", async () => {
    class FakeResponse extends EventEmitter {
      destroyed = true;
      closed = false;
      readonly resume = vi.fn();
      readonly destroy = vi.fn();
    }
    const response = new FakeResponse();
    let settled = false;
    const disposal = disposeNodeResponse(response as never).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    response.closed = true;
    response.emit("close");
    await disposal;
    expect(settled).toBe(true);
    expect(response.resume).toHaveBeenCalledTimes(1);
    expect(response.destroy).not.toHaveBeenCalled();
  });

  it("production HTTP dispose는 error를 저장하고 close 뒤 원래 cause로 reject한다", async () => {
    class FakeResponse extends EventEmitter {
      destroyed = true;
      closed = false;
      readonly resume = vi.fn();
      readonly destroy = vi.fn();
    }
    const response = new FakeResponse();
    const cause = new Error("response failed before close");
    const disposal = disposeNodeResponse(response as never);
    expect(disposeNodeResponse(response as never)).toBe(disposal);
    const settlement = disposal.then(
      () => ({ status: "resolved" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );

    response.emit("error", cause);
    response.emit("error", new Error("later response error"));
    await expect(
      Promise.race([
        settlement,
        new Promise<"pending">((resolve) =>
          setImmediate(() => resolve("pending")),
        ),
      ]),
    ).resolves.toBe("pending");
    response.closed = true;
    response.emit("close");
    await expect(settlement).resolves.toEqual({
      status: "rejected",
      reason: cause,
    });
  });

  it("ZIP stream abort listener 등록 직후 발생한 abort를 놓치지 않고 settle한다", async () => {
    const home = await temporaryDirectory();
    const destination = join(home, "abort-race-output");
    const controller = new AbortController();
    const cause = new Error("abort during listener registration");
    const stream = Readable.from([]);
    const destroy = vi.spyOn(stream, "destroy");
    const raceSignal = {
      get aborted() {
        return controller.signal.aborted;
      },
      get reason() {
        return controller.signal.reason;
      },
      addEventListener: (
        ...args: Parameters<AbortSignal["addEventListener"]>
      ) => {
        controller.signal.addEventListener(...args);
        controller.abort(cause);
      },
      removeEventListener: (
        ...args: Parameters<AbortSignal["removeEventListener"]>
      ) => controller.signal.removeEventListener(...args),
    } as AbortSignal;

    await expect(
      extractZipEntry(
        {
          openReadStreamPromise: async () => stream,
        } as never,
        {} as never,
        destination,
        raceSignal,
      ),
    ).rejects.toMatchObject({ code: "LBS_ABORTED", cause });
    expect(destroy).toHaveBeenCalled();
  });

  it("absolute XDG cache에 namespace/platform/revision/full digest 경로를 만든다", async () => {
    const home = await temporaryDirectory();
    const xdg = join(home, "xdg");
    const provision = createChromiumProvisioner(
      adapters(home, { environment: { HOME: home, XDG_CACHE_HOME: xdg } }),
    );

    const chromium = await provision();

    expect(chromium.path).toBe(
      join(
        xdg,
        "@cp949",
        "legacy-browser-smoke",
        "linux-x64",
        "650583",
        archiveSha256,
        "browser",
        "chrome-linux",
        "chrome",
      ),
    );
    expect(isAbsolute(chromium.path)).toBe(true);
  });

  it("XDG가 없으면 HOME/.cache를 사용한다", async () => {
    const home = await temporaryDirectory();
    const provision = createChromiumProvisioner(adapters(home));

    const chromium = await provision();

    expect(chromium.path.startsWith(join(home, ".cache"))).toBe(true);
  });

  it("HTTP body가 3개 이상 chunk로 나뉘어 도착해도 합쳐진 archive digest 검증을 통과하고 provisioning에 성공한다", async () => {
    const home = await temporaryDirectory();
    const chunkSize = Math.ceil(archiveBytes.length / 4);
    const bodyChunks: Buffer[] = [];
    for (let offset = 0; offset < archiveBytes.length; offset += chunkSize) {
      bodyChunks.push(archiveBytes.subarray(offset, offset + chunkSize));
    }
    // 115MB production 다운로드는 하나의 chunk로 오지 않는다 — 이 fixture는
    // 그 streamed multi-chunk body를 흉내내 hash.update가 chunk마다 누적
    // 적용되는지, 즉 조립된 전체 byte에 대해 digest 검증이 이뤄지는지 확인한다.
    expect(bodyChunks.length).toBeGreaterThanOrEqual(3);
    expect(Buffer.concat(bodyChunks)).toEqual(archiveBytes);

    const provision = createChromiumProvisioner(
      adapters(home, {
        http: {
          request: async () => ({
            statusCode: 200,
            headers: {},
            body: chunks(bodyChunks),
            dispose: async () => undefined,
          }),
        },
      }),
    );

    const chromium = await provision();

    expect(chromium.path.startsWith(join(home, ".cache"))).toBe(true);
    expect(chromium.version).toBe(entry.version);
  });

  it("relative XDG는 무시하고 HOME/.cache를 사용한다", async () => {
    const home = await temporaryDirectory();
    const provision = createChromiumProvisioner(
      adapters(home, {
        environment: { HOME: home, XDG_CACHE_HOME: "relative-cache" },
      }),
    );

    const chromium = await provision();

    expect(chromium.path.startsWith(join(home, ".cache"))).toBe(true);
  });

  it("absolute explicit cacheDirectory가 환경보다 우선하고 package directory를 사용하지 않는다", async () => {
    const home = await temporaryDirectory();
    const explicitCache = join(home, "explicit-cache");
    const provision = createChromiumProvisioner(
      adapters(home, {
        environment: { HOME: home, XDG_CACHE_HOME: join(home, "xdg") },
      }),
    );

    const chromium = await provision({ cacheDirectory: explicitCache });

    expect(chromium.path.startsWith(explicitCache)).toBe(true);
    expect(chromium.path).not.toContain(
      join("packages", "legacy-browser-smoke"),
    );
  });

  it("relative explicit cacheDirectory는 filesystem과 HTTP 전에 LBS_CACHE_IO로 거부한다", async () => {
    const home = await temporaryDirectory();
    const fsTouched = vi.fn();
    const httpTouched = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: new Proxy(
          {},
          {
            get: () => () => {
              fsTouched();
              throw new Error("filesystem must stay uncalled");
            },
          },
        ) as never,
        http: {
          request: async () => {
            httpTouched();
            throw new Error("HTTP must stay uncalled");
          },
        },
      }),
    );

    await expect(
      provision({ cacheDirectory: "relative-cache" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_CACHE_IO",
      }),
    );
    expect(fsTouched).not.toHaveBeenCalled();
    expect(httpTouched).not.toHaveBeenCalled();
  });

  it("checksum mismatch는 ZIP adapter 호출 없이 part를 정리하고 final archive를 노출하지 않는다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const archiveOpen = vi.fn();
    const wrongBytes = Buffer.from("wrong archive bytes");
    const provision = createChromiumProvisioner(
      adapters(home, {
        http: {
          request: async () => ({
            statusCode: 200,
            headers: {},
            body: chunks([wrongBytes]),
            dispose: async () => undefined,
          }),
        },
        archive: { open: archiveOpen as never },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_CHECKSUM_MISMATCH",
      }),
    );
    expect(archiveOpen).not.toHaveBeenCalled();
    const managed = join(
      cacheDirectory,
      "@cp949",
      "legacy-browser-smoke",
      "linux-x64",
      "650583",
      archiveSha256,
    );
    await expect(access(join(managed, "chromium.zip"))).rejects.toThrow();
    const names = await readFile(join(managed, "provision.lock"), "utf8").catch(
      () => "",
    );
    expect(names).toBe("");
  });

  it("entry.archiveUrl만 요청하고 stream 종료 전에는 final archive를 노출하지 않는다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const request = vi.fn(async () => ({
      statusCode: 200,
      headers: {},
      body: (async function* () {
        await expect(access(paths.archive)).rejects.toThrow();
        const names = await readdir(paths.root);
        expect(names.some((name) => name.includes(".part-"))).toBe(true);
        yield archiveBytes;
      })(),
      dispose: async () => undefined,
    }));
    const provision = createChromiumProvisioner(
      adapters(home, { http: { request } }),
    );

    await provision({ cacheDirectory });

    expect(request).toHaveBeenCalledWith(
      entry.archiveUrl,
      expect.any(AbortSignal),
    );
    await expect(access(paths.archive)).resolves.toBeUndefined();
  });

  it("HTTP request 실패를 cause와 함께 LBS_DOWNLOAD_FAILED로 바꾸고 part를 남기지 않는다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const cause = new Error("network unavailable");
    const provision = createChromiumProvisioner(
      adapters(home, {
        http: { request: async () => Promise.reject(cause) },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_DOWNLOAD_FAILED",
        cause,
      }),
    );
    expect(await readdir(pathsFor(cacheDirectory).root)).not.toEqual(
      expect.arrayContaining([expect.stringContaining(".part-")]),
    );
  });

  it.each([302, 307, 404, 500])(
    "HTTP %s는 redirect를 따르지 않고 LBS_DOWNLOAD_FAILED로 실패한다",
    async (statusCode) => {
      const home = await temporaryDirectory();
      const cacheDirectory = join(home, "cache");
      const provision = createChromiumProvisioner(
        adapters(home, {
          http: {
            request: async () => ({
              statusCode,
              headers: { location: "https://redirect.test/archive.zip" },
              body: chunks([]),
              dispose: async () => undefined,
            }),
          },
        }),
      );

      await expect(provision({ cacheDirectory })).rejects.toEqual(
        expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
          code: "LBS_DOWNLOAD_FAILED",
          cause: expect.any(Error),
        }),
      );
      expect(await readdir(pathsFor(cacheDirectory).root)).not.toEqual(
        expect.arrayContaining([expect.stringContaining(".part-")]),
      );
    },
  );

  it("non-200 never-ending body는 dispose를 await하고 cleanup 오류보다 status 오류를 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const cleanupCause = new Error("response cleanup failed");
    let disposed = false;
    const neverEndingBody: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]: () => neverEndingBody,
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
    };
    const provision = createChromiumProvisioner(
      adapters(home, {
        http: {
          request: async () => ({
            statusCode: 503,
            headers: {},
            body: neverEndingBody,
            dispose: async () => {
              await Promise.resolve();
              disposed = true;
              throw cleanupCause;
            },
          }),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_DOWNLOAD_FAILED",
      cause: expect.objectContaining({ message: "unexpected HTTP status 503" }),
    });
    expect(disposed).toBe(true);
  });

  it("body size-limit early termination은 response dispose를 await한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    let disposed = false;
    const provision = createChromiumProvisioner(
      adapters(home, {
        maxArchiveBytes: 4,
        http: {
          request: async () => ({
            statusCode: 200,
            headers: {},
            body: chunks([Buffer.from("12345")]),
            dispose: async () => {
              await Promise.resolve();
              disposed = true;
            },
          }),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_DOWNLOAD_FAILED",
    });
    expect(disposed).toBe(true);
  });

  it("download stream 실패는 part를 정리하고 원래 cause를 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const cause = new Error("stream reset");
    const provision = createChromiumProvisioner(
      adapters(home, {
        http: {
          request: async () => ({
            statusCode: 200,
            headers: {},
            body: (async function* () {
              yield archiveBytes.subarray(0, 4);
              throw cause;
            })(),
            dispose: async () => undefined,
          }),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_DOWNLOAD_FAILED",
        cause,
      }),
    );
    expect(await readdir(pathsFor(cacheDirectory).root)).not.toEqual(
      expect.arrayContaining([expect.stringContaining(".part-")]),
    );
  });

  it("download 중 abort는 LBS_ABORTED로 실패하고 part를 정리한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const controller = new AbortController();
    const provision = createChromiumProvisioner(
      adapters(home, {
        http: {
          request: async () => ({
            statusCode: 200,
            headers: {},
            body: (async function* () {
              yield archiveBytes.subarray(0, 4);
              controller.abort(new Error("cancelled"));
              yield archiveBytes.subarray(4);
            })(),
            dispose: async () => undefined,
          }),
        },
      }),
    );

    await expect(
      provision({ cacheDirectory, signal: controller.signal }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_ABORTED",
      }),
    );
    expect(await readdir(pathsFor(cacheDirectory).root)).not.toEqual(
      expect.arrayContaining([expect.stringContaining(".part-")]),
    );
  });

  it("configured production-equivalent byte limit를 넘는 stream을 hard-stop한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const provision = createChromiumProvisioner(
      adapters(home, {
        maxArchiveBytes: 4,
        http: {
          request: async () => ({
            statusCode: 200,
            headers: {},
            body: chunks([Buffer.from("12345")]),
            dispose: async () => undefined,
          }),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_DOWNLOAD_FAILED",
        cause: expect.any(Error),
      }),
    );
    expect(await readdir(pathsFor(cacheDirectory).root)).not.toEqual(
      expect.arrayContaining([expect.stringContaining(".part-")]),
    );
  });

  it.each([
    ["empty", ""],
    ["empty segment", "chrome-linux//chrome"],
    ["dot segment", "chrome-linux/./chrome"],
    ["dot-dot segment", "chrome-linux/../chrome"],
    ["absolute", "/chrome-linux/chrome"],
    ["leading slash", "//server/share"],
    ["trailing slash", "chrome-linux/chrome/"],
    ["backslash", "chrome-linux\\chrome"],
    ["Windows drive absolute", "C:/chrome/chrome.exe"],
    ["Windows drive relative", "C:chrome.exe"],
    ["Windows UNC", "\\\\server\\share\\chrome.exe"],
    ["NUL", "chrome-linux/chrome\0suffix"],
  ])(
    "unsafe ZIP %s path %j를 extraction 전에 거부한다",
    async (_name, path) => {
      const home = await temporaryDirectory();
      const cacheDirectory = join(home, "cache");
      const extract = vi.fn();
      const provision = createChromiumProvisioner(
        adapters(home, {
          archive: {
            open: async () => ({
              entries: [
                { path, kind: "file" as const },
                {
                  path: entry.executableRelativePath,
                  kind: "file" as const,
                },
              ],
              extract: extract as never,
              close: async () => undefined,
            }),
          },
        }),
      );

      await expect(provision({ cacheDirectory })).rejects.toEqual(
        expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
          code: "LBS_ARCHIVE_UNSAFE",
        }),
      );
      expect(extract).not.toHaveBeenCalled();
    },
  );

  it.each(["symlink", "hardlink", "device", "special", "unknown"] as const)(
    "ZIP %s entry를 extraction 전에 거부한다",
    async (kind) => {
      const home = await temporaryDirectory();
      const cacheDirectory = join(home, "cache");
      const extract = vi.fn();
      const provision = createChromiumProvisioner(
        adapters(home, {
          archive: {
            open: async () => ({
              entries: [
                { path: "unsafe", kind },
                {
                  path: entry.executableRelativePath,
                  kind: "file" as const,
                },
              ],
              extract: extract as never,
              close: async () => undefined,
            }),
          },
        }),
      );

      await expect(provision({ cacheDirectory })).rejects.toEqual(
        expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
          code: "LBS_ARCHIVE_UNSAFE",
        }),
      );
      expect(extract).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "duplicate normalized path",
      [
        { path: entry.executableRelativePath, kind: "file" as const },
        { path: entry.executableRelativePath, kind: "file" as const },
      ],
    ],
    [
      "file then descendant",
      [
        { path: "chrome-linux", kind: "file" as const },
        { path: entry.executableRelativePath, kind: "file" as const },
      ],
    ],
    [
      "descendant then file",
      [
        { path: entry.executableRelativePath, kind: "file" as const },
        { path: "chrome-linux", kind: "file" as const },
      ],
    ],
  ] as const)(
    "ZIP %s collision을 catalog 단계에서 거부한다",
    async (_name, entries) => {
      const home = await temporaryDirectory();
      const cacheDirectory = join(home, "cache");
      const extract = vi.fn();
      const provision = createChromiumProvisioner(
        adapters(home, {
          archive: {
            open: async () => ({
              entries,
              extract: extract as never,
              close: async () => undefined,
            }),
          },
        }),
      );

      await expect(provision({ cacheDirectory })).rejects.toEqual(
        expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
          code: "LBS_ARCHIVE_UNSAFE",
        }),
      );
      expect(extract).not.toHaveBeenCalled();
    },
  );

  it("expected executable이 없는 ZIP을 extraction 전에 archive invalid로 거부한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const extract = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        archive: {
          open: async () => ({
            entries: [{ path: "chrome-linux/other", kind: "file" }],
            extract: extract as never,
            close: async () => undefined,
          }),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_ARCHIVE_INVALID",
      }),
    );
    expect(extract).not.toHaveBeenCalled();
  });

  it("expected executable을 0755로 만들고 staging version 검증 뒤에만 manifest/final rename한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const events: string[] = [];
    const runVersion = vi.fn(async (executablePath: string) => {
      events.push("version");
      expect(executablePath).toContain(".staging-");
      await expect(
        access(join(dirname(executablePath), "..", "manifest.json")),
      ).rejects.toThrow();
      await expect(access(paths.finalDirectory)).rejects.toThrow();
      return entry.version;
    });
    const rename = vi.fn(async (source: string, destination: string) => {
      if (destination === paths.finalDirectory) {
        events.push("final-rename");
        expect(events).toEqual(["version", "final-rename"]);
      }
      await fsRename(source, destination);
    });
    const provision = createChromiumProvisioner(
      adapters(home, { runVersion, fs: { rename } }),
    );

    await provision({ cacheDirectory });

    expect((await stat(paths.executable)).mode & 0o777).toBe(0o755);
    expect(JSON.parse(await readFile(paths.manifest, "utf8"))).toEqual(
      manifest(),
    );
    expect(events).toEqual(["version", "final-rename"]);
  });

  it("archive open 실패는 verified archive를 보존하고 final/staging/lock을 정리한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const cause = new Error("invalid central directory");
    const provision = createChromiumProvisioner(
      adapters(home, {
        archive: { open: async () => Promise.reject(cause) },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_ARCHIVE_INVALID",
        cause,
      }),
    );
    await expect(access(paths.archive)).resolves.toBeUndefined();
    await expect(access(paths.finalDirectory)).rejects.toThrow();
    expect(await readdir(paths.root)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(".staging-"),
        "provision.lock",
      ]),
    );
  });

  it("extract 실패는 primary cause를 보존하고 staging/final/lock을 정리하며 archive를 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const cause = new Error("entry stream failed");
    const provision = createChromiumProvisioner(
      adapters(home, {
        archive: {
          open: async () => ({
            entries: [
              {
                path: entry.executableRelativePath,
                kind: "file" as const,
              },
            ],
            extract: async () => Promise.reject(cause),
            close: async () => undefined,
          }),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_ARCHIVE_INVALID",
        cause,
      }),
    );
    await expect(access(paths.archive)).resolves.toBeUndefined();
    await expect(access(paths.finalDirectory)).rejects.toThrow();
    expect(await readdir(paths.root)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(".staging-"),
        "provision.lock",
      ]),
    );
  });

  it("staging version mismatch는 final을 노출하지 않고 staging/lock을 정리하며 archive를 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const provision = createChromiumProvisioner(
      adapters(home, { runVersion: async () => "Chromium 76.0.0.0" }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_BROWSER_VERSION_MISMATCH",
      }),
    );
    await expect(access(paths.archive)).resolves.toBeUndefined();
    await expect(access(paths.finalDirectory)).rejects.toThrow();
    expect(await readdir(paths.root)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(".staging-"),
        "provision.lock",
      ]),
    );
  });

  it("final browser rename 실패는 staging/final/lock을 정리하며 verified archive를 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const cause = new Error("atomic rename failed");
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          rename: async (source, destination) => {
            if (destination === paths.finalDirectory) throw cause;
            await fsRename(source, destination);
          },
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_CACHE_IO",
        cause,
      }),
    );
    await expect(access(paths.archive)).resolves.toBeUndefined();
    await expect(access(paths.finalDirectory)).rejects.toThrow();
    expect(await readdir(paths.root)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(".staging-"),
        "provision.lock",
      ]),
    );
  });

  it("cleanup 실패가 있어도 extract primary error code와 cause를 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const cause = new Error("extract failed first");
    const provision = createChromiumProvisioner(
      adapters(home, {
        archive: {
          open: async () => ({
            entries: [
              {
                path: entry.executableRelativePath,
                kind: "file" as const,
              },
            ],
            extract: async () => Promise.reject(cause),
            close: async () => undefined,
          }),
        },
        fs: {
          rm: async () => Promise.reject(new Error("cleanup also failed")),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_ARCHIVE_INVALID",
        cause,
      }),
    );
  });

  it("retained archive가 변조되면 다음 호출에서 ZIP 전에 checksum mismatch로 실패한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const first = createChromiumProvisioner(
      adapters(home, {
        archive: {
          open: async () => ({
            entries: [
              {
                path: entry.executableRelativePath,
                kind: "file" as const,
              },
            ],
            extract: async () => Promise.reject(new Error("extract failed")),
            close: async () => undefined,
          }),
        },
      }),
    );
    await expect(first({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_ARCHIVE_INVALID",
    });
    await writeFile(paths.archive, "tampered cached archive");
    const archiveOpen = vi.fn();
    const second = createChromiumProvisioner(
      adapters(home, { archive: { open: archiveOpen as never } }),
    );

    await expect(second({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CHECKSUM_MISMATCH",
    });
    expect(archiveOpen).not.toHaveBeenCalled();
  });

  it("동시 호출은 exclusive lock 뒤 cache를 재검사해 download/extract를 한 번만 수행한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const request = vi.fn(async () => {
      const owner = JSON.parse(await readFile(paths.lock, "utf8")) as {
        pid: number;
        token: string;
        startTime: string;
      };
      expect(owner).toEqual({
        pid: 101,
        token: expect.any(String),
        startTime: "current-start",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return {
        statusCode: 200,
        headers: {},
        body: chunks([archiveBytes]),
        dispose: async () => undefined,
      };
    });
    const extract = vi.fn(async (_archiveEntry, destination: string) => {
      await writeFile(destination, "synthetic chromium executable");
    });
    const archiveOpen = vi.fn(async () => ({
      entries: [
        {
          path: entry.executableRelativePath,
          kind: "file" as const,
          mode: 0o755,
        },
      ],
      extract,
      close: async () => undefined,
    }));
    const provision = createChromiumProvisioner(
      adapters(home, {
        http: { request },
        archive: { open: archiveOpen },
        processIdentity: {
          current: async () => ({ pid: 101, startTime: "current-start" }),
          lookup: async () => ({ alive: true, startTime: "current-start" }),
        },
      }),
    );

    const [first, second] = await Promise.all([
      provision({ cacheDirectory }),
      provision({ cacheDirectory }),
    ]);

    expect(first).toEqual(second);
    expect(request).toHaveBeenCalledTimes(1);
    expect(archiveOpen).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);
    await expect(access(paths.lock)).rejects.toThrow();
  });

  it.each([
    ["dead owner", { alive: false } as const],
    ["reused PID", { alive: true, startTime: "successor-process" } as const],
  ])(
    "%s lock도 waiter가 제거하지 않고 bounded timeout한다",
    async (_name, lookupResult) => {
      const home = await temporaryDirectory();
      const cacheDirectory = join(home, "cache");
      const paths = pathsFor(cacheDirectory);
      const existingOwner = {
        pid: 404,
        token: "existing-owner-token",
        startTime: "old-process",
      };
      await createPrivateManagedRoot(cacheDirectory);
      await writeFile(paths.lock, `${JSON.stringify(existingOwner)}\n`);
      let now = 0;
      const lookup = vi.fn(async () => lookupResult);
      const request = vi.fn();
      const provision = createChromiumProvisioner(
        adapters(home, {
          http: { request: request as never },
          processIdentity: {
            current: async () => ({ pid: 101, startTime: "current-start" }),
            lookup: lookup as never,
          },
          clock: {
            now: () => now,
            sleep: async (milliseconds) => {
              now += milliseconds;
            },
            randomToken: () => "waiter-token",
          },
        }),
      );

      await expect(
        provision({
          cacheDirectory,
          lockTimeoutMs: 2,
          lockPollIntervalMs: 1,
        }),
      ).rejects.toMatchObject({ code: "LBS_PROVISION_LOCK_TIMEOUT" });
      expect(JSON.parse(await readFile(paths.lock, "utf8"))).toEqual(
        existingOwner,
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("두 waiter는 기존 successor lock을 제거하거나 교체하지 않고 함께 timeout한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const successor = {
      pid: 404,
      token: "successor-token",
      startTime: "successor-start",
    };
    const originalLockBytes = Buffer.from(
      ` \t${JSON.stringify(successor)} \r\n`,
      "utf8",
    );
    await createPrivateManagedRoot(cacheDirectory);
    await writeFile(paths.lock, originalLockBytes);
    let now = 0;
    const rename = vi.fn(fsRename);
    const unlink = vi.fn(async (path: string) => rm(path));
    const request = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        http: { request: request as never },
        fs: { rename, unlink },
        processIdentity: {
          current: async () => ({ pid: 101, startTime: "current-start" }),
          lookup: async () => ({ alive: false }),
        },
        clock: {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
          randomToken: () => "waiter-token",
        },
      }),
    );

    const settled = await Promise.allSettled([
      provision({
        cacheDirectory,
        lockTimeoutMs: 2,
        lockPollIntervalMs: 1,
      }),
      provision({
        cacheDirectory,
        lockTimeoutMs: 2,
        lockPollIntervalMs: 1,
      }),
    ]);

    expect(settled).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "LBS_PROVISION_LOCK_TIMEOUT" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "LBS_PROVISION_LOCK_TIMEOUT" }),
      }),
    ]);
    expect(await readFile(paths.lock)).toEqual(originalLockBytes);
    expect(rename).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("verified live owner lock은 age만으로 훔치지 않고 bounded timeout한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const liveOwner = {
      pid: 404,
      token: "live-owner-token",
      startTime: "live-process",
    };
    await createPrivateManagedRoot(cacheDirectory);
    await writeFile(paths.lock, `${JSON.stringify(liveOwner)}\n`);
    let now = 1_000_000;
    const provision = createChromiumProvisioner(
      adapters(home, {
        processIdentity: {
          current: async () => ({ pid: 101, startTime: "current-start" }),
          lookup: async () => ({ alive: true, startTime: "live-process" }),
        },
        clock: {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
          randomToken: () => "waiter-token",
        },
      }),
    );

    await expect(
      provision({
        cacheDirectory,
        lockTimeoutMs: 3,
        lockPollIntervalMs: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_PROVISION_LOCK_TIMEOUT",
      }),
    );
    expect(JSON.parse(await readFile(paths.lock, "utf8"))).toEqual(liveOwner);
  });

  it("1ms lock timeout은 sleep을 남은 deadline으로 제한하고 post-sleep acquire를 막는다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const liveOwner = {
      pid: 404,
      token: "live-owner-token",
      startTime: "live-start",
    };
    await createPrivateManagedRoot(cacheDirectory);
    await writeFile(paths.lock, `${JSON.stringify(liveOwner)}\n`, {
      mode: 0o600,
    });
    let now = 0;
    const sleeps: number[] = [];
    let lockOpenAttempts = 0;
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          open: async (path, flags, mode) => {
            if (path === paths.lock) lockOpenAttempts += 1;
            return fsOpen(path, flags, mode);
          },
        },
        processIdentity: {
          current: async () => ({ pid: 101, startTime: "waiter-start" }),
          lookup: async () => ({ alive: true, startTime: "live-start" }),
        },
        clock: {
          now: () => now,
          sleep: async (milliseconds) => {
            sleeps.push(milliseconds);
            now += milliseconds;
          },
          randomToken: () => "waiter-token",
        },
      }),
    );

    await expect(
      provision({
        cacheDirectory,
        lockTimeoutMs: 1,
        lockPollIntervalMs: 50,
      }),
    ).rejects.toMatchObject({ code: "LBS_PROVISION_LOCK_TIMEOUT" });
    expect(sleeps).toEqual([1]);
    expect(lockOpenAttempts).toBe(1);
    expect(JSON.parse(await readFile(paths.lock, "utf8"))).toEqual(liveOwner);
  });

  it("재시도 identity 조회가 deadline을 넘기면 두 번째 lock open 전에 timeout한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    await createPrivateManagedRoot(cacheDirectory);
    await writeFile(paths.lock, "{existing-lock");
    let now = 0;
    let identityCalls = 0;
    let lockOpenAttempts = 0;
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          open: async (path, flags, mode) => {
            if (path === paths.lock) lockOpenAttempts += 1;
            return fsOpen(path, flags, mode);
          },
        },
        processIdentity: {
          current: async () => {
            identityCalls += 1;
            if (identityCalls === 2) now = 6;
            return { pid: 101, startTime: "waiter-start" };
          },
          lookup: async () => ({ alive: false }),
        },
        clock: {
          now: () => now,
          sleep: async () => undefined,
          randomToken: () => "waiter-token",
        },
      }),
    );

    await expect(
      provision({
        cacheDirectory,
        lockTimeoutMs: 5,
        lockPollIntervalMs: 1,
      }),
    ).rejects.toMatchObject({ code: "LBS_PROVISION_LOCK_TIMEOUT" });
    expect(identityCalls).toBe(2);
    expect(lockOpenAttempts).toBe(1);
    expect(await readFile(paths.lock, "utf8")).toBe("{existing-lock");
  });

  it("손상된 owner metadata는 fail-closed하고 임의 삭제하지 않는다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    await createPrivateManagedRoot(cacheDirectory);
    await writeFile(paths.lock, "{damaged");
    let now = 0;
    const provision = createChromiumProvisioner(
      adapters(home, {
        clock: {
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
          randomToken: () => "waiter-token",
        },
      }),
    );

    await expect(
      provision({
        cacheDirectory,
        lockTimeoutMs: 2,
        lockPollIntervalMs: 1,
      }),
    ).rejects.toMatchObject({ code: "LBS_PROVISION_LOCK_TIMEOUT" });
    expect(await readFile(paths.lock, "utf8")).toBe("{damaged");
  });

  it("lock wait abort는 LBS_ABORTED로 끝나고 live owner lock을 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const liveOwner = {
      pid: 404,
      token: "live-owner-token",
      startTime: "live-process",
    };
    await createPrivateManagedRoot(cacheDirectory);
    await writeFile(paths.lock, `${JSON.stringify(liveOwner)}\n`);
    const controller = new AbortController();
    const provision = createChromiumProvisioner(
      adapters(home, {
        processIdentity: {
          current: async () => ({ pid: 101, startTime: "current-start" }),
          lookup: async () => ({ alive: true, startTime: "live-process" }),
        },
        clock: {
          now: () => 0,
          sleep: async () => {
            controller.abort(new Error("cancel wait"));
            throw controller.signal.reason;
          },
          randomToken: () => "waiter-token",
        },
      }),
    );

    await expect(
      provision({ cacheDirectory, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "LBS_ABORTED" });
    expect(JSON.parse(await readFile(paths.lock, "utf8"))).toEqual(liveOwner);
  });

  it("release 시 lock token이 successor로 바뀌었으면 successor lock을 삭제하지 않는다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const successor = {
      pid: 202,
      token: "successor-token",
      startTime: "successor-start",
    };
    const provision = createChromiumProvisioner(
      adapters(home, {
        runVersion: async () => {
          await writeFile(paths.lock, `${JSON.stringify(successor)}\n`);
          return "Chromium 76.0.0.0";
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_BROWSER_VERSION_MISMATCH",
    });
    expect(JSON.parse(await readFile(paths.lock, "utf8"))).toEqual(successor);
  });

  it("HTTPS가 아닌 entry.archiveUrl은 HTTP adapter 전에 download failure로 거부한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const request = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        entry: { ...entry, archiveUrl: "http://example.test/chromium.zip" },
        http: { request: request as never },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_DOWNLOAD_FAILED",
      cause: expect.any(Error),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("lock metadata write 중 실패하면 caller-owned partial lock을 정리하고 cache error cause를 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const cause = new Error("lock metadata write failed");
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          open: async (path, flags, mode) => {
            const handle = await fsOpen(path, flags, mode);
            if (path !== paths.lock) return handle;
            return {
              writeFile: async (contents: string | Uint8Array) => {
                await handle.writeFile(contents);
                throw cause;
              },
              sync: () => handle.sync(),
              close: () => handle.close(),
            } as never;
          },
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
      cause,
    });
    await expect(access(paths.lock)).rejects.toThrow();
  });

  it("current process identity 조회 실패를 cause가 있는 cache error로 바꾼다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const cause = new Error("procfs unavailable");
    const provision = createChromiumProvisioner(
      adapters(home, {
        processIdentity: {
          current: async () => Promise.reject(cause),
          lookup: async () => ({ alive: false }),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
      cause,
    });
  });

  it("ZIP close 실패를 archive invalid로 바꾸고 final/staging/lock을 정리한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const cause = new Error("zip close failed");
    const provision = createChromiumProvisioner(
      adapters(home, {
        archive: {
          open: async () => ({
            entries: [
              {
                path: entry.executableRelativePath,
                kind: "file" as const,
              },
            ],
            extract: async (_archiveEntry, destination) => {
              await writeFile(destination, "synthetic chromium executable");
            },
            close: async () => Promise.reject(cause),
          }),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_ARCHIVE_INVALID",
      cause,
    });
    await expect(access(paths.finalDirectory)).rejects.toThrow();
    expect(await readdir(paths.root)).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining(".staging-"),
        "provision.lock",
      ]),
    );
  });

  it("staging chmod 실패를 cache error로 바꾸고 primary cause와 verified archive를 보존한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const cause = new Error("chmod failed");
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: { chmod: async () => Promise.reject(cause) },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
      cause,
    });
    await expect(access(paths.archive)).resolves.toBeUndefined();
    await expect(access(paths.finalDirectory)).rejects.toThrow();
  });

  it("성공 경로의 owned lock release 실패를 cache error로 보고한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const cause = new Error("lock unlink failed");
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: { unlink: async () => Promise.reject(cause) },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
      cause,
    });
  });

  it("primary extract 오류가 lock release cleanup 오류보다 우선한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const primary = new Error("extract failed first");
    const provision = createChromiumProvisioner(
      adapters(home, {
        archive: {
          open: async () => ({
            entries: [
              {
                path: entry.executableRelativePath,
                kind: "file" as const,
              },
            ],
            extract: async () => Promise.reject(primary),
            close: async () => undefined,
          }),
        },
        fs: {
          unlink: async () => Promise.reject(new Error("release also failed")),
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_ARCHIVE_INVALID",
      cause: primary,
    });
  });

  it("installed package directory를 explicit cache로 지정해도 filesystem 전에 거부한다", async () => {
    const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
    const fsTouched = vi.fn();
    const request = vi.fn();
    const provision = createChromiumProvisioner({
      fs: new Proxy(
        {},
        {
          get: () => () => {
            fsTouched();
            throw new Error("filesystem must stay uncalled");
          },
        },
      ) as never,
      http: { request: request as never },
    });

    await expect(
      provision({ cacheDirectory: packageDirectory }),
    ).rejects.toMatchObject({ code: "LBS_CACHE_IO" });
    expect(fsTouched).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("managed namespace symlink을 따라 cache root 밖에 쓰지 않는다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const outside = join(home, "outside");
    await mkdir(cacheDirectory);
    await mkdir(outside);
    await symlink(outside, join(cacheDirectory, "@cp949"));
    const request = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, { http: { request: request as never } }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
    });
    expect(request).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual([]);
  });

  it("private 0700 staging과 stripped regular modes를 file/directory fsync 뒤 finalize한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const syncedFiles: string[] = [];
    const syncedDirectories: string[] = [];
    const syncFile = async (path: string): Promise<void> => {
      syncedFiles.push(path);
      const handle = await fsOpen(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const syncDirectory = async (path: string): Promise<void> => {
      syncedDirectories.push(path);
      const handle = await fsOpen(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    let observedStagingMode = 0;
    const provision = createChromiumProvisioner(
      adapters(home, {
        archive: {
          open: async () => ({
            entries: [
              { path: "chrome-linux", kind: "directory" as const },
              {
                path: "chrome-linux/resources.dat",
                kind: "file" as const,
                mode: 0o7644,
              },
              {
                path: entry.executableRelativePath,
                kind: "file" as const,
                mode: 0o4755,
              },
            ],
            extract: async (_archiveEntry, destination) => {
              const staging = join(dirname(destination), "..");
              observedStagingMode = (await stat(staging)).mode & 0o777;
              await writeFile(destination, "synthetic file");
            },
            close: async () => undefined,
          }),
        },
        fs: { syncFile, syncDirectory },
      }),
    );

    await provision({ cacheDirectory });

    expect(observedStagingMode).toBe(0o700);
    expect(
      (await stat(join(paths.finalDirectory, "chrome-linux", "resources.dat")))
        .mode & 0o777,
    ).toBe(0o644);
    expect((await stat(paths.executable)).mode & 0o777).toBe(0o755);
    expect(syncedFiles).toEqual(
      expect.arrayContaining([
        expect.stringContaining("resources.dat"),
        expect.stringContaining("chrome-linux/chrome"),
      ]),
    );
    expect(syncedDirectories).toEqual(
      expect.arrayContaining([
        expect.stringContaining("chrome-linux"),
        expect.stringContaining(".staging-"),
        paths.root,
      ]),
    );
  });

  it("part file writer가 partial write를 허용해도 전체 archive bytes를 durable하게 기록한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          open: async (path, flags, mode) => {
            const handle = await fsOpen(path, flags, mode);
            if (!path.includes(".part-")) return handle;
            return {
              write: (contents: Uint8Array) =>
                handle.write(contents.subarray(0, 1)),
              writeFile: (contents: string | Uint8Array) =>
                handle.writeFile(contents),
              sync: () => handle.sync(),
              close: () => handle.close(),
            } as never;
          },
        },
      }),
    );

    await provision({ cacheDirectory });

    expect(await readFile(paths.archive)).toEqual(archiveBytes);
  });

  it("download primary write 오류를 close cleanup 오류보다 우선한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const primary = new Error("part write failed");
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          open: async (path, flags, mode) => {
            const handle = await fsOpen(path, flags, mode);
            if (!path.includes(".part-")) return handle;
            return {
              write: async () => Promise.reject(primary),
              writeFile: async () => Promise.reject(primary),
              sync: () => handle.sync(),
              close: async () => {
                await handle.close();
                throw new Error("part close also failed");
              },
            } as never;
          },
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_DOWNLOAD_FAILED",
      cause: primary,
    });
  });

  it("owned lock metadata read I/O 실패를 성공으로 숨기지 않고 cache error로 보고한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const cause = new Error("lock read denied");
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          readFile: async (path, encoding) => {
            if (
              path === paths.lock ||
              path.includes("provision.lock.quarantine-")
            ) {
              throw cause;
            }
            return readFile(path, encoding);
          },
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
      cause,
    });
  });

  it("path에 사용할 수 없는 random ownership token은 lock/HTTP 전에 TypeError로 거부한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const request = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        http: { request: request as never },
        clock: {
          now: () => 0,
          sleep: async () => undefined,
          randomToken: () => "../../escape",
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(access(paths.lock)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("retained archive가 symlink로 대체되면 ZIP adapter 전에 fail-closed한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = pathsFor(cacheDirectory);
    const first = createChromiumProvisioner(
      adapters(home, {
        archive: {
          open: async () => ({
            entries: [
              {
                path: entry.executableRelativePath,
                kind: "file" as const,
              },
            ],
            extract: async () => Promise.reject(new Error("extract failed")),
            close: async () => undefined,
          }),
        },
      }),
    );
    await expect(first({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_ARCHIVE_INVALID",
    });
    const outsideArchive = join(home, "outside-archive.zip");
    await writeFile(outsideArchive, archiveBytes);
    await rm(paths.archive);
    await symlink(outsideArchive, paths.archive);
    const archiveOpen = vi.fn();
    const second = createChromiumProvisioner(
      adapters(home, { archive: { open: archiveOpen as never } }),
    );

    await expect(second({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CHECKSUM_MISMATCH",
    });
    expect(archiveOpen).not.toHaveBeenCalled();
  });

  it("manifest primary write 오류를 handle close cleanup 오류보다 우선한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const primary = new Error("manifest write failed");
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          open: async (path, flags, mode) => {
            const handle = await fsOpen(path, flags, mode);
            if (!path.endsWith("manifest.json")) return handle;
            return {
              writeFile: async () => Promise.reject(primary),
              sync: () => handle.sync(),
              close: async () => {
                await handle.close();
                throw new Error("manifest close also failed");
              },
            } as never;
          },
        },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
      cause: primary,
    });
  });

  const seedWarmCache = async (
    cacheDirectory: string,
    options: {
      readonly manifestValue?: unknown;
      readonly mode?: number;
      readonly executableKind?: "file" | "directory" | "symlink";
    } = {},
  ): Promise<ReturnType<typeof pathsFor>> => {
    const paths = pathsFor(cacheDirectory);
    await mkdir(join(paths.finalDirectory, "chrome-linux"), {
      recursive: true,
      mode: 0o755,
    });
    await chmod(join(cacheDirectory, "@cp949", "legacy-browser-smoke"), 0o700);
    if (options.executableKind === "directory") {
      await mkdir(paths.executable);
    } else if (options.executableKind === "symlink") {
      const target = join(paths.root, "caller-owned-target");
      await writeFile(target, "target", { mode: 0o755 });
      await symlink(target, paths.executable);
    } else {
      await writeFile(paths.executable, "cached chromium", {
        mode: options.mode ?? 0o755,
      });
      await chmod(paths.executable, options.mode ?? 0o755);
    }
    if (options.manifestValue !== null) {
      await writeFile(
        paths.manifest,
        `${JSON.stringify(options.manifestValue ?? manifest())}\n`,
      );
    }
    return paths;
  };

  it("group-writable precreated package namespace는 HTTP 전에 fail-closed한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const packageNamespace = join(
      cacheDirectory,
      "@cp949",
      "legacy-browser-smoke",
    );
    await mkdir(packageNamespace, { recursive: true, mode: 0o700 });
    await chmod(packageNamespace, 0o770);
    const request = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, { http: { request: request as never } }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("non-sticky world-writable cache root는 namespace 교체 위험으로 거부한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "shared-cache");
    await mkdir(cacheDirectory, { mode: 0o777 });
    await chmod(cacheDirectory, 0o777);
    const request = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, { http: { request: request as never } }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_CACHE_IO",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("sticky world-writable cache root는 owned private namespace를 허용한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "sticky-shared-cache");
    await mkdir(cacheDirectory, { mode: 0o1777 });
    await chmod(cacheDirectory, 0o1777);
    const provision = createChromiumProvisioner(adapters(home));

    await expect(provision({ cacheDirectory })).resolves.toMatchObject({
      version: entry.version,
    });
  });

  it("group-writable warm manifest는 version 실행과 redownload 전에 fail-closed한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = await seedWarmCache(cacheDirectory);
    await chmod(paths.manifest, 0o660);
    const runVersion = vi.fn(async () => entry.version);
    const request = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        runVersion,
        http: { request: request as never },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_BROWSER_VERSION_MISMATCH",
    });
    expect(runVersion).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("다른 UID가 소유한 warm executable은 version 실행 전에 fail-closed한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = await seedWarmCache(cacheDirectory);
    const runVersion = vi.fn(async () => entry.version);
    const request = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        fs: {
          lstat: async (path) => {
            const stats = await stat(path);
            if (path !== paths.executable) return stats;
            return new Proxy(stats, {
              get: (target, property, receiver) => {
                if (property === "uid") return target.uid + 1;
                const value = Reflect.get(
                  target,
                  property,
                  receiver,
                ) as unknown;
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        },
        runVersion,
        http: { request: request as never },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toMatchObject({
      code: "LBS_BROWSER_VERSION_MISMATCH",
    });
    expect(runVersion).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("strict warm cache를 매 호출 exact version으로 재검증한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    const paths = await seedWarmCache(cacheDirectory);
    const runVersion = vi.fn(async () => entry.version);
    const http = vi.fn();
    const archive = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        runVersion,
        http: { request: http as never },
        archive: { open: archive as never },
      }),
    );

    await expect(provision({ cacheDirectory })).resolves.toEqual({
      path: paths.executable,
      revision: entry.revision,
      version: entry.version,
    });
    await expect(provision({ cacheDirectory })).resolves.toMatchObject({
      path: paths.executable,
    });
    expect(runVersion).toHaveBeenCalledTimes(2);
    expect(http).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it.each([
    ["missing manifest", null],
    ["malformed manifest", "not-json"],
    ["wrong field", manifest({ revision: "650584" })],
    ["extra field", manifest({ extra: true })],
  ])(
    "%s warm cache는 fail-closed하고 같은 호출에서 redownload하지 않는다",
    async (_name, manifestValue) => {
      const home = await temporaryDirectory();
      const cacheDirectory = join(home, "cache");
      const paths = await seedWarmCache(cacheDirectory, {
        manifestValue: manifestValue === "not-json" ? null : manifestValue,
      });
      if (manifestValue === "not-json") {
        await writeFile(paths.manifest, "{not-json");
      }
      const http = vi.fn();
      const provision = createChromiumProvisioner(
        adapters(home, { http: { request: http as never } }),
      );

      await expect(provision({ cacheDirectory })).rejects.toEqual(
        expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
          code: "LBS_BROWSER_VERSION_MISMATCH",
        }),
      );
      expect(http).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["directory", { executableKind: "directory" as const }],
    ["symlink", { executableKind: "symlink" as const }],
    ["wrong mode", { mode: 0o700 }],
  ])(
    "%s warm executable을 regular non-symlink 0755 mismatch로 거부한다",
    async (_name, options) => {
      const home = await temporaryDirectory();
      const cacheDirectory = join(home, "cache");
      await seedWarmCache(cacheDirectory, options);
      const runVersion = vi.fn(async () => entry.version);
      const http = vi.fn();
      const provision = createChromiumProvisioner(
        adapters(home, {
          runVersion,
          http: { request: http as never },
        }),
      );

      await expect(provision({ cacheDirectory })).rejects.toEqual(
        expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
          code: "LBS_BROWSER_VERSION_MISMATCH",
        }),
      );
      expect(runVersion).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
    },
  );

  it("warm executable의 성공한 version text mismatch를 redownload 없이 거부한다", async () => {
    const home = await temporaryDirectory();
    const cacheDirectory = join(home, "cache");
    await seedWarmCache(cacheDirectory);
    const http = vi.fn();
    const provision = createChromiumProvisioner(
      adapters(home, {
        runVersion: async () => "Chromium 76.0.0.0",
        http: { request: http as never },
      }),
    );

    await expect(provision({ cacheDirectory })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_BROWSER_VERSION_MISMATCH",
      }),
    );
    expect(http).not.toHaveBeenCalled();
  });
});
