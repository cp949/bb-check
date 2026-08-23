# Browser Baseline CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** npm 패키지 `@cp949/bb-check@0.1.0`의 모노레포 골격과 라이브러리용 브라우저 기준선 검사 CLI를 구현하고 tarball 소비까지 검증한다.

**Architecture:** 공개 facade인 `packages/bb-check`가 CLI·설정·출력을 소유하고, `packages/bb-library`가 라이브러리 산출물 검사를 작은 interface 뒤에 숨긴다. `packages/core`는 두 프로젝트 방식이 실제로 공유하는 결과·오류·설정 의미만 소유하며, private workspace 코드는 Vite가 단일 공개 tarball 안에 번들한다.

**Tech Stack:** Node 22 개발 환경, Node 20 공개 CLI runtime, npm 11.19.0 workspaces, TypeScript 7.0.2, Vite 8.2.2, Vitest 4.1.11, Turborepo 2.10.11, ESLint, Prettier

**Spec:** `docs/superpowers/specs/2026-08-24-browser-baseline-cli-design.md`

## Global Constraints

- 공개 패키지 이름은 `@cp949/bb-check`, 초기 릴리스 후보는 `0.1.0`이다.
- 디렉터리는 `packages/core`, `packages/bb-library`, `packages/bb-nextjs`, `packages/bb-check`, `apps/demo`로 고정한다.
- `core`, `bb-library`, `bb-nextjs`는 private workspace이고 `bb-check`만 공개한다.
- 의존 방향은 `bb-check → bb-library → core`; Next.js 구현이 추가된 뒤에만 `bb-check → bb-nextjs → core`를 연결한다.
- 개발·전체 build는 Node `>=22.12`, 공개 기본 CLI는 Node `>=20`, 향후 runtime smoke는 Node `>=22`다.
- npm은 major 11의 `11.19.0`; Vite `8.2.2`; Vitest `4.1.11`; Turborepo `2.10.11`; TypeScript `7.0.2`를 사용한다.
- 브라우저 기준선의 유일한 정본은 대상 프로젝트의 `package.json#browserslist`다.
- CLI 기준선 override와 `BROWSERSLIST` 환경변수 override를 허용하지 않는다.
- 설정 정본은 `bb-check.config.mjs`; `--config`는 탐색을, `--dir`은 대상 위치만 재정의한다.
- 기본 출력은 한국어이고 exit code는 `0=통과`, `1=위반 또는 불완전 판정`, `2=사용법·설정·환경 오류`다.
- 회사·내부 제품·프로젝트·저장소명, 내부 경로·URL·환경변수·패키지·페이지 이름을 추적 파일과 tarball에 기록하지 않는다.
- 공개 정보 검사는 실제 금지 패턴을 저장소 밖 환경변수로 주입하며, fixture에는 일반화한 가상 이름만 사용한다.
- 추적된 정적 fixture만 자동 테스트 정본으로 사용한다. ignored 작업 자료를 oracle로 사용하지 않는다.
- 구현은 red-green-refactor 순서로 진행하고 각 task의 전체 회귀 검증을 통과한 뒤 다음 task로 이동한다.
- commit, push, tag, npm publish는 각각 별도 사용자 승인 사항이다. 아래 commit 단계는 승인이 있을 때만 실행한다.

---

## File Map

### Root

- `package.json`: npm workspaces, 고정 도구 버전, Turbo 진입 script
- `package-lock.json`: 설치 재현성
- `.nvmrc`: 개발 major 22
- `turbo.json`: build/test/typecheck/lint task graph
- `tsconfig.base.json`: strict ESM 공통 compiler option
- `tsconfig.json`: workspace project reference
- `eslint.config.js`: TypeScript와 ESM lint 규칙
- `.prettierrc.json`, `.prettierignore`: 포맷 계약
- `.gitignore`: 생성물과 tarball 제외

### `packages/core`

- `src/types.ts`: baseline, finding, result, allowance 타입
- `src/errors.ts`: `BbError`와 안정 오류 코드
- `src/sort-findings.ts`: finding 안정 정렬
- `src/config.ts`: 외부 config의 조밀한 복사·검증·동결
- `src/index.ts`: 내부 package interface
- `test/*.test.ts`: 위 interface의 행동 계약

### `packages/bb-library`

- `src/baseline.ts`: browserslist에서 판정 기준선 파생
- `src/dist-entries.ts`: `package.json#exports`의 배포 JS 파일 수집
- `src/syntax-gate.ts`: esbuild 기반 문법 차이 판정
- `src/source-origin.ts`: source map 원본 위치 귀속
- `src/compat-bcd.ts`: BCD support 정규화와 색인 생성
- `src/compat-scope.ts`: AST global reference 수집
- `src/compat-scanner.ts`: runtime API tier 판정과 예외 적용
- `src/dependency-closure.ts`: 배포 JS의 runtime import 폐쇄성 검사
- `src/check-library.ts`: 전체 orchestration과 `CheckResult` 반환
- `src/index.ts`: `checkLibrary`만 노출하는 내부 interface
- `test/fixtures/**`: 일반화된 정적 package fixture
- `test/*.test.ts`: 수집기·판정기·통합 계약

### `packages/bb-nextjs`

- `package.json`: private workspace 선언
- `tsconfig.json`: 공통 TypeScript 설정 상속
- `README.md`: 이번 릴리스에서 실행 기능이 없고 공개되지 않음을 기록

### `packages/bb-check`

- `src/index.ts`: `defineConfig`
- `src/library.ts`: `checkLibrary` public subpath 재노출
- `src/config-loader.ts`: config 탐색·동적 import·경로 정규화
- `src/report.ts`: 한국어 보고서 렌더링
- `src/cli/args.ts`: 명시적 `library check` 문법 파싱
- `src/cli/main.ts`: 결과·오류를 stdout/stderr/exit code로 변환
- `src/cli.ts`: shebang이 있는 executable entry
- `vite.config.ts`: 세 public entry와 internal workspace bundling
- `test/*.test.ts`: config·report·CLI process 계약
- `test/goldens/*.txt`: 바이트 단위 출력 정본

