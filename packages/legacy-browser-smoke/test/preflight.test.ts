import { describe, expect, it } from "vitest";
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
