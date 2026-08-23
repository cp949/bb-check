# `@cp949/bb-check` 설계

- 작성일: 2026-08-24
- 상태: 사용자 승인 설계
- 초기 릴리스 후보: `0.1.0`

## 1. 목적

`@cp949/bb-check`는 프로젝트가 선언한 최소 브라우저 버전에서 배포 산출물이 동작할 수 있는지 검사하는 npm CLI다. 완전한 범용성을 약속하지 않는다. 라이브러리와 Next.js 애플리케이션이라는 두 실제 사용 방식을 독립 모듈로 수용하고, 검증된 범위부터 일반화한다.

첫 마일스톤은 라이브러리 산출물 검사를 제공한다. Next.js 애플리케이션 검사는 검증된 구현을 이관할 수 있을 때 두 번째 마일스톤으로 추가한다.

## 2. 보안과 공개 정보

이 저장소는 공개를 전제로 한다. 다음 정보는 소스, 설정, fixture, 테스트 제목, 골든 출력, 문서, 예제, 변경 기록에 남기지 않는다.

- 회사명과 내부 제품·프로젝트·저장소 명칭
- 내부 파일시스템 경로와 비공개 URL
- 특정 조직만 사용하는 환경변수명, 패키지명, 페이지명
- 비공개 구현에서 가져온 것으로 식별할 수 있는 주석과 출력

Next.js 쪽 설명에는 `Next.js application`, `consumer application`, `sample application` 같은 일반 용어만 사용한다. 공개 전에는 저장소 전체와 npm tarball을 금지 문자열 목록으로 검사한다.

## 3. 범위

### 3.1 `0.1.0`에 포함

- npm 11 workspaces와 Turborepo 기반 모노레포
- TypeScript 소스, Vite ESM 빌드, Vitest 테스트
- `packages/core`: 공유 계약과 순수 모델
- `packages/bb-library`: 라이브러리 산출물 검사
- `packages/bb-check`: 공개 facade와 CLI
- `packages/bb-nextjs`: 비공개 workspace 골격만 제공하고 실행 가능한 가짜 구현은 제공하지 않음
- `apps/demo`: 비공개 Vite 소비자 애플리케이션
- CLI 설정 탐색, 안정적인 오류 코드, 구조화된 결과, 한국어 기본 출력
- npm tarball과 격리 소비자 검증

### 3.2 `0.1.0`에서 제외

- Next.js webpack 검사, policy, waiver, runtime smoke
- CSS 실행 판정과 실제 브라우저 자동 조달
- ESLint 어댑터
- Turbopack과 Next.js App Router 전용 어댑터
- 기준선 CLI override
- publish, tag, push

### 3.3 후속 `0.2.0`

`packages/bb-nextjs`에 Next.js 애플리케이션 검사를 추가하고 `packages/bb-check`에 해당 facade와 CLI 명령을 연결한다. 구현 전에는 외부 interface를 미리 공개하지 않는다.

## 4. 실행 환경과 도구 버전

- 개발·CI 기준: Node `>=22.12`
- 공개 패키지의 기본 CLI: Node `>=20`
- 후속 runtime smoke 명령: Node `>=22`; 낮은 버전에서는 부작용 전에 명시적 오류
- package manager: npm `11.19.0`
- Vite `8.2.2`
- Vitest `4.1.11`
- Turborepo `2.10.11`
- TypeScript `7.0.2`

버전은 2026-08-24 npm registry의 해당 major 또는 `latest` dist-tag를 기준으로 한다. npm은 사용자가 지정한 major 11 안의 최신 버전을 사용한다. `package-lock.json`을 추적해 재현성을 고정한다.

## 5. 저장소 구조

```text
.
├── apps/
│   └── demo/
├── packages/
│   ├── core/
│   ├── bb-library/
│   ├── bb-nextjs/
│   └── bb-check/
├── docs/
│   └── superpowers/specs/
├── package.json
├── package-lock.json
├── tsconfig.json
└── turbo.json
```

의존 방향은 단방향이다.

```text
bb-check ─┬→ bb-library ─→ core
          └→ bb-nextjs  ─→ core   # 0.2.0부터
```