### `apps/demo`

- `src/main.ts`, `index.html`: private Vite 소비자 화면
- `scripts/build-fixtures.ts`: 호환/비호환 demo 산출물 생성
- `bb-check.config.mjs`: library 검사 예시
- `README.md`: 수동 성공·실패 재현 명령

### Repository verification

- `scripts/check-package-files.mjs`: tarball allowlist와 manifest 검사
- `scripts/check-public-words.mjs`: 추적 파일/tarball 금지 패턴 검사
- `scripts/test-packed-package.mjs`: 임시 소비자 설치·import·CLI 실행
- `tests/repository-structure.test.ts`: workspace와 공개/비공개 metadata 계약
- `.github/workflows/ci.yml`: Node/OS matrix

---

### Task 1: npm/Turbo/TypeScript workspace 골격

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `.nvmrc`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `.gitignore`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/bb-library/package.json`
- Create: `packages/bb-library/tsconfig.json`
- Create: `packages/bb-nextjs/package.json`
- Create: `packages/bb-nextjs/tsconfig.json`
- Create: `packages/bb-nextjs/README.md`
- Create: `packages/bb-check/package.json`
- Create: `packages/bb-check/tsconfig.json`
- Create: `tests/repository-structure.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: npm workspace 이름 `@cp949/bb-core`, `@cp949/bb-library`, `@cp949/bb-nextjs`, `@cp949/bb-check`; root scripts `build`, `test`, `typecheck`, `lint`, `format:check`, `check`

- [ ] **Step 1: 구조 계약 테스트를 먼저 작성한다**

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("workspace 공개 경계", () => {
  it("bb-check만 공개 패키지다", async () => {
    const names = ["core", "bb-library", "bb-nextjs", "bb-check"];
    const manifests = await Promise.all(
      names.map((name) => readJson(`packages/${name}/package.json`)),
    );

    expect(manifests.map(({ name, private: isPrivate }) => [name, isPrivate])).toEqual([
      ["@cp949/bb-core", true],
      ["@cp949/bb-library", true],
      ["@cp949/bb-nextjs", true],
      ["@cp949/bb-check", false],
    ]);
  });
});
```

- [ ] **Step 2: 설치 전 테스트가 실패함을 확인한다**

Run: `npm test -- --run tests/repository-structure.test.ts`

Expected: FAIL because root/package manifests and Vitest installation do not exist.

- [ ] **Step 3: root와 workspace manifest를 만든다**

Root `package.json`의 핵심 값:

```json
{
  "name": "bb-check-workspace",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "packageManager": "npm@11.19.0",
  "engines": { "node": ">=22.12" },
  "scripts": {
    "build": "turbo run build",
    "test": "vitest run",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "format:check": "prettier --check .",
    "check": "npm run format:check && npm run lint && npm run typecheck && npm test && npm run build"
  }
}
```

`packages/bb-check/package.json`은 `private: false`, 나머지는 `private: true`로 둔다. `packages/bb-nextjs`에는 `exports`와 runtime source를 만들지 않는다.

- [ ] **Step 4: 고정 버전 도구를 설치한다**

Run:

```bash
npm install --save-dev --save-exact typescript@7.0.2 vite@8.2.2 vitest@4.1.11 turbo@2.10.11 eslint@latest @eslint/js@latest typescript-eslint@latest prettier@latest
```

Expected: `package-lock.json` 생성, npm workspace link 생성, install exit 0.

- [ ] **Step 5: strict ESM 설정과 Turbo graph를 작성한다**

`tsconfig.base.json` 핵심:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "skipLibCheck": true
  }
}
```

Turbo task는 `build`가 `^build`, `typecheck`가 `^typecheck`, test/lint가 package-local script를 실행하도록 구성한다. build output은 `dist/**`만 캐시한다.

- [ ] **Step 6: 구조 계약과 정적 설정을 검증한다**

Run: `npm test -- --run tests/repository-structure.test.ts && npm run typecheck && npm run lint && npm run format:check`

Expected: all exit 0.

- [ ] **Step 7: 승인된 경우에만 골격을 commit한다**

```bash
git add package.json package-lock.json .nvmrc turbo.json tsconfig.base.json tsconfig.json eslint.config.js .prettierrc.json .prettierignore .gitignore packages/core packages/bb-library packages/bb-nextjs packages/bb-check tests/repository-structure.test.ts
git commit -m "chore: bb-check 모노레포 골격을 구성한다"
```

승인이 없으면 stage와 commit을 생략하고 working tree에 유지한다.

---

### Task 2: core 결과·오류·정렬 계약

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/sort-findings.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/test/errors.test.ts`
- Create: `packages/core/test/sort-findings.test.ts`

**Interfaces:**
- Consumes: Task 1의 `@cp949/bb-core` workspace
- Produces: `FindingAxis`, `Finding`, `CheckResult`, `BrowserBaseline`, `LibraryAllowance`, `BbErrorCode`, `BbError`, `sortFindings(findings)`

- [ ] **Step 1: 오류와 정렬의 실패 테스트를 작성한다**

```ts
import { describe, expect, it } from "vitest";
import { BbError, sortFindings } from "../src/index.js";

describe("core 계약", () => {
  it("오류 code와 cause를 보존한다", () => {
    const cause = new Error("disk");
    const error = new BbError("BB_TARGET_READ", "읽기 실패", { cause });
    expect(error).toMatchObject({ code: "BB_TARGET_READ", message: "읽기 실패", cause });
  });

  it("finding을 axis, file, line, name 순서로 정렬한다", () => {
    const input = [
      { axis: "runtime-js", file: "b.js", line: 2, name: "at", detail: "x" },
      { axis: "syntax", file: "a.js", line: 9, name: "optional-chaining", detail: "x" },
    ] as const;
    expect(sortFindings(input).map(({ axis }) => axis)).toEqual(["syntax", "runtime-js"]);
    expect(input[0]?.file).toBe("b.js");
  });
});
```

- [ ] **Step 2: 테스트 실패를 확인한다**

Run: `npm test -- --run packages/core/test/errors.test.ts packages/core/test/sort-findings.test.ts`

Expected: FAIL because `src/index.ts` and exported symbols do not exist.

- [ ] **Step 3: discriminated finding과 안정 오류를 구현한다**

```ts
export type FindingAxis = "syntax" | "runtime-js" | "dependency" | "css";

