// normalizeBrowserSupport/buildCompatIndex를 검사한다.
//
// buildCompatIndex 쪽은 실제 @mdn/browser-compat-data를 그대로 쓴다 —
// 이 모듈의 존재 이유가 "BCD 전체에서 파생한 색인"이므로, 조작한 fixture로
// 검사하면 정작 실제 BCD 구조와 어긋나는 버그를 놓친다.

import { describe, expect, it } from "vitest";
import { buildCompatIndex, normalizeBrowserSupport } from "../src/index.js";

describe("normalizeBrowserSupport", () => {
  it.each([
    [{ version_added: "80" }, "80"],
    [{ version_added: true }, null],
    [{ version_added: false }, null],
    [
      [
        { version_added: "80", version_removed: "90" },
        { version_added: "100" },
      ],
      "100",
    ],
  ])("support statement %j를 정규화한다", (statement, expected) => {
    expect(normalizeBrowserSupport(statement)).toBe(expected);
  });

  it("제거 이력만 있는(현재는 미지원인) alternative 배열은 null이 아니라 실제 도입 버전을 돌려준다", () => {
    // "현재 지원 안 됨"과 "도입 버전을 모름"은 다른 정보다. normalizeBrowserSupport는
    // 전자를 null로 뭉개지 않는다 — 그건 buildCompatIndex가 removed로 별도 판정한다.
    expect(
      normalizeBrowserSupport([{ version_added: "10", version_removed: "20" }]),
    ).toBe("10");
  });

  it("undefined/null statement는 null이다", () => {
    expect(normalizeBrowserSupport(undefined)).toBeNull();
    expect(normalizeBrowserSupport(null)).toBeNull();
  });

  it("빈 배열은 null이다", () => {
    expect(normalizeBrowserSupport([])).toBeNull();
  });

  it('"≤80" 형태는 80으로 정규화한다(경계값을 도입 버전으로 취급)', () => {
    expect(normalizeBrowserSupport({ version_added: "≤80" })).toBe("80");
  });

  it("flags로만 존재하는 지원은 표준 지원이 아니므로 null이다", () => {
    expect(
      normalizeBrowserSupport({
        version_added: "70",
        flags: [{ type: "preference", name: "some.flag" }],
      }),
    ).toBeNull();
  });
});

describe("buildCompatIndex", () => {
  const baseline = { chrome: "80" };

  it("chrome 80보다 늦게 도입된 전역 함수를 색인한다(structuredClone, chrome 98)", () => {
    const index = buildCompatIndex(baseline);
    expect(index.globals.get("structuredClone")).toMatchObject({
      issues: [
        {
          browser: "chrome",
          baselineVersion: "80",
          reason: "not-yet-added",
          requiredVersion: "98",
        },
      ],
    });
  });

  it("baseline 이전부터 지원되는 전역은 색인하지 않는다(AbortController, chrome 66)", () => {
    const index = buildCompatIndex(baseline);
    expect(index.globals.has("AbortController")).toBe(false);
    expect(index.globals.has("AbortSignal")).toBe(false);
  });

  it("static 멤버를 Owner.member로 색인한다(Object.hasOwn, chrome 93)", () => {
    const index = buildCompatIndex(baseline);
    expect(index.staticMembers.get("Object.hasOwn")).toMatchObject({
      issues: [{ reason: "not-yet-added", requiredVersion: "93" }],
    });
  });

  it("knownGlobalTypes로 연결되는 고정 전역의 멤버도 Owner.member로 조회 가능하다(crypto -> Crypto.randomUUID)", () => {
    const index = buildCompatIndex(baseline);
    expect(index.knownGlobalTypes.get("crypto")).toBe("Crypto");
    expect(index.staticMembers.get("Crypto.randomUUID")).toMatchObject({
      issues: [{ reason: "not-yet-added", requiredVersion: "92" }],
    });
  });

  it("제거된 API는 removed 사유로, baseline 버전과 무관하게 색인한다(Document.createTouchList)", () => {
    const index = buildCompatIndex(baseline);
    expect(index.staticMembers.get("Document.createTouchList")).toMatchObject({
      issues: [{ browser: "chrome", reason: "removed", requiredVersion: null }],
    });
  });

  it("수신자 불명 instance 멤버를 맨 이름으로 색인한다(.at, chrome 92)", () => {
    const index = buildCompatIndex(baseline);
    expect(index.instanceMembers.get("at")).toMatchObject({
      issues: [{ reason: "not-yet-added", requiredVersion: "92" }],
    });
    // Array/String/TypedArray 셋 다 owner로 기여했다는 진단 정보가 남는다.
    expect(
      index.instanceMembers.get("at")?.bcdPaths.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("tier 3 옵션 서브피처를 고정 이름으로 색인한다(Error.cause, addEventListener.signal)", () => {
    const index = buildCompatIndex(baseline);
    expect(index.optionFeatures.get("Error.cause")).toMatchObject({
      issues: [{ reason: "not-yet-added", requiredVersion: "93" }],
    });
    expect(
      index.optionFeatures.get("EventTarget.addEventListener.signal"),
    ).toMatchObject({
      issues: [{ reason: "not-yet-added", requiredVersion: "90" }],
    });
  });

  it("baseline을 올리면 이전에 잡히던 API가 색인에서 빠진다", () => {
    const low = buildCompatIndex({ chrome: "80" });
    const high = buildCompatIndex({ chrome: "98" });
    expect(low.globals.has("structuredClone")).toBe(true);
    expect(high.globals.has("structuredClone")).toBe(false);
  });

  it("BCD가 추적하지 않는 baseline 브라우저 이름은 조용히 건너뛴다(판정 근거 없음)", () => {
    expect(() =>
      buildCompatIndex({ "does-not-exist-in-bcd": "1" }),
    ).not.toThrow();
    const index = buildCompatIndex({ "does-not-exist-in-bcd": "1" });
    expect(index.globals.size).toBe(0);
  });
});
