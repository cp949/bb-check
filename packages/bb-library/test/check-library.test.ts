// checkLibrary orchestration을 검사한다. syntax/runtime-js/dependency
// scanner를 실제로 엮어 real dist 산출물을 상대하므로, 개별 scanner
// 유닛 테스트(Task 4~7)와 달리 이 파일은 판정 로직을 재검증하지 않고
// "제대로 엮였는가"만 본다: 세 축이 한 결과로 모이는지, 파일 하나의
// parse 실패가 나머지를 막지 않는지, source map 귀속이 실제로 I/O를
// 거쳐 동작하는지, allowance 적용/미사용 보고가 맞는지, 결과가
// 결정적이고 mutation에 안전한지.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkLibrary } from "../src/index.js";
import * as checkLibraryModule from "../src/check-library.js";
import type { LibraryAllowance } from "@cp949/bb-core";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

describe("checkLibrary: external source map 경로 기준", () => {
  // 잡는 생산 결함: entry-relative map path를 relFile dirname에 붙이면
  // win32.relative가 반환한 D:\\maps\\index.js.map absolute path가 dist/D:/...로
  // 왜곡되어 cross-drive external map의 실제 기준 디렉터리를 잃는다.
  it("cross-drive Windows external map dirname을 project-relative 결과 그대로 보존한다", () => {
    const seam = checkLibraryModule as {
      externalSourceMapDir?: (
        projectDir: string,
        mapPath: string,
        path: typeof win32,
      ) => string;
    };
    expect(seam.externalSourceMapDir).toBeTypeOf("function");
    if (seam.externalSourceMapDir === undefined) return;
    expect(
      seam.externalSourceMapDir("C:\\repo", "D:\\maps\\index.js.map", win32),
    ).toBe("D:\\maps");
  });
});