export type BrowserBaseline = Readonly<Record<string, string>>;

export interface LibraryAllowance {
  readonly file: string;
  readonly name: string;
  readonly reason: string;
}

export interface Finding {
  readonly axis: FindingAxis;
  readonly file: string;
  readonly line: number | null;
  readonly name: string;
  readonly detail: string;
  readonly originalFile?: string;
}

export interface CheckResult {
  readonly baseline: Readonly<Record<string, string>>;
  readonly findings: readonly Finding[];
  readonly incomplete: boolean;
  readonly ok: boolean;
}

export type BbErrorCode =
  | "BB_USAGE"
  | "BB_CONFIG_NOT_FOUND"
  | "BB_CONFIG_INVALID"
  | "BB_BASELINE_EMPTY"
  | "BB_INPUT_NOT_FOUND"
  | "BB_TARGET_READ"
  | "BB_TARGET_PARSE"
  | "BB_UNEXPECTED";
```

`sortFindings`는 입력을 변경하지 않고 복사본을 정렬한다. axis 순서는 `syntax`, `runtime-js`, `dependency`, `css`; `line: null`은 같은 파일의 숫자 line 뒤에 둔다.

- [ ] **Step 4: core 테스트와 typecheck를 통과시킨다**

Run: `npm test -- --run packages/core/test && npm run typecheck -- --filter=@cp949/bb-core`

Expected: tests pass, TypeScript error 0.

- [ ] **Step 5: 승인된 경우에만 core 계약을 commit한다**

```bash
git add packages/core
git commit -m "feat: 기준선 검사 결과와 오류 계약을 정의한다"
```

---

### Task 3: config 조밀 검증과 깊은 동결

**Files:**
- Create: `packages/core/src/config.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/config.test.ts`

**Interfaces:**
- Consumes: `BbError`, `LibraryAllowance`
- Produces: `BbCheckConfig`, `NormalizedBbCheckConfig`, `normalizeConfig(input, configDir)`

```ts
export interface BbCheckConfig {
  readonly library: {
    readonly projectDir: string;
    readonly allow?: readonly LibraryAllowance[];
  };
}

export interface NormalizedBbCheckConfig {
  readonly library: {
    readonly projectDir: string;
    readonly allow: readonly LibraryAllowance[];
  };
}

export function normalizeConfig(
  input: unknown,
  configDir: string,
): NormalizedBbCheckConfig;
```

- [ ] **Step 1: hostile input을 포함한 실패 테스트를 작성한다**

```ts
it("own index가 없는 sparse allow 배열을 거절한다", () => {
  const allow = new Array(1);
  expect(() => normalizeConfig({ library: { projectDir: ".", allow } }, "/repo"))
    .toThrowError(/\[BB_CONFIG_INVALID\].*library\.allow\[0\]/);
});

it("상속 property와 입력 객체 mutation을 차단한다", () => {
  const library = Object.create({ projectDir: "/leak" }) as Record<string, unknown>;
  library.allow = [];
  expect(() => normalizeConfig({ library }, "/repo")).toThrowError(/projectDir/);

  const input = { library: { projectDir: ".", allow: [] } };
  const normalized = normalizeConfig(input, "/repo");
  input.library.projectDir = "changed";
  expect(normalized.library?.projectDir).toBe("/repo");
  expect(Object.isFrozen(normalized.library?.allow)).toBe(true);
});
```

- [ ] **Step 2: 실패 이유를 확인한다**

Run: `npm test -- --run packages/core/test/config.test.ts`

Expected: FAIL because `normalizeConfig` is missing.

- [ ] **Step 3: own-property dense copy와 validation을 구현한다**

검증 순서:

1. root와 `library`가 plain object인지 확인
2. `projectDir`가 own non-empty string인지 확인
3. `allow`가 dense array인지 `Object.hasOwn(allow, index)`로 확인
4. 각 allowance의 `file`, `name`, `reason`이 own non-empty string인지 확인
5. `file + "\0" + name` 중복을 거절
6. config directory 기준 절대 `projectDir` 생성
7. 새 객체만 생성하고 배열·항목·root를 깊게 동결

getter를 실행하지 않도록 `Object.getOwnPropertyDescriptor`의 data property만 허용한다.

- [ ] **Step 4: focused와 core 전체 검증을 실행한다**

Run: `npm test -- --run packages/core/test/config.test.ts && npm test -- --run packages/core/test && npm run typecheck -- --filter=@cp949/bb-core`

Expected: all pass.

- [ ] **Step 5: 승인된 경우에만 config 계약을 commit한다**

```bash
git add packages/core
git commit -m "feat: bb-check 설정을 검증하고 동결한다"
```

---

### Task 4: browserslist 기준선과 exports 산출물 수집

**Files:**
- Create: `packages/bb-library/src/baseline.ts`
- Create: `packages/bb-library/src/dist-entries.ts`
- Create: `packages/bb-library/src/index.ts`
- Create: `packages/bb-library/test/baseline.test.ts`
- Create: `packages/bb-library/test/dist-entries.test.ts`
- Create: `packages/bb-library/test/fixtures/clean/package.json`
- Create: `packages/bb-library/test/fixtures/clean/dist/index.js`
- Create: `packages/bb-library/test/fixtures/multi-entry/package.json`
- Create: `packages/bb-library/test/fixtures/multi-entry/dist/index.js`
- Create: `packages/bb-library/test/fixtures/multi-entry/dist/feature.cjs`
- Create: `packages/bb-library/test/fixtures/empty-exports/package.json`

**Interfaces:**
- Consumes: `BbError`, `BrowserBaseline`
- Produces: `loadLibraryBaseline(projectDir)`, `resolveDistEntries(projectDir)`

- [ ] **Step 1: 기준선과 조건부 exports 실패 테스트를 작성한다**

```ts
it("browserslist와 JS exports를 프로젝트에서 파생한다", async () => {
  expect(await loadLibraryBaseline(fixture("clean"))).toMatchObject({ chrome: "80" });
  expect(await resolveDistEntries(fixture("multi-entry"))).toEqual([
    expect.stringMatching(/dist\/feature\.cjs$/),
    expect.stringMatching(/dist\/index\.js$/),
  ]);
});

