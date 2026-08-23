import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDistEntries } from "../src/index.js";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

/**
 * 브리프의 고정 fixture 3종(clean/multi-entry/empty-exports) 밖의
 * edge case는 커밋된 fixture를 늘리는 대신 이 임시 디렉터리에서
 * package.json/산출물을 직접 써서 검증한다.
 */
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bb-library-dist-entries-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const writePackageJson = async (value: unknown) => {
  await writeFile(join(tempDir, "package.json"), JSON.stringify(value), "utf8");
};

describe("resolveDistEntries", () => {
  it("string, array, condition object, subpath object 형태를 모두 순회해 정렬·중복 제거한 JS 진입점을 반환한다", async () => {
    expect(await resolveDistEntries(fixture("multi-entry"))).toEqual({
      entries: [
        expect.stringMatching(/dist\/feature\.cjs$/),
        expect.stringMatching(/dist\/index\.js$/),
      ],
      invalidTargets: [],
    });
  });

  it("최상위 exports가 string 하나뿐이어도 처리한다", async () => {
    expect(await resolveDistEntries(fixture("clean"))).toEqual({
      entries: [expect.stringMatching(/dist\/index\.js$/)],
      invalidTargets: [],
    });
  });

  it("exports에 JavaScript가 없으면 BB_INPUT_NOT_FOUND다", async () => {
    await expect(
      resolveDistEntries(fixture("empty-exports")),
    ).rejects.toMatchObject({ code: "BB_INPUT_NOT_FOUND" });
  });

  it("package.json이 없으면 BB_INPUT_NOT_FOUND다", async () => {
    await expect(
      resolveDistEntries(join(tempDir, "does-not-exist")),
    ).rejects.toMatchObject({ code: "BB_INPUT_NOT_FOUND" });
  });

  it("package.json이 올바른 JSON이 아니면 BB_CONFIG_INVALID다", async () => {
    await writeFile(join(tempDir, "package.json"), "{ not json", "utf8");
    await expect(resolveDistEntries(tempDir)).rejects.toMatchObject({
      code: "BB_CONFIG_INVALID",
    });
  });

  it("유효 entry와 섞인 root escape·절대·missing JS target을 판정 불가 목록에 보존한다", async () => {
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writeFile(join(tempDir, "dist", "index.js"), "export {};", "utf8");
    await writePackageJson({
      name: "root-escape",
      version: "1.0.0",
      exports: {
        ".": "./dist/index.js",
        "./evil-relative": "../../etc/passwd.js",
        "./evil-absolute": "/etc/passwd.js",
        "./missing": "./dist/missing.js",
      },
    });

    const resolution = await resolveDistEntries(tempDir);
    expect(resolution).toEqual({
      entries: [expect.stringMatching(/dist\/index\.js$/)],
      invalidTargets: [
        { target: "../../etc/passwd.js", reason: "outside-root" },
        { target: "./dist/missing.js", reason: "missing" },
        { target: "/etc/passwd.js", reason: "absolute" },
      ],
    });
  });

  it("types, CSS, JSON, source map은 진입점에서 제외한다", async () => {
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writeFile(join(tempDir, "dist", "index.js"), "export {};", "utf8");
    await writeFile(join(tempDir, "dist", "index.d.ts"), "export {};", "utf8");
    await writeFile(join(tempDir, "dist", "index.js.map"), "{}", "utf8");
    await writeFile(join(tempDir, "dist", "style.css"), "", "utf8");
    await writeFile(join(tempDir, "dist", "data.json"), "{}", "utf8");
    await writePackageJson({
      name: "non-js-outputs",
      version: "1.0.0",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
        "./style": "./dist/style.css",
        "./data": "./dist/data.json",
        "./map": "./dist/index.js.map",
      },
    });

    const resolution = await resolveDistEntries(tempDir);
    expect(resolution).toEqual({
      entries: [expect.stringMatching(/dist\/index\.js$/)],
      invalidTargets: [],
    });
  });

  it("JS target이 전부 root escape·절대·missing이어도 invalidTargets를 반환한다", async () => {
    await writePackageJson({
      name: "all-invalid-targets",
      version: "1.0.0",
      exports: {
        "./escape": "../../outside.js",
        "./absolute": "/tmp/bb-check-absolute.js",
        "./missing": "./dist/does-not-exist.js",
      },
    });

    await expect(resolveDistEntries(tempDir)).resolves.toEqual({
      entries: [],
      invalidTargets: [
        { target: "../../outside.js", reason: "outside-root" },
        { target: "./dist/does-not-exist.js", reason: "missing" },
        { target: "/tmp/bb-check-absolute.js", reason: "absolute" },
      ],
    });
  });
});