describe("checkLibrary: 세 축 통합", () => {
  it("세 판정 축을 한 결과로 모은다", async () => {
    const result = await checkLibrary({
      projectDir: fixture("violations"),
      allow: [],
    });
    expect(result.ok).toBe(false);
    expect(new Set(result.findings.map(({ axis }) => axis))).toEqual(
      new Set(["syntax", "runtime-js", "dependency"]),
    );
  });

  it("baseline을 결과에 그대로 담아 돌려준다", async () => {
    const result = await checkLibrary({
      projectDir: fixture("violations"),
      allow: [],
    });
    expect(result.baseline).toMatchObject({ chrome: "50" });
  });

  it("위반이 없으면 ok다", async () => {
    const result = await checkLibrary({
      projectDir: fixture("clean"),
      allow: [],
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.incomplete).toBe(false);
  });
});

describe("checkLibrary: 파일 단위 오류 격리", () => {
  it("한 파일 parse 실패 뒤에도 나머지를 검사하고 incomplete로 표시한다", async () => {
    const result = await checkLibrary({
      projectDir: fixture("malformed"),
      allow: [],
    });
    expect(result.incomplete).toBe(true);
    expect(result.ok).toBe(false);
    // 세 축(syntax/runtime-js/dependency)이 각각 독립적으로 parse 실패를
    // 잡아 자기 축에 BB_TARGET_PARSE finding을 남겨야 한다 — 한 축의
    // catch가 다른 축의 검사까지 조용히 건너뛰면(예: 회귀로 어느 한 축의
    // try/catch가 finding을 못 남기게 되면) 이 assertion이 그 축의 부재를
    // 잡아낸다.
    expect(
      new Set(
        result.findings
          .filter((finding) => finding.name === "BB_TARGET_PARSE")
          .map((finding) => finding.axis),
      ),
    ).toEqual(new Set(["syntax", "runtime-js", "dependency"]));
  });

  it("parse 실패해도 promise가 reject되지 않는다", async () => {
    await expect(
      checkLibrary({ projectDir: fixture("malformed"), allow: [] }),
    ).resolves.toBeDefined();
  });
});

describe("checkLibrary: esbuild가 표현할 수 없는 문법 target", () => {
  it("모바일 전용 브라우저만으로 구성된 baseline은 문법 검사를 건너뛰고 incomplete로 표시하되, runtime-js/dependency는 정상 진행한다", async () => {
    // ChromeAndroid/FirefoxAndroid/OperaMobile/Samsung은 실측으로 확인한
    // browserslist-to-esbuild(2.1.1)의 SUPPORTED_ESBUILD_TARGETS에 매핑되지
    // 않는 조합이다 — browserslistToEsbuild(...)가 빈 배열을 돌려준다.
    const dir = await mkdtemp(join(tmpdir(), "bb-library-mobile-only-"));
    try {
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "mobile-only-fixture",
          version: "1.0.0",
          private: true,
          browserslist: [
            "ChromeAndroid >= 100",
            "FirefoxAndroid >= 100",
            "OperaMobile >= 60",
            "Samsung >= 15",
          ],
          exports: "./dist/index.js",
        }),
        "utf8",
      );
      await writeFile(
        join(dir, "dist", "index.js"),
        [
          'import "missing-package";',
          "",
          "export function makeId() {",
          "  return structuredClone({ id: 1 });",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await checkLibrary({ projectDir: dir, allow: [] });

      expect(result.incomplete).toBe(true);
      // 문법 축 검사를 아예 시도하지 않았다는 것을 보여주는 finding이
      // 있어야 한다 — "아무 문제도 없었다(위반 0건)"처럼 보이면 안 된다.
      expect(
        result.findings.some(
          (finding) =>
            finding.axis === "syntax" &&
            finding.name === "BB_SYNTAX_TARGET_UNAVAILABLE",
        ),
      ).toBe(true);
      // 문법 위반 finding(syntax-divergence)은 애초에 검사를 시도하지
      // 않았으므로 나타나지 않는다.
      expect(
        result.findings.some((finding) => finding.name === "syntax-divergence"),
      ).toBe(false);
      // runtime-js와 dependency는 esbuild target과 무관하므로 정상적으로
      // 계속 검사되어야 한다.
      expect(
        result.findings.some(
          (finding) =>
            finding.axis === "runtime-js" && finding.name === "structuredClone",
        ),
      ).toBe(true);
      expect(
        result.findings.some(
          (finding) =>
            finding.axis === "dependency" && finding.name === "missing-package",
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("checkLibrary: BCD가 지원하지 않는 baseline browser", () => {
  it("mixed baseline의 판정 불가 browser를 runtime-js finding으로 보고하고 지원 browser 검사는 계속한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-library-bcd-unsupported-"));
    try {
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "bcd-unsupported-browser-fixture",
          version: "1.0.0",
          private: true,
          browserslist: ["chrome >= 100", "and_qq >= 14.9"],
          exports: "./dist/index.js",
        }),
        "utf8",
      );
      await writeFile(
        join(dir, "dist", "index.js"),
        [
          "export function copy(value) {",
          "  structuredClone(value);",
          "  return AbortSignal.timeout(1);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await checkLibrary({ projectDir: dir, allow: [] });

      expect(result.incomplete).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            axis: "runtime-js",
            file: "*",
            line: null,
            name: "BB_RUNTIME_BASELINE_UNSUPPORTED",
            detail: expect.stringContaining("and_qq 14.9"),
          }),
          expect.objectContaining({
            axis: "runtime-js",
            file: "dist/index.js",
            name: "AbortSignal.timeout",
          }),
        ]),
      );
      expect(
        result.findings.some((finding) => finding.name === "structuredClone"),
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("checkLibrary: 판정할 수 없는 JavaScript export target", () => {
  it("valid entry를 계속 검사하면서 root escape·절대·missing target을 모두 incomplete finding으로 보고한다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-library-invalid-exports-"));
    try {
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "invalid-exports-fixture",
          version: "1.0.0",
          private: true,
          browserslist: ["chrome >= 80"],
          exports: {
            ".": "./dist/index.js",
            "./escape": "../../outside.js",
            "./absolute": "/tmp/bb-check-absolute.js",
            "./missing": "./dist/missing.js",
            "./types": "./dist/index.d.ts",
            "./style": "./dist/style.css",
            "./data": "./dist/data.json",
            "./map": "./dist/index.js.map",
          },
        }),
        "utf8",
      );
      await writeFile(
        join(dir, "dist", "index.js"),
        "export const copy = (value) => structuredClone(value);\n",
        "utf8",
      );

      const result = await checkLibrary({ projectDir: dir, allow: [] });

      expect(result.incomplete).toBe(true);
      expect(result.ok).toBe(false);
      expect(
        result.findings
          .filter((finding) => finding.name === "BB_TARGET_READ")
          .map(({ axis, file, line }) => ({ axis, file, line })),
      ).toEqual([
        { axis: "syntax", file: "../../outside.js", line: null },
        { axis: "syntax", file: "./dist/missing.js", line: null },
        { axis: "syntax", file: "/tmp/bb-check-absolute.js", line: null },
      ]);
      expect(
        result.findings.some(
          (finding) =>
            finding.axis === "runtime-js" &&
            finding.file === "dist/index.js" &&
            finding.name === "structuredClone",
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("모든 JS target이 판정 불가여도 reject하지 않고 전체를 incomplete finding으로 보고한다", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "bb-library-all-invalid-exports-"),
    );
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "all-invalid-exports-fixture",
          version: "1.0.0",
          private: true,
          browserslist: ["chrome >= 80"],
          exports: {
            "./escape": "../../outside.js",
            "./absolute": "/tmp/bb-check-absolute.js",
            "./missing": "./dist/missing.js",
          },
        }),
        "utf8",
      );

      const result = await checkLibrary({ projectDir: dir, allow: [] });

      expect(result.incomplete).toBe(true);
      expect(result.ok).toBe(false);
      expect(
        result.findings.map(({ axis, file, line, name }) => ({
          axis,
          file,
          line,
          name,
        })),
      ).toEqual([
        {
          axis: "syntax",
          file: "../../outside.js",
          line: null,
          name: "BB_TARGET_READ",
        },
        {
          axis: "syntax",
          file: "./dist/missing.js",
          line: null,
          name: "BB_TARGET_READ",
        },
        {
          axis: "syntax",
          file: "/tmp/bb-check-absolute.js",
          line: null,
          name: "BB_TARGET_READ",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("checkLibrary: allowance 적용", () => {
  it("허용 목록과 정확히 일치하는 위반은 findings에서 빠진다", async () => {
    const result = await checkLibrary({
      projectDir: fixture("allowance"),
      allow: [
        {
          file: "dist/index.js",
          name: "structuredClone",
          reason: "테스트용 예외",
        },
      ],
    });
    expect(
      result.findings.some((finding) => finding.name === "structuredClone"),
    ).toBe(false);
  });

  it("한 번도 매칭되지 않은 allowance는 unused-allowance로 보고한다", async () => {
    const result = await checkLibrary({
      projectDir: fixture("allowance"),
      allow: [
        {
          file: "dist/index.js",
          name: "이런이름은쓰이지않는다",
          reason: "쓰이지 않을 예외",
        },
      ],
    });
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          axis: "runtime-js",
          name: "unused-allowance",
        }),
      ]),
    );
  });

  it("실제로 매칭된 allowance는 unused-allowance로 보고하지 않는다", async () => {
    const result = await checkLibrary({
      projectDir: fixture("allowance"),
      allow: [
        {
          file: "dist/index.js",
          name: "structuredClone",
          reason: "테스트용 예외",
        },
      ],
    });
    expect(
      result.findings.some((finding) => finding.name === "unused-allowance"),
    ).toBe(false);
  });
});

