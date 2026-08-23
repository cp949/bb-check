// createCompatScanner를 검사한다. 실제 @mdn/browser-compat-data와 실제
// acorn 파싱 결과를 그대로 쓴다 — 이 스캐너가 결국 real dist 파일을
// 상대할 것이므로, 조작한 색인으로는 실제 BCD 구조와 어긋나는 버그를
// 놓친다.
//
// 아래 기대 버전 숫자들(chrome 92/93/98 등)은 이 저장소에 고정된
// @mdn/browser-compat-data@8.0.12의 실제 값이다(package.json 참고).

import { describe, expect, it } from "vitest";
import { BbError } from "@cp949/bb-core";
import { createCompatScanner } from "../src/index.js";

const baseline = { chrome: "80" };

/** source를 스캔해 finding 이름만 뽑는다. */
const names = (
  scan: ReturnType<typeof createCompatScanner>,
  source: string,
  file = "dist/index.js",
): string[] => scan(source, file).map((finding) => finding.name);

describe("createCompatScanner: 옵션 검증", () => {
  it("allowed 항목의 file이 비어 있으면 던진다", () => {
    expect(() =>
      createCompatScanner({
        baseline,
        allowed: [{ file: "", name: "x", reason: "r" }],
      }),
    ).toThrow(/file\/name\/reason/);
  });

  it("allowed 항목의 name이 비어 있으면 던진다", () => {
    expect(() =>
      createCompatScanner({
        baseline,
        allowed: [{ file: "*", name: "", reason: "r" }],
      }),
    ).toThrow(/file\/name\/reason/);
  });

  it("allowed 항목의 reason이 비어 있으면 던진다", () => {
    expect(() =>
      createCompatScanner({
        baseline,
        allowed: [{ file: "*", name: "x", reason: "" }],
      }),
    ).toThrow(/file\/name\/reason/);
  });

  it("allowed 항목이 공백만으로 이루어져도 던진다", () => {
    expect(() =>
      createCompatScanner({
        baseline,
        allowed: [{ file: "   ", name: "x", reason: "r" }],
      }),
    ).toThrow(/file\/name\/reason/);
  });

  it("옵션 검증 실패는 BB_CONFIG_INVALID BbError다(일반 Error가 아니다)", () => {
    let caught: unknown;
    try {
      createCompatScanner({
        baseline,
        allowed: [{ file: "", name: "x", reason: "r" }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BbError);
    expect((caught as BbError).code).toBe("BB_CONFIG_INVALID");
  });

  it("scan은 함수이고 allowanceMatchCounts를 함께 들고 있다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(typeof scan).toBe("function");
    expect(scan.allowanceMatchCounts).toBeInstanceOf(Map);
  });

  it("파싱할 수 없는 소스는 던진다(검사 불가는 통과가 아니다)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(() => scan("const x = ;", "dist/index.js")).toThrow(
      /파싱할 수 없습니다/,
    );
  });
});

