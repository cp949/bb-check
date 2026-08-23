// CheckResult를 한국어 보고서 문자열로 렌더링하는 report.ts를 검증한다.
// 통과/위반 두 대표 시나리오는 골든 파일과 바이트 단위로 비교하고,
// null line/originalFile 표시 같은 개별 규칙은 별도 assertion으로 확인한다.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckResult } from "@cp949/bb-core";
import { renderLibraryReport } from "../src/report.js";

/** test/goldens/<name>을 있는 그대로(줄바꿈 포함) 읽는다. */
const readGolden = (name: string) =>
  readFile(join(import.meta.dirname, "goldens", name), "utf8");

const passResult: CheckResult = {
  baseline: { chrome: "90", firefox: "88" },
  findings: [],
  incomplete: false,
  ok: true,
};

const violationResult: CheckResult = {
  baseline: { chrome: "90" },
  findings: [
    {
      axis: "syntax",
      file: "*",
      line: null,
      name: "BB_SYNTAX_TARGET_UNAVAILABLE",
      detail: "이 baseline에는 문법 target이 없어 검사를 건너뛰었습니다.",
    },
    {
      axis: "syntax",
      file: "dist/index.js",
      line: 12,
      name: "syntax-divergence",
      detail:
        "baseline이 지원하지 않는 문법입니다(column 4, target: chrome90).",
    },
    {
      axis: "runtime-js",
      file: "dist/index.js",
      line: 20,
      name: "structuredClone",
      detail: "chrome 90에서 지원되지 않는 런타임 API입니다.",
      originalFile: "src/index.ts",
    },
  ],
  incomplete: true,
  ok: false,
};

describe("renderLibraryReport: golden", () => {
  it("통과 결과를 안정된 한국어 출력으로 렌더링한다", async () => {
    const rendered = renderLibraryReport(passResult);
    expect(rendered).toBe(await readGolden("library-pass.txt"));
  });

  it("위반 결과를 안정된 한국어 출력으로 렌더링한다", async () => {
    const rendered = renderLibraryReport(violationResult);
    expect(rendered).toBe(await readGolden("library-fail.txt"));
  });
});

describe("renderLibraryReport: 개별 표시 규칙", () => {
  it("주어진 findings 순서를 그대로 유지한다(재정렬하지 않음)", () => {
    // checkLibrary가 이미 sortFindings로 정렬해 돌려주므로, report.ts는
    // 다시 정렬하지 않고 입력 순서를 그대로 보존해야 한다. 정렬 규칙과
    // 다른 순서를 일부러 넣어 재정렬 여부를 검증한다.
    const outOfOrder: CheckResult = {
      baseline: { chrome: "90" },
      findings: [
        {
          axis: "runtime-js",
          file: "b.js",
          line: 1,
          name: "z-name",
          detail: "두 번째로 나와야 하는 항목",
        },
        {
          axis: "syntax",
          file: "a.js",
          line: 1,
          name: "a-name",
          detail: "첫 번째로 나와야 하는 항목",
        },
      ],
      incomplete: false,
      ok: false,
    };

    const rendered = renderLibraryReport(outOfOrder);
    const runtimeIndex = rendered.indexOf("z-name");
    const syntaxIndex = rendered.indexOf("a-name");
    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(syntaxIndex).toBeGreaterThan(-1);
    expect(runtimeIndex).toBeLessThan(syntaxIndex);
  });

  it("line이 null이면 '-'로 표시한다", () => {
    const result: CheckResult = {
      baseline: { chrome: "90" },
      findings: [
        {
          axis: "dependency",
          file: "dist/a.js",
          line: null,
          name: "dependency-leak",
          detail: "detail",
        },
      ],
      incomplete: false,
      ok: false,
    };
    expect(renderLibraryReport(result)).toContain("dist/a.js:-");
  });

  it("originalFile이 있으면 원본 위치를 함께 표시한다", () => {
    const result: CheckResult = {
      baseline: { chrome: "90" },
      findings: [
        {
          axis: "runtime-js",
          file: "dist/a.js",
          line: 3,
          name: "structuredClone",
          detail: "detail",
          originalFile: "src/a.ts",
        },
      ],
      incomplete: false,
      ok: false,
    };
    expect(renderLibraryReport(result)).toContain("원본: src/a.ts");
  });

  it("originalFile이 없으면 원본 표시를 붙이지 않는다", () => {
    const result: CheckResult = {
      baseline: { chrome: "90" },
      findings: [
        {
          axis: "runtime-js",
          file: "dist/a.js",
          line: 3,
          name: "structuredClone",
          detail: "detail",
        },
      ],
      incomplete: false,
      ok: false,
    };
    expect(renderLibraryReport(result)).not.toContain("원본:");
  });

  it("stack trace나 원인(cause) 정보를 출력하지 않는다", () => {
    // report.ts는 CheckResult만 다루고 오류/스택은 cli/main.ts의 몫이다.
    // 렌더링 결과에 그런 정보가 섞여 들어가지 않는지 방어적으로 확인한다.
    const rendered = renderLibraryReport(violationResult);
    expect(rendered).not.toContain("at ");
    expect(rendered).not.toContain("stack");
  });
});