describe("checkLibrary: 결정성과 mutation 방지", () => {
  it("같은 fixture를 두 번 실행하면 결과가 완전히 같다", async () => {
    const options = { projectDir: fixture("violations"), allow: [] };
    const first = await checkLibrary(options);
    const second = await checkLibrary(options);
    expect(second).toEqual(first);
  });

  it("실행 중 allow 배열을 변경해도 결과가 바뀌지 않는다", async () => {
    const original: LibraryAllowance[] = [
      { file: "dist/index.js", name: "structuredClone", reason: "테스트" },
    ];
    const mutable = [...original];

    const mutatedRunPromise = checkLibrary({
      projectDir: fixture("allowance"),
      allow: mutable,
    });
    // 호출 직후(비동기 함수의 첫 await 이전 구간이 지난 뒤) 원본을 공격적으로 변경한다.
    mutable.push({ file: "*", name: "런타임중추가", reason: "실행 중 추가" });
    mutable.length = 0;

    const mutatedResult = await mutatedRunPromise;
    const referenceResult = await checkLibrary({
      projectDir: fixture("allowance"),
      allow: original,
    });

    expect(mutatedResult).toEqual(referenceResult);
  });
});

describe("checkLibrary: source map 귀속", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bb-library-check-library-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const writePackageJson = async (dir: string) =>
    writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "origin-lookup-fixture",
        version: "1.0.0",
        private: true,
        browserslist: ["chrome >= 80"],
        exports: "./dist/index.js",
      }),
      "utf8",
    );

  it("외부 source map 파일이 있으면 원본 위치로 귀속한다", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writePackageJson(tempDir);
    await writeFile(
      join(tempDir, "dist", "index.js"),
      [
        "export function makeId() {",
        "  return structuredClone({});",
        "}",
        "//# sourceMappingURL=index.js.map",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(tempDir, "dist", "index.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../src/index.ts"],
        sourcesContent: [
          "export function makeId() {\n  return structuredClone({});\n}\n",
        ],
        mappings: "AAAA;AAAA",
        names: [],
      }),
      "utf8",
    );

    const result = await checkLibrary({ projectDir: tempDir, allow: [] });
    const finding = result.findings.find((f) => f.name === "structuredClone");
    expect(finding?.originalFile).toBe("src/index.ts");
  });

  // 잡는 생산 결함: external map을 dist/maps에서 읽고도 generated file의
  // dist를 mapDir로 넘기면 ../src가 src로 해석되어 map 실제 위치를 잃는다.
  it("중첩 external source map의 실제 디렉터리 기준으로 원본 위치를 귀속한다", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tempDir, "dist", "maps"), { recursive: true });
    await writePackageJson(tempDir);
    await writeFile(
      join(tempDir, "dist", "index.js"),
      [
        "export function makeId() {",
        "  return structuredClone({});",
        "}",
        "//# sourceMappingURL=maps/index.js.map",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(tempDir, "dist", "maps", "index.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["../src/input.ts"],
        sourcesContent: [
          "export function makeId() {\n  return structuredClone({});\n}\n",
        ],
        mappings: "AAAA;AAAA",
        names: [],
      }),
      "utf8",
    );

    const result = await checkLibrary({ projectDir: tempDir, allow: [] });
    const finding = result.findings.find((f) => f.name === "structuredClone");
    expect(finding?.originalFile).toBe("dist/src/input.ts");
  });

  it("inline data URL source map도 원본 위치로 귀속한다", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writePackageJson(tempDir);

    const mapJson = JSON.stringify({
      version: 3,
      sources: ["../src/inline.ts"],
      sourcesContent: [
        "export function makeId() {\n  return structuredClone({});\n}\n",
      ],
      mappings: "AAAA;AAAA",
      names: [],
    });
    const dataUrl = `data:application/json;base64,${Buffer.from(mapJson, "utf8").toString("base64")}`;

    await writeFile(
      join(tempDir, "dist", "index.js"),
      [
        "export function makeId() {",
        "  return structuredClone({});",
        "}",
        `//# sourceMappingURL=${dataUrl}`,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkLibrary({ projectDir: tempDir, allow: [] });
    const finding = result.findings.find((f) => f.name === "structuredClone");
    expect(finding?.originalFile).toBe("src/inline.ts");
  });

  it("외부 source map 파일이 없으면 조용히 건너뛰고 incomplete로 만들지 않는다", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writePackageJson(tempDir);
    await writeFile(
      join(tempDir, "dist", "index.js"),
      [
        "export function makeId() {",
        "  return structuredClone({});",
        "}",
        "//# sourceMappingURL=missing.js.map",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await checkLibrary({ projectDir: tempDir, allow: [] });
    expect(result.incomplete).toBe(false);
    const finding = result.findings.find((f) => f.name === "structuredClone");
    expect(finding).toBeDefined();
    expect(finding?.originalFile).toBeUndefined();
  });

  it("source map이 없으면 생성 위치를 그대로 쓴다(originalFile 없음)", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tempDir, "dist"), { recursive: true });
    await writePackageJson(tempDir);
    await writeFile(
      join(tempDir, "dist", "index.js"),
      "export function makeId() {\n  return structuredClone({});\n}\n",
      "utf8",
    );

    const result = await checkLibrary({ projectDir: tempDir, allow: [] });
    const finding = result.findings.find((f) => f.name === "structuredClone");
    expect(finding).toBeDefined();
    expect(finding?.originalFile).toBeUndefined();
    expect(finding?.line).toBe(2);
  });
});