describe("tier 1: 확정 전역 판정", () => {
  it("맨몸 전역 함수 호출을 검출한다(structuredClone, chrome 98)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const findings = scan("const c = structuredClone(v);", "dist/index.js");
    expect(findings).toEqual([
      expect.objectContaining({
        file: "dist/index.js",
        line: 1,
        name: "structuredClone",
        tier: 1,
      }),
    ]);
    expect(findings[0]?.detail).toContain("98");
  });

  it("전역의 static 멤버를 검출한다(Object.hasOwn, chrome 93)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(names(scan, "Object.hasOwn(o, 'k');")).toEqual(["Object.hasOwn"]);
  });

  it("고정 전역(known global type)의 멤버를 검출한다(crypto.randomUUID, chrome 92)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(names(scan, "const id = crypto.randomUUID();")).toEqual([
      "crypto.randomUUID",
    ]);
  });

  it("globalThis/window/self 접두는 몇 단계든 벗겨서 같은 전역으로 본다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(names(scan, "globalThis.structuredClone(v);")).toEqual([
      "globalThis.structuredClone",
    ]);
    expect(names(scan, "window.structuredClone(v);")).toEqual([
      "window.structuredClone",
    ]);
    expect(names(scan, "self.structuredClone(v);")).toEqual([
      "self.structuredClone",
    ]);
  });

  it("깊은 전역 객체 접두 체인도 판정한다(globalThis.globalThis.Object.hasOwn)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const findings = scan(
      "globalThis.globalThis.Object.hasOwn(o, k);",
      "dist/index.js",
    );
    expect(findings).toEqual([
      expect.objectContaining({
        name: "globalThis.globalThis.Object.hasOwn",
        tier: 1,
      }),
    ]);
  });

  it("접두 전역 멤버 접근은 한 번만 보고한다(전역 객체 자체는 색인에 없음)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(scan("globalThis.WeakRef;", "dist/index.js")).toHaveLength(1);
  });

  it("반복 접두의 동적 computed 키는 판정하지 않는다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(names(scan, "globalThis[prefix].Object.hasOwn(o, k);")).toEqual([]);
  });

  it("제거된 API를 baseline 버전과 무관하게 검출한다(document.createTouchList)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const findings = scan("document.createTouchList();", "dist/index.js");
    expect(findings).toEqual([
      expect.objectContaining({ name: "document.createTouchList", tier: 1 }),
    ]);
    expect(findings[0]?.detail).toContain("제거");
  });

  it("매개변수가 전역을 가리면(shadow) 전혀 검출되지 않는다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(
      names(scan, "function f(AbortSignal) { return AbortSignal.timeout(1); }"),
    ).toEqual([]);
  });

  it("고정 전역이 가려지면 tier 1은 사라지지만 이름 기반 tier 2로는 남는다", () => {
    // 매개변수가 crypto를 가리면 수신자 타입을 더는 증명할 수 없다.
    // 실제로 Crypto일 수도 있으므로 통과시키는 것은 틀렸다 — tier 2로 내려간다.
    const scan = createCompatScanner({ baseline, allowed: [] });
    const findings = scan(
      "function f(crypto) { return crypto.randomUUID(); }",
      "dist/index.js",
    );
    expect(findings).toEqual([
      expect.objectContaining({ name: ".randomUUID()", tier: 2 }),
    ]);
  });

  it("typeof 가드로 감싼 참조는 검출하지 않는다(기능 탐지 관용구)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const source = [
      'if (typeof structuredClone === "undefined") {',
      "  polyfillStructuredClone();",
      "} else {",
      "  useNativeClone();",
      "}",
    ].join("\n");
    expect(names(scan, source)).toEqual([]);
  });

  it("typeof로 감싸지 않은 별도 호출은 그대로 검출한다", () => {
    // 가드는 그 가드가 감싼 특정 참조만 면제한다 — 같은 이름의 다른 호출까지
    // 안전해지는 것은 아니다.
    const scan = createCompatScanner({ baseline, allowed: [] });
    const source = [
      'typeof structuredClone === "undefined";',
      "structuredClone(v);",
    ].join("\n");
    expect(names(scan, source)).toEqual(["structuredClone"]);
  });
});

describe("tier 2: 수신자 불명 판정", () => {
  it("호출 형태는 괄호를 붙여 보고한다(.at(), chrome 92)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const findings = scan(
      "function pick(list) { return list.at(-1); }",
      "dist/index.js",
    );
    expect(findings).toEqual([
      expect.objectContaining({ name: ".at()", tier: 2 }),
    ]);
  });

  it("프로퍼티 접근 형태는 괄호 없이 보고한다(.userAgentData, chrome 90)", () => {
    // navigator가 매개변수로 가려지면 Navigator임을 증명할 수 없다 —
    // tier 1(고정 전역)이 아니라 이름 기반 tier 2로 내려간다.
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(
      names(scan, "function f(navigator) { return navigator.userAgentData; }"),
    ).toEqual([".userAgentData"]);
  });

  it("tier 1로 확정된 멤버는 tier 2로 중복 보고하지 않는다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(scan("Object.hasOwn(o, 'k');", "dist/index.js")).toHaveLength(1);
  });

  it("문자열 리터럴 안의 메서드 표기는 검출하지 않는다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(names(scan, 'const url = "https://x.test/.at(0)";')).toEqual([]);
  });
});

describe("tier 3: 옵션 서브피처", () => {
  it("Error의 cause 옵션을 검출한다(chrome 93)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const findings = scan(
      "throw new Error(msg, { cause: err });",
      "dist/index.js",
    );
    expect(findings).toEqual([
      expect.objectContaining({ name: "new Error(options.cause)", tier: 3 }),
    ]);
  });

  it("cause가 없는 생성자 호출은 검출하지 않는다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(names(scan, "throw new Error(msg);")).toEqual([]);
  });

  it("cause 속성 대입은 검출하지 않는다(생성자 옵션이 아니라 단순 대입)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const source = [
      "const error = new Error(message);",
      "error.cause = cause;",
    ].join("\n");
    expect(names(scan, source)).toEqual([]);
  });

  it("생성자 자체가 이미 baseline 미만이면 tier 1만 보고하고 cause는 억제한다(AggregateError, chrome 85 > 80)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const findings = scan(
      "new AggregateError([], m, { cause: e });",
      "dist/index.js",
    );
    expect(findings).toEqual([
      expect.objectContaining({ name: "AggregateError", tier: 1 }),
    ]);
  });

  it("생성자 자체는 안전해진 뒤에는 cause 옵션이 별도 tier 3 위반으로 다시 나타난다", () => {
    const scan = createCompatScanner({
      baseline: { chrome: "85" },
      allowed: [],
    });
    const findings = scan(
      "new AggregateError([], m, { cause: e });",
      "dist/index.js",
    );
    expect(findings).toEqual([
      expect.objectContaining({
        name: "new AggregateError(options.cause)",
        tier: 3,
      }),
    ]);
  });

  it("addEventListener의 signal 옵션을 검출한다(chrome 90)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const findings = scan(
      'target.addEventListener("abort", onAbort, { signal: controller.signal });',
      "dist/index.js",
    );
    expect(findings).toEqual([
      expect.objectContaining({
        name: "addEventListener(options.signal)",
        tier: 3,
      }),
    ]);
  });

  it("수신자 없는 addEventListener 호출도 검출한다(worker 전역 등)", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(
      names(scan, 'addEventListener("abort", onAbort, { signal });'),
    ).toEqual(["addEventListener(options.signal)"]);
  });

  it("signal이 아닌 옵션은 검출하지 않는다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    expect(
      names(scan, 'el.addEventListener("abort", onAbort, { once: true });'),
    ).toEqual([]);
  });
});