it("exports에 JavaScript가 없으면 BB_INPUT_NOT_FOUND다", async () => {
  await expect(resolveDistEntries(fixture("empty-exports")))
    .rejects.toMatchObject({ code: "BB_INPUT_NOT_FOUND" });
});
```

- [ ] **Step 2: 테스트가 missing export로 실패함을 확인한다**

Run: `npm test -- --run packages/bb-library/test/baseline.test.ts packages/bb-library/test/dist-entries.test.ts`

Expected: FAIL because functions are missing.

- [ ] **Step 3: 기준선 파생을 구현한다**

`browserslist`를 production env로 실행하고 브라우저별 최소 major/minor를 `Record<string,string>`으로 만든다. 결과가 비면 `BB_BASELINE_EMPTY`; package나 browserslist가 없으면 `BB_INPUT_NOT_FOUND`/`BB_CONFIG_INVALID`로 분류한다. `BROWSERSLIST`, `BROWSERSLIST_ENV`, `NODE_ENV`로 판정이 바뀌지 않도록 명시 option을 사용하고 금지 override가 있으면 config 오류로 실패한다.

- [ ] **Step 4: library와 공개 tarball의 runtime dependency를 설치한다**

Run:

```bash
npm install --workspace packages/bb-library --save-exact @mdn/browser-compat-data@8.0.12 acorn@8.18.0 browserslist@4.28.8 browserslist-to-esbuild@2.1.1 esbuild@0.28.2
npm install --workspace packages/bb-check --save-exact @mdn/browser-compat-data@8.0.12 acorn@8.18.0 browserslist@4.28.8 browserslist-to-esbuild@2.1.1 esbuild@0.28.2
```

Expected: 두 manifest와 lockfile에 같은 고정 버전이 기록되고 한 벌로 hoist된다.

- [ ] **Step 5: exports walker를 구현한다**

walker는 string, array, condition object, subpath object를 순회하되 package root 밖 경로를 거절한다. `.js`, `.mjs`, `.cjs`만 수집하고 실제 파일로 정규화한 뒤 중복 제거·정렬한다. `types`, CSS, JSON, source map은 검사 진입점에서 제외한다.

- [ ] **Step 6: focused와 package typecheck를 통과시킨다**

Run: `npm test -- --run packages/bb-library/test/baseline.test.ts packages/bb-library/test/dist-entries.test.ts && npm run typecheck -- --filter=@cp949/bb-library`

Expected: all pass.

- [ ] **Step 7: 승인된 경우에만 수집기를 commit한다**

```bash
git add packages/bb-library packages/core/package.json
git commit -m "feat: 라이브러리 기준선과 배포 진입점을 수집한다"
```

---

### Task 5: 문법 판정과 source map 원본 귀속

**Files:**
- Create: `packages/bb-library/src/syntax-gate.ts`
- Create: `packages/bb-library/src/source-origin.ts`
- Modify: `packages/bb-library/src/index.ts`
- Create: `packages/bb-library/test/syntax-gate.test.ts`
- Create: `packages/bb-library/test/source-origin.test.ts`
- Create: `packages/bb-library/test/fixtures/syntax-violation/dist/index.js`
- Create: `packages/bb-library/test/fixtures/source-map/dist/index.js`
- Create: `packages/bb-library/test/fixtures/source-map/dist/index.js.map`

**Interfaces:**
- Consumes: `Finding`, 정규화된 browser baseline
- Produces: `findFirstSyntaxDivergence(source, syntaxTarget)`, `createOriginLookup(mapText, { mapDir })`

- [ ] **Step 1: 문법 차이와 source map 실패 테스트를 작성한다**

```ts
it("계약 target에서 변환되는 첫 문법을 보고한다", async () => {
  const result = await findFirstSyntaxDivergence("const x = value?.name;", "chrome80");
  expect(result).toMatchObject({ line: expect.any(Number) });
});