- `core`, `bb-library`, `bb-nextjs`는 `private: true`인 내부 workspace 패키지다.
- `bb-check`만 `@cp949/bb-check`라는 이름으로 공개한다.
- `bb-check`의 Vite 빌드는 내부 workspace 코드를 최종 `dist`에 포함한다.
- npm tarball의 manifest에는 내부 workspace 패키지가 runtime dependency로 남지 않는다.
- 외부 라이브러리는 번들 여부를 명시적으로 분류하고 tarball 격리 검사로 누락을 막는다.

## 6. 모듈과 seam

### 6.1 `packages/core`

공유 의미만 소유한다.

- 정규화된 브라우저 기준선
- `Finding`, `CheckResult`, 판정 축
- 오류 코드와 오류 분류
- 설정 복사·검증·동결
- 안정 정렬 규칙

파일 수집, CLI 파싱, 파일시스템 탐색, 출력 문자열은 소유하지 않는다. 두 프로젝트 방식에서 실제로 공유하는 의미만 둔다.

### 6.2 `packages/bb-library`

라이브러리 검사 전체를 작은 interface 뒤에 숨기는 깊은 모듈이다.

```ts
export interface CheckLibraryOptions {
  projectDir: string;
  allow?: readonly LibraryAllowance[];
}

export function checkLibrary(
  options: CheckLibraryOptions,
): Promise<CheckResult>;
```

구현 책임:

1. 대상 `package.json`과 `browserslist` 읽기
2. `package.json#exports`에서 배포 JavaScript 진입점 파생
3. 문법 기준선 검사
4. 런타임 API 호환성 검사
5. 배포 산출물의 dependency closure 검사
6. 소스맵을 통한 원본 위치 귀속
7. 예외 적용과 사용되지 않은 예외 탐지
8. 모든 finding을 구조화된 결과로 반환

수집기와 판정기는 내부 seam으로 유지한다. 외부 interface에는 개별 scanner를 노출하지 않는다.

### 6.3 `packages/bb-nextjs`

`0.1.0`에서는 private manifest, TypeScript 설정, 범위 문서만 둔다. 공개 export, 성공하는 stub, 항상 실패하는 stub을 만들지 않는다. 후속 구현이 들어올 때 webpack과 runtime이라는 실제 두 adapter를 근거로 내부 seam을 확정한다.

### 6.4 `packages/bb-check`

공개 facade와 프로세스 책임을 소유한다.

- CLI argument 파싱
- 설정 파일 탐색과 로드
- 대상별 내부 모듈 라우팅
- `CheckResult`의 한국어 보고서 렌더링
- exit code 결정
- 공개 JavaScript subpath export

판정 로직을 중복 구현하지 않는다.

### 6.5 `apps/demo`

Vite 기반 private 소비자 애플리케이션이다.

- workspace 설치와 CLI 사용 예시 제공
- 호환/비호환 샘플 산출물 재현
- 후속 runtime smoke의 범용 샘플 대상으로 확장 가능
- 자동 테스트의 정본으로 사용하지 않음
- 공개 tarball에 포함하지 않음

## 7. 공개 interface

`0.1.0`의 package export는 다음으로 제한한다.

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./library": "./dist/library.js"
  },
  "bin": {
    "bb-check": "./dist/cli.js"
  }
}
```

- `@cp949/bb-check`: `defineConfig(config)`와 공개 설정 타입
- `@cp949/bb-check/library`: `checkLibrary(options)`와 결과 타입
- `formatReport()`와 내부 scanner는 공개하지 않음
- `./nextjs`는 실제 기능이 준비되는 `0.2.0`에서 추가

CLI 형태:

```bash
bb-check library check --dir .
bb-check library check --config ./bb-check.config.mjs --dir .

# 0.2.0 목표
bb-check nextjs check
bb-check nextjs audit
bb-check nextjs smoke
```

프로젝트 종류를 자동 감지하지 않는다. 명시적인 하위 명령으로 잘못된 검사기 선택을 방지한다.

## 8. 설정

설정 정본은 `bb-check.config.mjs` 하나다.

```js
import { defineConfig } from "@cp949/bb-check";

