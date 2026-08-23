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

  it("모바일 에이전트 이름을 BCD(@mdn/browser-compat-data) 명명 규칙으로 변환한다", async () => {
    await writePackageJson({
      name: "mobile-agents",
      version: "1.0.0",
      browserslist: ["and_chr >= 4", "ios_saf >= 12", "samsung >= 4"],
    });

    const baseline = await loadLibraryBaseline(tempDir);

    // BCD 이름으로 변환되어 있어야 한다(compat-bcd.ts의 buildCompatIndex가
    // BrowserBaseline 키를 BCD browsers 키로 그대로 조회하기 때문).
    expect(baseline.safari_ios).toBe("12.0");
    expect(baseline.samsunginternet_android).toBe("4");
    expect(typeof baseline.chrome_android).toBe("string");
    expect(baseline.chrome_android).toMatch(/^\d+/);

    // browserslist의 원래 이름은 결과에 남아있지 않아야 한다.
    expect(Object.hasOwn(baseline, "and_chr")).toBe(false);
    expect(Object.hasOwn(baseline, "ios_saf")).toBe(false);
    expect(Object.hasOwn(baseline, "samsung")).toBe(false);
  });

  it("browserslist의 android(Android Browser)를 BCD의 webview_android로 변환한다", async () => {
    // browserslist 자신의 bbmTransform 매핑(node_modules/browserslist/index.js)이
    // BCD 기반 supports 질의에서 `webview_android: 'android'`로 명시한다 —
    // 이 저장소에 설치된 실물 browserslist 소스에서 직접 확인한 매핑이다.
    await writePackageJson({
      name: "android-webview",
      version: "1.0.0",
      browserslist: ["android >= 4"],
    });

    const baseline = await loadLibraryBaseline(tempDir);

    expect(baseline.webview_android).toBe("4");
    expect(Object.hasOwn(baseline, "android")).toBe(false);
  });

  it("op_mob을 BCD의 opera_android로 변환한다", async () => {
    await writePackageJson({
      name: "op-mob",
      version: "1.0.0",
      browserslist: ["op_mob >= 10"],
    });

    const baseline = await loadLibraryBaseline(tempDir);

    expect(baseline.opera_android).toBe("10");
    expect(Object.hasOwn(baseline, "op_mob")).toBe(false);
  });

  it("BCD에 대응 데이터가 없는 에이전트(예: bb)는 원래 이름 그대로 남는다", async () => {
    // and_qq/and_uc/baidu/bb/ie_mob/kaios/op_mini는 @mdn/browser-compat-data의
    // browsers에 대응 키가 없다. 변환하지 않고 원래 이름을 통과시켜도
    // compat-bcd.ts의 buildCompatIndex가 BCD 조회 실패로 어차피 건너뛰므로
    // 기존 동작과 동일하다(무해한 스킵).
    await writePackageJson({
      name: "blackberry",
      version: "1.0.0",
      browserslist: ["bb >= 1"],
    });

    const baseline = await loadLibraryBaseline(tempDir);

    expect(baseline.bb).toBe("7");
  });

  it("데스크톱 에이전트 이름은 BCD와 이미 일치하므로 그대로 통과한다", async () => {
    expect(await loadLibraryBaseline(fixture("multi-entry"))).toMatchObject({
      chrome: "80",
    });
  });
});