describe("세 tier를 한 파일에서 함께 찾는다", () => {
  it("전역/수신자불명/옵션 서브피처 각 하나씩을 줄 순서대로 보고한다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const source = [
      "function readFirst(list) {",
      "  const timeout = AbortSignal.timeout(1);",
      "  const last = list.at(-1);",
      '  throw new Error("failed", { cause: last });',
      "}",
    ].join("\n");

    const findings = scan(source, "dist/index.js");
    expect(findings.map(({ name }) => name)).toEqual([
      "AbortSignal.timeout",
      ".at()",
      "new Error(options.cause)",
    ]);
    expect(findings.map(({ tier }) => tier)).toEqual([1, 2, 3]);
    expect(findings.map(({ line }) => line)).toEqual([2, 3, 4]);
  });
});

describe("allowance", () => {
  it("정확히 일치하는 file/name만 면제한다", () => {
    const scan = createCompatScanner({
      baseline,
      allowed: [
        { file: "dist/index.js", name: ".at()", reason: "테스트용 예외" },
      ],
    });
    expect(
      names(scan, "function f(x) { return x.at(-1); }", "dist/index.js"),
    ).toEqual([]);
    expect(
      names(scan, "function f(x) { return x.at(-1); }", "dist/other.js"),
    ).toEqual([".at()"]);
  });

  it('file이 "*"면 모든 파일에 적용한다', () => {
    const scan = createCompatScanner({
      baseline,
      allowed: [{ file: "*", name: ".at()", reason: "쿼리 빌더 메서드다" }],
    });
    expect(
      names(scan, "function f(x) { return x.at(-1); }", "dist/anything.js"),
    ).toEqual([]);
  });

  it("매칭 횟수를 기록한다", () => {
    const scan = createCompatScanner({
      baseline,
      allowed: [{ file: "dist/index.js", name: ".at()", reason: "테스트용" }],
    });
    scan("function f(x) { return x.at(-1); }", "dist/index.js");
    scan("function g(y) { return y.at(-2); }", "dist/index.js");
    expect(scan.allowanceMatchCounts.get("dist/index.js\0.at()")).toBe(2);
  });

  it("한 번도 매칭되지 않은 allowance는 0으로 남는다", () => {
    const scan = createCompatScanner({
      baseline,
      allowed: [
        {
          file: "dist/index.js",
          name: ".neverUsed()",
          reason: "쓰이지 않을 예외",
        },
      ],
    });
    scan("const c = structuredClone(v);", "dist/index.js");
    expect(scan.allowanceMatchCounts.get("dist/index.js\0.neverUsed()")).toBe(
      0,
    );
  });

  it("다른 이름의 allowance는 관련 없는 위반을 면제하지 않는다", () => {
    const scan = createCompatScanner({
      baseline,
      allowed: [{ file: "*", name: ".at()", reason: "관련 없음" }],
    });
    expect(names(scan, "const c = structuredClone(v);")).toEqual([
      "structuredClone",
    ]);
  });
});

describe("정렬", () => {
  it("줄 번호 오름차순으로 보고한다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const source = [
      "const a = 1;",
      "function f(x) { return x.at(0); }",
      "const c = 2;",
      "const d = structuredClone(a);",
    ].join("\n");
    expect(
      scan(source, "dist/index.js").map((finding) => [
        finding.line,
        finding.name,
      ]),
    ).toEqual([
      [2, ".at()"],
      [4, "structuredClone"],
    ]);
  });

  it("같은 줄이면 이름의 코드포인트 순으로 정렬한다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const source = "function f(x) { return [x.at(0), structuredClone(x)]; }\n";
    expect(
      scan(source, "dist/index.js").map((finding) => finding.name),
    ).toEqual([".at()", "structuredClone"]);
  });
});

describe("baseline이 이미 지원하는 API", () => {
  it("위반으로 보고하지 않는다", () => {
    const scan = createCompatScanner({ baseline, allowed: [] });
    const source = [
      "const settled = Promise.allSettled([]);",
      "const merged = rows.flatMap((row) => row);",
      "const entries = Object.entries(o);",
      "const joined = parts.join('');",
    ].join("\n");
    expect(names(scan, source)).toEqual([]);
  });
});