export default defineConfig({
  library: {
    projectDir: ".",
    allow: [],
  },
});
```

규칙:

- 브라우저 버전의 정본은 대상 `package.json#browserslist`다.
- 설정에는 예외, 검사 방식, 후속 runtime 대상처럼 도구 동작만 둔다.
- CLI는 cwd에서 가장 가까운 `package.json` 디렉터리까지만 `bb-check.config.mjs`를 탐색한다.
- `--config <path>`는 자동 탐색을 생략한다.
- 대상 위치는 `--dir`이 있으면 그 값을, 없으면 `library.projectDir`을 사용한다. 두 경로 모두 config 파일이 있는 디렉터리를 기준으로 절대 경로로 정규화한다.
- `--dir`은 매 실행마다 달라질 수 있는 대상 위치만 재정의한다. 브라우저 기준선을 중복 정의하지 않는다.
- `BROWSERSLIST` 같은 환경변수로 기준선을 바꾸는 실행은 거절한다.
- config 객체는 own property를 조밀하게 복사해 검증한 뒤 깊게 동결한다. sparse array, getter, 상속 property, 중복 항목을 신뢰하지 않는다.
- 과거 `package.json` 안에 있던 도구 전용 예외 설정은 새 파일로 한 번 이관한다. 호환 계층은 만들지 않는다.

## 9. 처리 흐름

```text
CLI
  → 명령·옵션 파싱
  → 설정 탐색·로드·검증
  → library 설정 정규화
  → bb-library.checkLibrary()
      → package exports 기반 산출물 수집
      → syntax / runtime-js / dependency 판정
      → source map 귀속
      → 예외 적용
      → CheckResult
  → 안정 정렬
  → 한국어 보고서 렌더링
  → exit code
```

각 파일을 읽거나 파싱하지 못한 경우 안전하게 계속할 수 있는 나머지 파일은 검사한다. 실패 대상을 결과에 반드시 포함해 불완전한 검사가 성공으로 보이지 않게 한다.

## 10. finding과 오류

판정 축:

- `syntax`
- `runtime-js`
- `dependency`
- 후속 `css`

exit code:

- `0`: 검사 완료, 위반 없음
- `1`: 기준선 위반 또는 일부 대상을 판정하지 못해 결과가 불완전함
- `2`: 잘못된 CLI 사용, 설정 누락·오류, 지원하지 않는 실행 환경

초기 안정 오류 코드:

- `BB_USAGE`
- `BB_CONFIG_NOT_FOUND`
- `BB_CONFIG_INVALID`
- `BB_BASELINE_EMPTY`
- `BB_INPUT_NOT_FOUND`
- `BB_TARGET_READ`
- `BB_TARGET_PARSE`
- `BB_UNEXPECTED`

출력 규칙:

- 기본 출력은 한국어
- `axis → file → line → name` 순으로 안정 정렬
- 같은 원인의 finding은 요약할 수 있으나 원래 개수를 함께 표시
- 기본 출력에는 stack trace를 넣지 않음
- `--debug`에서 cause와 stack trace 출력
- 출력 골든은 줄바꿈까지 바이트 단위로 검사
- Windows 경로는 보고서에서 `/`로 정규화하되 실제 오류 대상은 손실하지 않음

## 11. 빌드와 배포물

- 소스는 TypeScript ESM이다.
- Vite library build에 `index`, `library`, `cli`를 명시적인 진입점으로 둔다.
- CLI 진입점의 shebang을 보존한다.
- 내부 workspace 패키지는 번들한다.
- Node builtin은 external로 유지한다.
- 큰 호환성 데이터와 실행 시 필요한 제3자 패키지는 설치 크기, 갱신 책임, 동적 접근 여부를 측정한 뒤 bundle/external을 결정한다.
- declaration을 생성하고 export map의 JavaScript와 type 경로를 함께 검증한다.
- `files` allowlist로 `dist`, README, LICENSE, package metadata만 공개한다.
- `npm pack --dry-run --json`과 실제 tarball 격리 설치를 모두 검사한다.

## 12. 테스트 전략

Vitest가 공통 테스트 러너다. 테스트는 내부 함수보다 모듈 interface와 CLI 결과를 우선 검증한다.

### `core`

- 설정 검증·복사·동결
- baseline 정규화
- finding 정렬
- 오류 코드와 exit 분류
- sparse array, getter, prototype pollution 성격의 입력

### `bb-library`

- 지원/미지원 문법
- browserslist 기준선 차이
- 런타임 API tier와 scope shadowing
- `typeof` guard와 명시적 예외
- 사용되지 않은 예외
- `package.json#exports`의 조건부·배열·중첩 대상
- builtin, self, peer, dependency, optional dependency, 미선언 import
- 정적·동적 import와 계산된 specifier
- POSIX와 Windows 상대·절대·drive-relative·UNC 경로
- LF, CRLF, CR, U+2028, U+2029 줄 구분
- source map 원본 귀속과 malformed map