it("생성 위치를 원본 파일 위치로 바꾼다", () => {
  const { originOf } = createOriginLookup(validMapText, { mapDir: "dist" });
  expect(originOf(1)).toMatch(/src\/input\.ts$/);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --run packages/bb-library/test/syntax-gate.test.ts packages/bb-library/test/source-origin.test.ts`

Expected: FAIL because syntax and source-map modules are absent.

- [ ] **Step 3: esbuild 이중 변환 문법 판정을 구현한다**

같은 source를 `target: esnext`와 baseline target으로 `transform`하고 의미 없는 source map/comment 차이를 제거한 출력이 다르면 변환된 첫 위치를 반환한다. esbuild parse 실패는 `BB_TARGET_PARSE` finding으로 상위 orchestration이 수집할 수 있게 typed failure로 반환한다.

- [ ] **Step 4: source map lookup을 구현한다**

외부 map만 읽고 inline data URL은 입력 JS에서 해석한다. map source path는 `mapDir` 기준으로 정규화하되 root 밖도 정보로 보존한다. map이 없으면 generated 위치를 유지하고, malformed map은 `BB_TARGET_PARSE`로 결과를 불완전하게 만든다.

- [ ] **Step 5: focused와 누적 library 테스트를 실행한다**

Run: `npm test -- --run packages/bb-library/test && npm run typecheck -- --filter=@cp949/bb-library`

Expected: all pass.

- [ ] **Step 6: 승인된 경우에만 문법·source map을 commit한다**

```bash
git add packages/bb-library
git commit -m "feat: 배포 문법 위반을 원본 위치로 귀속한다"
```

---

### Task 6: BCD runtime API scanner

**Files:**
- Create: `packages/bb-library/src/compat-bcd.ts`
- Create: `packages/bb-library/src/compat-scope.ts`
- Create: `packages/bb-library/src/compat-scanner.ts`
- Modify: `packages/bb-library/src/index.ts`
- Create: `packages/bb-library/test/compat-bcd.test.ts`
- Create: `packages/bb-library/test/compat-scope.test.ts`
- Create: `packages/bb-library/test/compat-scanner.test.ts`

**Interfaces:**
- Consumes: `LibraryAllowance`, browser baseline, JavaScript source
- Produces: `normalizeBrowserSupport`, `buildCompatIndex`, `collectGlobalReferences`, `createCompatScanner({ baseline, allowed })`

- [ ] **Step 1: BCD normalization matrix 실패 테스트를 작성한다**

```ts
it.each([
  [{ version_added: "80" }, "80"],
  [{ version_added: true }, null],
  [{ version_added: false }, null],
  [[{ version_added: "80", version_removed: "90" }, { version_added: "100" }], "100"],
])("support statement %j를 정규화한다", (statement, expected) => {
  expect(normalizeBrowserSupport(statement)).toBe(expected);
});
```

- [ ] **Step 2: scope와 scanner 실패 테스트를 작성한다**

```ts
it("shadowed global은 global reference가 아니다", () => {
  const ast = parse("function f(AbortSignal) { return AbortSignal.timeout(1); }");
  expect(collectGlobalReferences(ast)).not.toContainEqual(
    expect.objectContaining({ name: "AbortSignal" }),
  );
});

it("global, instance, option subfeature를 tier별로 찾는다", () => {
  const scan = createCompatScanner({ baseline: { chrome: "80" }, allowed: [] });
  const findings = scan(sourceWithThreeTiers, "dist/index.js");
  expect(findings.map(({ name }) => name)).toEqual([
    "AbortSignal.timeout",
    "Array.prototype.at",
    "Error.Error.options_cause_parameter",
  ]);
});
```

- [ ] **Step 3: 테스트가 missing modules로 실패함을 확인한다**

Run: `npm test -- --run packages/bb-library/test/compat-bcd.test.ts packages/bb-library/test/compat-scope.test.ts packages/bb-library/test/compat-scanner.test.ts`

Expected: FAIL.

- [ ] **Step 4: BCD index와 lexical scope 분석을 구현한다**

BCD walker는 각 판정 브라우저의 `version_added`, `version_removed`, alternative statement를 정규화한다. 지원 시작이 baseline보다 늦거나 baseline 구간에서 제거된 API만 색인한다. Scope walker는 module/function/block/class/catch binding과 import, parameter, destructuring을 추적해 shadowed global을 제거한다.

- [ ] **Step 5: tier scanner와 allowance를 구현한다**

- tier 1: 증명된 global identifier와 global static member
- tier 2: 수신자 타입이 불명인 instance member
- tier 3: constructor/method option subfeature
- `typeof global === "undefined"`와 같은 보호 분기 안의 안전 fallback은 면제
- allowance는 정확한 normalized file/name pair만 면제하고 reason을 필수로 함
- 매칭 횟수를 기록해 미사용 allowance를 상위 결과가 보고할 수 있게 함

- [ ] **Step 6: negative matrix까지 실행한다**

Run: `npm test -- --run packages/bb-library/test/compat-bcd.test.ts packages/bb-library/test/compat-scope.test.ts packages/bb-library/test/compat-scanner.test.ts && npm run typecheck -- --filter=@cp949/bb-library`

Expected: bindings, deep member prefix, removed API, guarded API tests all pass.

- [ ] **Step 7: 승인된 경우에만 runtime scanner를 commit한다**

```bash
git add packages/bb-library package.json package-lock.json
git commit -m "feat: BCD 기반 runtime API 판정을 추가한다"
```

---

### Task 7: 배포 dependency closure 검사

**Files:**
- Create: `packages/bb-library/src/dependency-closure.ts`
- Modify: `packages/bb-library/src/index.ts`
- Create: `packages/bb-library/test/dependency-closure.test.ts`
- Create: `packages/bb-library/test/fixtures/dependency-clean/package.json`
- Create: `packages/bb-library/test/fixtures/dependency-clean/dist/index.js`
- Create: `packages/bb-library/test/fixtures/dependency-violations/package.json`
- Create: `packages/bb-library/test/fixtures/dependency-violations/dist/index.js`

**Interfaces:**
- Consumes: package manifest와 최종 exported JavaScript source
- Produces: `createDependencyClosureScanner(projectDir).scan(source, file)`

- [ ] **Step 1: import 분류와 경로 matrix 실패 테스트를 작성한다**

```ts
it.each([
  ["node:fs", []],
  ["@scope/self/subpath", []],
  ["declared-peer", []],
  ["declared-dependency", ["dependency-leak"]],
  ["optional-only", ["optional-dependency-leak"]],
  ["missing-package", ["undeclared-runtime"]],
])("specifier %s를 분류한다", (specifier, expectedKinds) => {
  expect(scanImport(specifier).map(({ kind }) => kind)).toEqual(expectedKinds);
});

it.each(["./chunk.js", ".\\chunk.cjs", "C:\\chunk.cjs", "C:chunk.cjs", "\\\\server\\chunk.cjs"])(
  "로컬 경로 %s를 package import로 오인하지 않는다",
  (specifier) => expect(scanImport(specifier)).toEqual([]),
);
```

- [ ] **Step 2: line terminator와 computed import 실패 테스트를 추가한다**

CRLF, CR, LF, U+2028, U+2029 각각에서 line index가 동일한 source를 만들고 `import(name)`과 `require(name)`은 `computed-specifier`로 보고되는지 단언한다.

- [ ] **Step 3: focused 테스트 실패를 확인한다**

Run: `npm test -- --run packages/bb-library/test/dependency-closure.test.ts`

Expected: FAIL because scanner is missing.

- [ ] **Step 4: manifest 기반 closure scanner를 구현한다**

분류 우선순위:

1. builtin/local/self/peer 허용
2. optional dependency leak
3. dependency leak
4. undeclared runtime
5. computed specifier

정적 `import`, `export ... from`, literal `import()`, CJS `require()`를 파싱한다. Windows local path는 `path.win32.isAbsolute`, drive-relative prefix, UNC를 별도로 처리한다. line split은 `/\r\n|[\n\r\u2028\u2029]/`를 사용한다.

- [ ] **Step 5: focused와 누적 테스트를 실행한다**

Run: `npm test -- --run packages/bb-library/test/dependency-closure.test.ts && npm test -- --run packages/bb-library/test && npm run typecheck -- --filter=@cp949/bb-library`

Expected: all pass.

- [ ] **Step 6: 승인된 경우에만 dependency closure를 commit한다**

```bash
git add packages/bb-library
git commit -m "feat: 배포 dependency closure를 검사한다"
```

---

### Task 8: `checkLibrary` orchestration

**Files:**
- Create: `packages/bb-library/src/check-library.ts`
- Modify: `packages/bb-library/src/index.ts`
- Create: `packages/bb-library/test/check-library.test.ts`
- Create: `packages/bb-library/test/fixtures/violations/package.json`
- Create: `packages/bb-library/test/fixtures/violations/dist/index.js`
- Create: `packages/bb-library/test/fixtures/allowance/package.json`
- Create: `packages/bb-library/test/fixtures/allowance/dist/index.js`
- Create: `packages/bb-library/test/fixtures/malformed/package.json`
- Create: `packages/bb-library/test/fixtures/malformed/dist/index.js`

**Interfaces:**
- Consumes: Tasks 4~7의 collectors/scanners, `sortFindings`
- Produces: `checkLibrary(options: CheckLibraryOptions): Promise<CheckResult>`

```ts
export interface CheckLibraryOptions {
  readonly projectDir: string;
  readonly allow?: readonly LibraryAllowance[];
}

export function checkLibrary(options: CheckLibraryOptions): Promise<CheckResult>;
```

- [ ] **Step 1: end-to-end 실패 테스트를 작성한다**

```ts
it("세 판정 축을 한 결과로 모은다", async () => {
  const result = await checkLibrary({ projectDir: fixture("violations"), allow: [] });
  expect(result.ok).toBe(false);
  expect(new Set(result.findings.map(({ axis }) => axis))).toEqual(
    new Set(["syntax", "runtime-js", "dependency"]),
  );
});

it("한 파일 parse 실패 뒤에도 나머지를 검사하고 incomplete로 표시한다", async () => {
  const result = await checkLibrary({ projectDir: fixture("malformed"), allow: [] });
  expect(result.incomplete).toBe(true);
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "BB_TARGET_PARSE" }),
  ]));
});
```

- [ ] **Step 2: orchestration 부재로 실패함을 확인한다**

Run: `npm test -- --run packages/bb-library/test/check-library.test.ts`

Expected: FAIL because `checkLibrary` is absent.

- [ ] **Step 3: 전체 검사 흐름을 구현한다**

각 entry를 읽고 syntax, runtime-js, dependency scanner를 실행한다. 한 파일 오류는 error finding으로 바꾸고 다음 파일을 계속한다. source map은 있으면 귀속하고 없으면 generated file을 유지한다. allowance 매칭 횟수가 0이면 `runtime-js` 축의 `unused-allowance` finding으로 보고한다. `ok`는 `findings.length === 0 && !incomplete`다.

- [ ] **Step 4: 결과 결정성과 mutation 방지를 검증한다**

동일 fixture를 두 번 실행해 `CheckResult` deep equality를 확인하고, 전달한 allowance를 실행 중 변경해도 결과가 변하지 않는 테스트를 추가한다.

- [ ] **Step 5: package 전체 테스트를 실행한다**

Run: `npm test -- --run packages/bb-library/test && npm run typecheck -- --filter=@cp949/bb-library`

Expected: all pass.

- [ ] **Step 6: 승인된 경우에만 library orchestration을 commit한다**

```bash
git add packages/bb-library
git commit -m "feat: 라이브러리 기준선 검사를 통합한다"
```

---

### Task 9: 공개 config facade, 보고서, CLI

**Files:**
- Create: `packages/bb-check/src/index.ts`
- Create: `packages/bb-check/src/library.ts`
- Create: `packages/bb-check/src/config-loader.ts`
- Create: `packages/bb-check/src/report.ts`
- Create: `packages/bb-check/src/cli/args.ts`
- Create: `packages/bb-check/src/cli/main.ts`
- Create: `packages/bb-check/src/cli.ts`
- Create: `packages/bb-check/test/config-loader.test.ts`
- Create: `packages/bb-check/test/report.test.ts`
- Create: `packages/bb-check/test/cli.test.ts`
- Create: `packages/bb-check/test/goldens/library-pass.txt`
- Create: `packages/bb-check/test/goldens/library-fail.txt`

**Interfaces:**
- Consumes: `normalizeConfig`, `BbError`, `checkLibrary`
- Produces: typed root helper `defineConfig`, subpath `checkLibrary`, CLI `bb-check library check [--config path] [--dir path] [--debug]`

- [ ] **Step 1: argument와 config 탐색 실패 테스트를 작성한다**

```ts
it("명시적 library check만 허용한다", () => {
  expect(parseArgs(["library", "check", "--dir", "."])).toMatchObject({
    target: "library",
    action: "check",
    dir: ".",
  });
  expect(() => parseArgs(["check"])).toThrowError(/\[BB_USAGE\]/);
});

