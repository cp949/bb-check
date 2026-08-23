// 공개 `.d.ts`(dist/index.d.ts, dist/library.d.ts, dist/cli.d.ts)가 private
// workspace package(@cp949/bb-core, @cp949/bb-library)를 type-only import로도
// 참조하지 않는지 검증한다. `.js`는 Vite/Rolldown이 두 workspace package를
// 완전히 inline 번들하지만, `.d.ts`는 별도의 classic Rollup + rollup-plugin-dts
// invocation(rollup.dts.config.mjs, `includeExternal`)이 같은 일을 한다 —
// 두 산출물이 정말로 같은 계약을 지키는지 여기서 확인한다.
//
// substring 검사만으로는 부족하다 — 예전에 `vite-plugin-dts`(내부
// @microsoft/api-extractor)로 같은 걸 시도했을 때, bb-core를 inline하는
// 데는 "성공"(exit 0)했지만 생성된 BbError 클래스 선언에 constructor
// 구현체가 그대로 남아 `TS1183: An implementation cannot be declared in
// ambient contexts`로 깨지는 걸 별도로 타입체크를 돌려서야 발견했다
// (bb-library의 checkLibrary를 inline하려 하면 아예 api-extractor가
// internal error로 죽었다 — task-10-report.md "Fix 1" 절 참고). 그 교훈을
// 그대로 반영해, 이 테스트는 dist/*.d.ts 파일들을 워크스페이스와 완전히
// 분리된 임시 디렉터리로 복사하고(node_modules도, @cp949/bb-core나
// @cp949/bb-library도 전혀 없는 환경) TypeScript Compiler API로 실제
// 타입체크를 돌려 **문법·타입 모두 유효한지** 확인한다 — "포함되어 있지
// 않다"만 보고 "유효한 TypeScript다"를 가정하지 않는다.
//
// subprocess로 `npx tsc`를 spawn하는 대신 Compiler API를 직접 쓴다 — 임시
// 디렉터리는 repo 밖(os tmpdir)이라 `npx`가 local tsc를 못 찾고 레지스트리
// fallback을 시도할 위험이 있다. Compiler API는 이 파일이 이미 resolve한
// `typescript`(devDependency, root에 hoisted)를 그대로 재사용해 그 문제가
// 없다.

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const DIST_DIR = "packages/bb-check/dist";
const ENTRY_NAMES = ["index", "library", "cli"] as const;
const FORBIDDEN_REFERENCES = ["@cp949/bb-core", "@cp949/bb-library"];

describe("공개 .d.ts는 private workspace package를 참조하지 않는다", () => {
  it.each(ENTRY_NAMES)(
    "dist/%s.d.ts에 @cp949/bb-core/@cp949/bb-library 참조가 없다",
    async (name) => {
      const content = await readFile(join(DIST_DIR, `${name}.d.ts`), "utf8");
      for (const forbidden of FORBIDDEN_REFERENCES) {
        expect(content).not.toContain(forbidden);
      }
    },
  );

  it("격리된 임시 디렉터리에서 실제 typecheck로 유효성을 확인한다", async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), "bb-check-dts-consumer-"));
    try {
      // dist/**의 모든 .d.ts(entry 3개 + rollup-plugin-dts가 만드는 공유
      // 타입 chunk, 예: types-XXXXXXXX.d.ts)를 함께 복사한다 — entry
      // .d.ts가 상대 경로로 그 chunk를 import하므로 같이 있어야 한다.
      const dtsFiles = (await readdir(DIST_DIR)).filter((f) =>
        f.endsWith(".d.ts"),
      );
      for (const file of dtsFiles) {
        await writeFile(
          join(tmpRoot, file),
          await readFile(join(DIST_DIR, file)),
        );
      }

      // 실제 소비자가 쓸 법한 최소 사용 코드 — index.js에서 defineConfig,
      // library.js에서 checkLibrary/BbError를 가져와 실제로 사용한다.
      // 단순히 import만 하고 안 쓰면 deep type 검사가 트리거되지 않아
      // 얕은 통과가 나올 수 있다.
      const checkFile = join(tmpRoot, "check.ts");
      await writeFile(
        checkFile,
        [
          'import { defineConfig } from "./index.js";',
          'import { checkLibrary, BbError } from "./library.js";',
          "",
          'const cfg = defineConfig({ library: { projectDir: ".", allow: [] } });',
          "void cfg;",
          "",
          "async function run() {",
          '  const result = await checkLibrary({ projectDir: "." });',
          "  void result.ok;",
          '  const err = new BbError("BB_USAGE", "test");',
          "  void err.code;",
          "}",
          "void run();",
          "",
        ].join("\n"),
        "utf8",
      );

      const program = ts.createProgram({
        rootNames: [checkFile],
        options: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: false,
          noEmit: true,
          types: [],
        },
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);

      if (diagnostics.length > 0) {
        const formatted = ts.formatDiagnostics(diagnostics, {
          getCurrentDirectory: () => tmpRoot,
          getCanonicalFileName: (fileName) => fileName,
          getNewLine: () => "\n",
        });
        throw new Error(`격리된 typecheck가 실패했다:\n${formatted}`);
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
