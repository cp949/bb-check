import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromiumProvisioner } from "../src/chromium.js";
import { LegacyBrowserSmokeError } from "../src/errors.js";
import {
  createBrowserRegistryEntry,
  lookupBrowserRegistry,
} from "../src/registry.js";

const archiveUrl =
  "https://storage.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Linux_x64%2F650583%2Fchrome-linux.zip?generation=1555131417316559&alt=media";
const sha256 =
  "10ae4e05d9f01a8b646dd2ccc2ac1135e597c472abe5be71552aae7d8a35e2ac";

describe("exact Chromium 75 registry", () => {
  it("Linux x64에서 generation-pinned Chromium 75 entry의 분리된 동결 사본을 반환한다", () => {
    const first = lookupBrowserRegistry("linux", "x64");
    const second = lookupBrowserRegistry("linux", "x64");

    expect(first).toEqual({
      platform: "linux-x64",
      revision: "650583",
      version: "Chromium 75.0.3765.0",
      archiveUrl,
      executableRelativePath: "chrome-linux/chrome",
      sha256,
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("필수 registry own field가 없으면 I/O 전에 거부한다", () => {
    const entry = {
      platform: "linux-x64",
      revision: "650583",
      version: "Chromium 75.0.3765.0",
      archiveUrl,
      executableRelativePath: "chrome-linux/chrome",
      sha256,
    };
    delete (entry as Partial<typeof entry>).sha256;

    expect(() => createBrowserRegistryEntry(entry)).toThrow(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_CONFIG_INVALID",
      }),
    );
  });

  it.each([
    ["darwin", "arm64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const)(
    "지원하지 않는 %s/%s는 provision 전에 안정된 오류를 반환한다",
    (platform, arch) => {
      expect(() => lookupBrowserRegistry(platform, arch)).toThrow(
        expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
          code: "LBS_PLATFORM_UNSUPPORTED",
          name: "LegacyBrowserSmokeError",
        }),
      );
    },
  );

  it.each([
    { sha256: "" },
    { sha256: sha256.toUpperCase() },
    { archiveUrl: "http://example.test/archive.zip" },
    {
      archiveUrl: archiveUrl.replace(
        "generation=1555131417316559",
        "generation=1",
      ),
    },
    { executableRelativePath: "../chrome" },
    { revision: "650584" },
    { version: "Chromium 75" },
  ])("비정확한 registry field를 I/O 전에 거부한다", (override) => {
    expect(() =>
      createBrowserRegistryEntry({
        platform: "linux-x64",
        revision: "650583",
        version: "Chromium 75.0.3765.0",
        archiveUrl,
        executableRelativePath: "chrome-linux/chrome",
        sha256,
        ...override,
      }),
    ).toThrow(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_CONFIG_INVALID",
      }),
    );
  });
});