it("가장 가까운 package 경계까지만 config를 찾는다", async () => {
  await expect(loadConfig({ cwd: nestedFixtureWithoutConfig }))
    .rejects.toMatchObject({ code: "BB_CONFIG_NOT_FOUND" });
});
```

- [ ] **Step 2: 보고서 golden 실패 테스트를 작성한다**

```ts
it("위반 결과를 안정된 한국어 출력으로 렌더링한다", async () => {
  const rendered = renderLibraryReport(violationResult);
  expect(rendered).toBe(await readGolden("library-fail.txt"));
});
```

- [ ] **Step 3: focused 테스트 실패를 확인한다**

Run: `npm test -- --run packages/bb-check/test/config-loader.test.ts packages/bb-check/test/report.test.ts packages/bb-check/test/cli.test.ts`

Expected: FAIL because facade and CLI modules are missing.

- [ ] **Step 4: config loader와 `defineConfig`를 구현한다**

`defineConfig`는 ESM 설정 작성 시 타입 추론을 보존하는 typed identity다. 보안 검증·조밀 복사·깊은 동결·상대 경로 해석은 config 파일 위치를 알고 있는 loader가 `normalizeConfig`를 호출해 수행한다. Loader는 `--config`가 있으면 그 파일만 import하고, 없으면 cwd부터 가장 가까운 package root까지만 `bb-check.config.mjs`를 찾는다. config URL에 cache-busting query를 붙이지 않는다. `--dir` 우선, config `projectDir` 차선으로 config directory 기준 절대 경로를 만든다.

- [ ] **Step 5: report와 CLI main을 구현한다**

stdout에는 판정 보고서, stderr에는 usage/config/environment 오류를 쓴다. `BbError` code를 `[CODE]`로 시작하고 기본 출력은 stack을 숨긴다. `--debug`에서만 cause stack을 stderr에 추가한다. 예상하지 못한 오류는 `[BB_UNEXPECTED]`와 exit 2다.

- [ ] **Step 6: process exit matrix를 검증한다**

Vitest에서 CLI callable `main(args, io)`를 먼저 검증한다.

- pass result → exit 0
- finding 또는 incomplete → exit 1
- usage/config error → exit 2
- stdout/stderr 분리

Run: `npm test -- --run packages/bb-check/test && npm run typecheck -- --filter=@cp949/bb-check`

Expected: all pass.

- [ ] **Step 7: 승인된 경우에만 facade와 CLI를 commit한다**

```bash
git add packages/bb-check packages/core packages/bb-library
git commit -m "feat: library check CLI와 공개 facade를 추가한다"
```

---

### Task 10: Vite 공개 build와 tarball 격리 소비자

**Files:**
- Create: `packages/bb-check/vite.config.ts`
- Modify: `packages/bb-check/package.json`
- Create: `scripts/check-package-files.mjs`
- Create: `scripts/test-packed-package.mjs`
- Create: `packages/bb-check/test/package-exports.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 9 public entries
- Produces: `packages/bb-check/dist/index.js`, `library.js`, `cli.js`, declaration files, installable npm tarball

