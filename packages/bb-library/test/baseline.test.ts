import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLibraryBaseline } from "../src/index.js";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

/**
 * 브리프의 고정 fixture 3종(clean/multi-entry/empty-exports) 밖의
 * edge case는 커밋된 fixture를 늘리는 대신 이 임시 디렉터리에서
 * package.json을 직접 써서 검증한다.
 */
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "bb-library-baseline-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const writePackageJson = async (value: unknown) => {
  await writeFile(join(tempDir, "package.json"), JSON.stringify(value), "utf8");
};

describe("loadLibraryBaseline", () => {
  it("browserslist를 프로젝트에서 파생한다", async () => {
    expect(await loadLibraryBaseline(fixture("clean"))).toMatchObject({
      chrome: "80",
    });
  });

  it("package.json이 없으면 BB_INPUT_NOT_FOUND다", async () => {
    await expect(
      loadLibraryBaseline(join(tempDir, "does-not-exist")),
    ).rejects.toMatchObject({ code: "BB_INPUT_NOT_FOUND" });
  });

  it("package.json이 올바른 JSON이 아니면 BB_CONFIG_INVALID다", async () => {
    await writeFile(join(tempDir, "package.json"), "{ not json", "utf8");
    await expect(loadLibraryBaseline(tempDir)).rejects.toMatchObject({
      code: "BB_CONFIG_INVALID",
    });
  });

  it("browserslist 필드가 없으면 BB_CONFIG_INVALID다", async () => {
    await writePackageJson({ name: "no-browserslist", version: "1.0.0" });
    await expect(loadLibraryBaseline(tempDir)).rejects.toMatchObject({
      code: "BB_CONFIG_INVALID",
    });
  });

  it("질의가 브라우저를 하나도 선택하지 않으면 BB_BASELINE_EMPTY다", async () => {
    await writePackageJson({
      name: "impossible-query",
      version: "1.0.0",
      browserslist: ["chrome > 99999"],
    });
    await expect(loadLibraryBaseline(tempDir)).rejects.toMatchObject({
      code: "BB_BASELINE_EMPTY",
    });
  });

  it("BROWSERSLIST 환경변수가 설정되어 있으면 재정의하지 않고 BB_CONFIG_INVALID로 거절한다", async () => {
    const original = process.env.BROWSERSLIST;
    process.env.BROWSERSLIST = "ie 11";
    try {
      await expect(loadLibraryBaseline(fixture("clean"))).rejects.toMatchObject(
        { code: "BB_CONFIG_INVALID" },
      );
    } finally {
      if (original === undefined) delete process.env.BROWSERSLIST;
      else process.env.BROWSERSLIST = original;
    }
  });

  it("BROWSERSLIST_ENV 환경변수가 설정되어 있으면 BB_CONFIG_INVALID로 거절한다", async () => {
    const original = process.env.BROWSERSLIST_ENV;
    process.env.BROWSERSLIST_ENV = "development";
    try {
      await expect(loadLibraryBaseline(fixture("clean"))).rejects.toMatchObject(
        { code: "BB_CONFIG_INVALID" },
      );
    } finally {
      if (original === undefined) delete process.env.BROWSERSLIST_ENV;
      else process.env.BROWSERSLIST_ENV = original;
    }
  });

  it("NODE_ENV은 항상 명시적 queries를 넘기므로 구조적으로 결과에 영향을 줄 수 없다 — BROWSERSLIST/BROWSERSLIST_ENV와 달리 거절 대상이 아니다(의도적 비대칭)", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(await loadLibraryBaseline(fixture("clean"))).toMatchObject({
        chrome: "80",
      });
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});