describe("Chromium preflight", () => {
  const temporaryDirectories: string[] = [];

  const temporaryDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "lbs-preflight-"));
    temporaryDirectories.push(directory);
    return directory;
  };

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("Node 20은 filesystem·HTTP·process·archive·lock보다 먼저 거부한다", async () => {
    const touched: string[] = [];
    const tripwire = (name: string) => () => {
      touched.push(name);
      throw new Error(`${name} must stay uncalled`);
    };
    const fs = new Proxy({}, { get: () => tripwire("filesystem") }) as never;
    const provision = createChromiumProvisioner({
      nodeVersion: "20.19.0",
      fs,
      http: { request: tripwire("HTTP") as never },
      archive: { open: tripwire("archive") as never },
      runVersion: tripwire("process") as never,
      processIdentity: {
        current: tripwire("lock") as never,
        lookup: tripwire("lock") as never,
      },
    });

    await expect(provision()).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_NODE_UNSUPPORTED",
      }),
    );
    expect(touched).toEqual([]);
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const)(
    "자동 provision의 %s/%s는 cache·network·archive·lock 전에 거부한다",
    async (platform, arch) => {
      const touched: string[] = [];
      const tripwire = (name: string) => () => {
        touched.push(name);
        throw new Error(`${name} must stay uncalled`);
      };
      const fs = new Proxy({}, { get: () => tripwire("filesystem") }) as never;
      const provision = createChromiumProvisioner({
        platform,
        arch,
        fs,
        http: { request: tripwire("HTTP") as never },
        archive: { open: tripwire("archive") as never },
        runVersion: tripwire("process") as never,
        processIdentity: {
          current: tripwire("lock") as never,
          lookup: tripwire("lock") as never,
        },
      });

      await expect(provision()).rejects.toEqual(
        expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
          code: "LBS_PLATFORM_UNSUPPORTED",
        }),
      );
      expect(touched).toEqual([]);
    },
  );

  it("absolute explicit executable은 exact version을 확인하고 자동 provision adapter를 건너뛴다", async () => {
    const directory = await temporaryDirectory();
    const executablePath = join(directory, "chromium");
    await writeFile(executablePath, "fixture");
    await chmod(executablePath, 0o755);
    const runVersion = vi.fn(async () => "Chromium 75.0.3765.0");
    const automaticTouched: string[] = [];
    const tripwire = (name: string) => () => {
      automaticTouched.push(name);
      throw new Error(`${name} must stay uncalled`);
    };
    const provision = createChromiumProvisioner({
      platform: "darwin",
      arch: "arm64",
      http: { request: tripwire("HTTP") as never },
      archive: { open: tripwire("archive") as never },
      processIdentity: {
        current: tripwire("lock") as never,
        lookup: tripwire("lock") as never,
      },
      runVersion,
    });

    await expect(provision({ executablePath })).resolves.toEqual({
      path: executablePath,
      revision: "650583",
      version: "Chromium 75.0.3765.0",
    });
    expect(runVersion).toHaveBeenCalledWith(
      executablePath,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(automaticTouched).toEqual([]);
  });

  it("explicit executable 검증은 caller-owned 파일을 chmod하지 않는다", async () => {
    const directory = await temporaryDirectory();
    const executablePath = join(directory, "chromium");
    await writeFile(executablePath, "fixture");
    await chmod(executablePath, 0o755);
    const chmodSpy = vi.fn(async () => {
      throw new Error("chmod must stay uncalled");
    });
    const provision = createChromiumProvisioner({
      fs: { chmod: chmodSpy },
      runVersion: async () => "Chromium 75.0.3765.0",
    });

    await expect(provision({ executablePath })).resolves.toMatchObject({
      path: executablePath,
    });
    expect(chmodSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["relative", "relative/chromium"],
    ["missing", "missing"],
    ["directory", "directory"],
    ["symlink", "symlink"],
    ["non-executable", "non-executable"],
  ] as const)("%s explicit executable을 거부한다", async (kind, name) => {
    const directory = await temporaryDirectory();
    const executablePath = kind === "relative" ? name : join(directory, name);
    if (kind === "directory") {
      await mkdir(executablePath);
    } else if (kind === "symlink") {
      const target = join(directory, "target");
      await writeFile(target, "fixture");
      await chmod(target, 0o755);
      await symlink(target, executablePath);
    } else if (kind === "non-executable") {
      await writeFile(executablePath, "fixture", { mode: 0o644 });
    }
    const runVersion = vi.fn(async () => "Chromium 75.0.3765.0");
    const provision = createChromiumProvisioner({ runVersion });

    await expect(provision({ executablePath })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_BROWSER_EXECUTABLE_INVALID",
      }),
    );
    expect(runVersion).not.toHaveBeenCalled();
  });

  it("explicit executable의 성공한 --version 결과가 다르면 version mismatch로 실패한다", async () => {
    const directory = await temporaryDirectory();
    const executablePath = join(directory, "chromium");
    await writeFile(executablePath, "fixture");
    await chmod(executablePath, 0o755);
    const provision = createChromiumProvisioner({
      runVersion: async () => "Chromium 76.0.0.0",
    });

    await expect(provision({ executablePath })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_BROWSER_VERSION_MISMATCH",
      }),
    );
  });

  it("explicit executable의 --version process 실패를 cause와 함께 안정된 오류로 바꾼다", async () => {
    const directory = await temporaryDirectory();
    const executablePath = join(directory, "chromium");
    await writeFile(executablePath, "fixture");
    await chmod(executablePath, 0o755);
    const cause = new Error("spawn failed");
    const provision = createChromiumProvisioner({
      runVersion: async () => Promise.reject(cause),
    });

    await expect(provision({ executablePath })).rejects.toEqual(
      expect.objectContaining<Partial<LegacyBrowserSmokeError>>({
        code: "LBS_BROWSER_EXECUTABLE_INVALID",
        cause,
      }),
    );
  });
});