- [ ] **Step 1: build artifact 계약 테스트를 작성한다**

```ts
it("공개 entry와 실행 가능한 CLI만 export한다", async () => {
  const manifest = await readJson("packages/bb-check/package.json");
  expect(Object.keys(manifest.exports)).toEqual([".", "./library"]);
  expect(manifest.bin).toEqual({ "bb-check": "./dist/cli.js" });
  expect(manifest.dependencies).not.toHaveProperty("@cp949/bb-core");
  expect(manifest.dependencies).not.toHaveProperty("@cp949/bb-library");
});
```

- [ ] **Step 2: build가 아직 실패함을 확인한다**

Run: `npm run build -- --filter=@cp949/bb-check`

Expected: FAIL because Vite entries/build config are missing.

- [ ] **Step 3: Vite multi-entry build를 구현한다**

```ts
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(packageDir, "src/index.ts"),
        library: resolve(packageDir, "src/library.ts"),
        cli: resolve(packageDir, "src/cli.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [/^node:/, "acorn", "browserslist", "browserslist-to-esbuild", "esbuild", "@mdn/browser-compat-data"],
    },
  },
});
```

Rollup banner로 `cli.js` 첫 줄에 `#!/usr/bin/env node`를 보존한다. declaration은 `tsc --emitDeclarationOnly` 전용 tsconfig로 생성한다.

- [ ] **Step 4: 공개 manifest와 files allowlist를 완성한다**

`packages/bb-check/package.json`에 `type`, `version`, `license`, `engines`, `exports`, `bin`, `files`, `publishConfig.access=public`을 명시한다. internal workspace는 devDependency에만 두고 최종 dependencies에는 runtime external만 둔다.

- [ ] **Step 5: tarball 검사 script를 구현한다**

`check-package-files.mjs`는 `npm pack --dry-run --json` 결과를 읽어 다음만 허용한다.

- `dist/**`
- `README.md`
- `LICENSE`
- `package.json`

manifest에서 `workspace:`, `@cp949/bb-core`, `@cp949/bb-library`, `@cp949/bb-nextjs`가 발견되면 exit 1이다.

- [ ] **Step 6: 임시 소비자 검사를 구현한다**

`test-packed-package.mjs`는 `mkdtemp`로 만든 디렉터리에 실제 tgz를 설치하고 다음을 실행한다.

```bash
node -e 'import("@cp949/bb-check")'
node -e 'import("@cp949/bb-check/library")'
npx bb-check --help
npx bb-check library check --config ./bb-check.config.mjs --dir ./fixture
```

pass fixture는 exit 0, violation fixture는 exit 1이어야 한다. 임시 디렉터리는 성공·실패 모두 `finally`에서 제거한다.

- [ ] **Step 7: build·pack·격리 검증을 실행한다**

Run: `npm run build && npm test -- --run packages/bb-check/test/package-exports.test.ts && node scripts/check-package-files.mjs && node scripts/test-packed-package.mjs`

Expected: all exit 0; tgz manifest contains no workspace dependency; CLI shebang and executable mode valid.

