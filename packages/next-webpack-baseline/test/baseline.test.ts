import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBrowserBaseline } from "../src/baseline.js";
import { NextWebpackBaselineError } from "../src/errors.js";

const packageDir = dirname(fileURLToPath(import.meta.url));
const legacyFixture = resolve(packageDir, "fixtures/browserslist-legacy");
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map(async (dir) => {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { force: true, recursive: true });
    }),
  );
});

describe("resolveBrowserBaseline", () => {
  it("projectDir의 production Browserslist를 legacy target과 비지원 구문으로 계산한다", () => {
    const baseline = resolveBrowserBaseline(legacyFixture);

    expect(baseline.targets).toEqual(["chrome 75", "firefox 68"]);
    expect([...baseline.unsupportedSyntax].sort()).toEqual([
      "class-properties",
      "logical-assignment-operators",
      "nullish-coalescing",
      "numeric-separator",
      "optional-chaining",
      "private-methods",
    ]);
  });

  it("browserslist가 없으면 NWB_BROWSERSLIST_MISSING으로 중단한다", () => {
    expect(() =>
      resolveBrowserBaseline(resolve(packageDir, "fixtures")),
    ).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_BROWSERSLIST_MISSING",
      }),
    );
  });

  it("해석할 수 없는 production Browserslist를 NWB_CONFIG_INVALID로 중단한다", async () => {
    const fixture = await mkdtemp(
      resolve(tmpdir(), "nwb-invalid-browserslist-"),
    );
    temporaryDirs.push(fixture);
    await writeFile(
      resolve(fixture, "package.json"),
      JSON.stringify({
        name: "invalid-browserslist-fixture",
        private: true,
        browserslist: { production: 42 },
      }),
      "utf8",
    );

    let caught: unknown;
    try {
      resolveBrowserBaseline(fixture);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_CONFIG_INVALID",
      }),
    );
    expect((caught as Error).message).not.toContain(
      "Browserslist config should be a string",
    );
    expect((caught as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it("모든 target이 지원 가능한 최신 구문이면 NWB_BROWSERSLIST_MODERN_ONLY로 중단한다", async () => {
    const fixture = await mkdtemp(resolve(tmpdir(), "nwb-modern-only-"));
    temporaryDirs.push(fixture);
    await writeFile(
      resolve(fixture, "package.json"),
      JSON.stringify({
        name: "modern-only-fixture",
        private: true,
        browserslist: { production: ["chrome 100"] },
      }),
      "utf8",
    );

    expect(() => resolveBrowserBaseline(fixture)).toThrow(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_BROWSERSLIST_MODERN_ONLY",
      }),
    );
  });

  it("compat-data의 Chrome 91 optional chaining 지원 경계를 baseline에 반영한다", async () => {
    const fixture = await mkdtemp(resolve(tmpdir(), "nwb-compat-data-"));
    temporaryDirs.push(fixture);
    await writeFile(
      resolve(fixture, "package.json"),
      JSON.stringify({
        name: "compat-data-fixture",
        private: true,
        browserslist: { production: ["chrome 90"] },
      }),
      "utf8",
    );

    const baseline = resolveBrowserBaseline(fixture);

    expect(baseline.targets).toEqual(["chrome 90"]);
    expect([...baseline.unsupportedSyntax]).toEqual(["optional-chaining"]);
  });

  it("같은 projectDir의 target 정규화 결과를 안정적으로 유지한다", () => {
    const first = resolveBrowserBaseline(legacyFixture);
    const second = resolveBrowserBaseline(legacyFixture);

    expect(second.targets).toEqual(["chrome 75", "firefox 68"]);
    expect([...second.unsupportedSyntax].sort()).toEqual([
      "class-properties",
      "logical-assignment-operators",
      "nullish-coalescing",
      "numeric-separator",
      "optional-chaining",
      "private-methods",
    ]);
    expect(second).toEqual(first);
  });
});