### `bb-check`

- 빌드된 CLI를 자식 프로세스로 실행
- cwd 기반 설정 탐색과 `--config`
- 성공, 위반, 불완전 판정, 사용법 오류 exit code
- 기본 출력 골든과 `--debug`
- 환경변수에 의한 기준선 override 거절
- 공개 root/subpath import

### 저장소·배포 검증

- lint, format check, typecheck
- Vitest 전체 테스트
- Turbo 전체 build
- demo build
- tarball 파일 allowlist
- 임시 디렉터리 tarball 설치 후 root import, library import, `bb-check --help`, 성공·실패 fixture 실행
- 공개 파일 금지 문자열 검사
- 추적된 정적 fixture만 테스트 정본으로 사용

CI matrix:

- Ubuntu: Node 20과 Node 22
- Windows: Node 22
- 개발 도구 전체 build는 Vite 요구사항을 만족하는 Node 22에서 실행
- Node 20 job은 공개 tarball의 기본 CLI runtime 계약을 검증

## 13. 구현 순서와 완료 기준

### M0 — 골격과 도구 체인, 0.5~1일

- npm workspaces, Turbo, TypeScript, Vite, Vitest
- 공통 tsconfig, format, lint, build, test, check scripts
- 네 package 디렉터리와 demo

### M1 — `core`, 1일

- 결과·오류·설정 계약
- config 검증과 동결
- 안정 정렬

### M2 — 라이브러리 검사, 2~3일

- 기존 행위 fixture를 실패 테스트로 먼저 이관
- exports 수집, syntax, runtime API, dependency closure, source map 구현
- 예외와 미사용 예외 검사

### M3 — facade와 CLI, 1~2일

- config 탐색
- `library check`
- 보고서와 exit code
- 공개 export와 declaration

### M4 — 소비자·배포 검증, 1~2일

- demo
- npm pack allowlist와 격리 소비자
- Node/OS CI
- 공개 README와 보안 문자열 검사

`0.1.0` 후보까지 총 5.5~9 개발일 규모다.

완료 조건:

- `npm install`, 전체 build, test, lint, format check, typecheck 통과
- `bb-check library check --dir <fixture>`의 성공·위반·오류 계약 통과
- 실제 외부 라이브러리 프로젝트가 로컬 tarball을 소비해 기존 게이트와 동등한 판정 생성
- tarball에 허용된 공개 파일만 포함
- Node 20/22와 Windows 경로 계약 검증
- 공개 파일 보안 검사 0건
- publish, tag, push를 수행하지 않음

## 14. 위험과 대응

### 내부 workspace 번들 누락

위험: 공개 manifest에 설치할 수 없는 workspace dependency가 남을 수 있다.

대응: Vite 번들 결과, tarball manifest, 빈 임시 프로젝트 설치를 함께 검증한다.

### JavaScript 변환에 따른 판정 변화

위험: TypeScript/Vite 이관 과정에서 기존 검사기의 관찰 결과나 위치가 달라질 수 있다.

대응: 기존 fixture를 먼저 이관하고, 구조화된 finding과 CLI 골든을 고정한 뒤 구현을 옮긴다.

### Node 20과 개발 도구 요구사항 차이

위험: Vite 8의 개발 요구사항과 공개 CLI runtime 지원을 혼동할 수 있다.

대응: 빌드는 Node 22에서 수행하고, 생성된 tarball의 CLI만 별도 Node 20 job에서 검증한다.

### 비공개 정보 노출

위험: 이관한 fixture, 출력, 경로, 환경변수에 내부 식별자가 남을 수 있다.

대응: 자료를 의미 보존형 일반 fixture로 다시 작성하고, repository와 tarball 모두 금지 문자열 검사를 release gate로 둔다.

### Next.js package의 성급한 interface 고정

위험: 구현 전에 public export나 adapter interface를 만들면 잘못된 계약을 호환해야 한다.

대응: `0.1.0`에서는 private 골격만 두고 실제 이관과 함께 interface를 설계·공개한다.

## 15. 배포 권한

이 설계는 로컬 구현과 검증만 승인한다. commit, push, tag, npm publish는 각각 별도 사용자 지시가 필요하다.