- [ ] **Step 8: 승인된 경우에만 distribution을 commit한다**

```bash
git add packages/bb-check package.json package-lock.json scripts/check-package-files.mjs scripts/test-packed-package.mjs
git commit -m "feat: 단일 npm tarball 배포 경계를 고정한다"
```

---

### Task 11: demo, 공개 정보 gate, CI, 문서, 실제 소비자 검증

**Files:**
- Create: `apps/demo/package.json`
- Create: `apps/demo/tsconfig.json`
- Create: `apps/demo/vite.config.ts`
- Create: `apps/demo/index.html`
- Create: `apps/demo/src/main.ts`
- Create: `apps/demo/scripts/build-fixtures.ts`
- Create: `apps/demo/bb-check.config.mjs`
- Create: `apps/demo/README.md`
- Create: `scripts/check-public-words.mjs`
- Create: `scripts/check-public-words.test.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `package.json`
- Test: `tests/repository-structure.test.ts`

**Interfaces:**
- Consumes: installable `@cp949/bb-check` tarball와 CLI
- Produces: 공개 사용 예시, 보안 문자열 검사, Node/OS CI, 외부 소비 동등성 증거

- [ ] **Step 1: 공개 정보 검사 script의 실패 테스트를 작성한다**

```js
test("추적 파일과 tarball의 금지 pattern을 보고한다", async () => {
  const result = await runScanner({
    roots: [fixtureDir],
    patterns: ["private-product"],
  });
  assert.deepEqual(result.matches, [
    { file: "README.md", line: 2, pattern: "private-product" },
  ]);
});
```

- [ ] **Step 2: script 부재로 실패함을 확인한다**

Run: `node --test scripts/check-public-words.test.mjs`

Expected: FAIL because scanner is missing.

- [ ] **Step 3: binary-safe 공개 정보 scanner를 구현한다**

scanner는 tracked files를 `git ls-files -z`로 받고, tarball은 `npm pack --json` file list를 사용한다. UTF-8 text만 line 단위로 검사하고 binary는 건너뛴 파일 목록으로 보고한다. 실제 pattern은 comma-separated `BB_CHECK_FORBIDDEN_WORDS`에서 받는다. release mode에서 env가 비면 `BB_PUBLIC_WORDS_MISSING`으로 실패한다. 로그에는 pattern 원문 대신 index와 file/line만 출력한다.

- [ ] **Step 4: demo를 workspace 소비자로 구현한다**

demo는 Vite로 호환/비호환 library fixture를 생성하고 README에 다음 재현만 제공한다.

```bash
npm run build --workspace=apps/demo
npm exec --workspace=apps/demo -- bb-check library check --config ./bb-check.config.mjs --dir ./fixtures/compatible
npm exec --workspace=apps/demo -- bb-check library check --config ./bb-check.config.mjs --dir ./fixtures/incompatible
```

첫 명령은 exit 0, 둘째 검사 명령은 exit 1이다. demo는 `private: true`이고 npm tarball에 포함되지 않는다.

- [ ] **Step 5: CI matrix를 작성한다**

`.github/workflows/ci.yml`:

- Ubuntu Node 22: install, format, lint, typecheck, unit/integration test, build, demo, pack, 공개 정보 generic gate
- Ubuntu Node 20: Node 22에서 만든 tarball artifact를 내려받아 packed-package runtime test만 실행
- Windows Node 22: install, dependency closure/path focused tests, CLI process tests
- npm cache key는 `package-lock.json`
- publish와 registry token 사용은 넣지 않음

- [ ] **Step 6: 공개 README를 작성한다**

README에는 문제 정의, 설치, `bb-check.config.mjs`, `library check`, finding 축, exit code, Node 지원, 알려진 범위, 보안 신고 경로를 기록한다. 내부 기원·프로젝트·경로·전용 식별자는 기록하지 않는다.

- [ ] **Step 7: 실제 외부 라이브러리 소비를 임시 복사본에서 검증한다**

실행자는 저장소 밖 환경변수 `BB_CHECK_LIBRARY_CONSUMER`에 검증 대상 절대 경로를 지정한다. script는 원본을 수정하지 않고 OS 임시 디렉터리에 tracked tree를 복사한 뒤 로컬 tgz를 devDependency로 설치하고 build 끝의 검사 command를 `bb-check library check`로 교체한다.

검증 항목:

- 기존 clean build와 새 CLI 모두 통과
- 기존 violation fixture와 새 CLI의 axis/file/name 집합 동등
- 원본 소비자 working tree status 전후 동일
- 임시 복사본 삭제 가능

환경변수가 없으면 이 단계는 미실행으로 명시하며 완료로 보고하지 않는다.

- [ ] **Step 8: 전체 최종 gate를 실행한다**

Run:

```bash
npm clean-install
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run build --workspace=apps/demo
node scripts/check-package-files.mjs
node scripts/test-packed-package.mjs
BB_CHECK_FORBIDDEN_WORDS="${BB_CHECK_FORBIDDEN_WORDS:?required}" node scripts/check-public-words.mjs --release
git diff --check
git status --short
```

Expected: all automated gates exit 0; forbidden match 0; only intended files modified; no tgz or generated `dist` tracked.

- [ ] **Step 9: Node 20과 Windows 제한을 실제로 기록한다**

CI가 사용 가능하면 workflow 결과 URL과 job 이름을 handoff에 기록한다. 로컬 환경만 가능하면 Node 20/Windows를 미검증 human gate로 분리하고 Node 22 현재 OS 결과와 섞어 green으로 보고하지 않는다.

- [ ] **Step 10: 승인된 경우에만 demo·CI·문서를 commit한다**

```bash
git add apps/demo scripts/check-public-words.mjs scripts/check-public-words.test.mjs .github/workflows/ci.yml README.md package.json package-lock.json tests/repository-structure.test.ts
git commit -m "docs: bb-check 소비와 검증 절차를 완성한다"
```

push, tag, npm publish는 실행하지 않는다.
