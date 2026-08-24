# @cp949/bb-check

라이브러리의 배포 JavaScript를 `package.json#browserslist` 기준선과 대조하는
정적 검사 CLI다. `package.json#exports`가 가리키는 빌드 산출물에서 문법,
런타임 API, 외부 의존성 문제를 찾는다.

CLI 실행에는 Node.js 20 이상이 필요하다. 검사 대상 라이브러리의 Node.js
지원 범위와는 별도 조건이다.

## 최소 사용 예제

아래 예제는 빌드 도구로 esbuild를 사용한다.

```bash
npm install --save-dev @cp949/bb-check esbuild
```

검사 대상 라이브러리의 `package.json`에 실제 배포 진입점과 browserslist를
선언한다.

```json
{
  "name": "bb-check-minimal-example",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": "./dist/index.js",
  "scripts": {
    "build": "esbuild src/index.js --bundle --format=esm --target=chrome80 --outfile=dist/index.js"
  },
  "browserslist": ["Chrome >= 80"]
}
```

`src/index.js`를 만든다.

```js
export const add = (left, right) => left + right;
```

프로젝트 루트에 `bb-check.config.mjs`를 만든다. 처음에는 허용 항목 없이
검사한다.

```js
import { defineConfig } from "@cp949/bb-check";

export default defineConfig({
  library: {
    projectDir: ".",
    allow: [],
  },
});
```

빌드한 다음 검사한다. `bb-check`는 소스가 아니라 `exports`가 가리키는 빌드
산출물을 읽으므로 이 순서를 지켜야 한다.

```bash
npm run build
npx bb-check library check
```

이 예제는 `판정: 통과`를 출력하고 exit 0으로 끝난다.

## 허용 항목

기준선에서 지원하지 않는 런타임 API 사용이 별도 호환 경로로 보호된 경우에만
`library.allow`에 파일, finding 이름, 근거를 기록한다.

```js
import { defineConfig } from "@cp949/bb-check";

export default defineConfig({
  library: {
    projectDir: ".",
    allow: [
      {
        file: "dist/index.js",
        name: "structuredClone",
        reason: "호출 전에 호환 구현으로 교체한다",
      },
    ],
  },
});
```

`file: "*"`는 해당 `name`을 모든 검사 파일에서 허용한다. 허용 항목이 이번
검사에서 한 번도 사용되지 않으면 `unused-allowance` finding이 발생하고
exit 1로 끝난다. 오래된 허용 항목을 통과 조건으로 남겨 두지 않는다.

각 허용 항목의 `file`, `name`, `reason`은 모두 필수이며, 공백을 제거했을
때 비어 있으면 안 되는 문자열이다. 이 조건을 만족하지 않는 항목은
`BB_CONFIG_INVALID` 설정 오류로 거부된다.

## CLI

```bash
npx bb-check library check [--config <path>] [--dir <path>] [--debug]
```

- `--config`: cwd 기준 config 경로. 생략하면 현재 위치부터 가장 가까운
  `package.json` 디렉터리까지 `bb-check.config.mjs`를 찾는다.
- `--dir`: 검사 대상 프로젝트를 덮어쓴다. config 파일 디렉터리 기준 상대
  경로로 해석한다.
- `--debug`: 오류가 발생하면 stderr에 원인 체인의 stack trace도 출력한다.

`library.projectDir`도 config 파일 디렉터리 기준으로 해석한다. 진입점은
`package.json#exports`의 실제 `.js`, `.mjs`, `.cjs` 파일에서만 모으며
`main`과 `module` 필드는 읽지 않는다. `exports`가 없거나 실제 디스크의
JavaScript 진입점을 하나도 가리키지 않으면 `BB_INPUT_NOT_FOUND` 입력
오류로 실패한다. `main`만 선언한 패키지도 이 경우에 해당한다.

## findings

| 축           | finding `name`                                    | 의미                                             |
| ------------ | ------------------------------------------------- | ------------------------------------------------ |
| `syntax`     | `syntax-divergence`                               | 기준선에 맞게 다시 변환해야 하는 문법            |
| `runtime-js` | API 이름, 예: `structuredClone`                   | 기준선 브라우저가 지원하지 않는 런타임 API       |
| `runtime-js` | `unused-allowance`                                | 이번 검사에서 사용되지 않은 허용 항목            |
| `dependency` | 실제 specifier, 예: `react`, `@scope/pkg/subpath` | 배포 산출물에 남은 외부 모듈 참조                |
| `dependency` | 계산식 원문, 예: `chunkName`, `` `./${id}.js` ``  | 정적으로 확정할 수 없는 import/require specifier |

dependency finding의 `name`은 분류명이 아니라 실제 specifier 또는 계산식
원문이다. `detail`은 해당 외부 참조가 `dependencies`에 선언됐지만 번들에
남았는지, `optionalDependencies`에만 있어 설치를 보장할 수 없는지, 어떤
dependency 필드에도 선언되지 않았는지를 구분한다. 계산식이면 정적으로
분류할 수 없다는 사실을 설명한다.

검사를 끝까지 수행할 수 없는 항목은 `BB_TARGET_READ`, `BB_TARGET_PARSE`,
`BB_RUNTIME_BASELINE_UNSUPPORTED`, `BB_SYNTAX_TARGET_UNAVAILABLE` finding으로
보고하고 결과를 `incomplete: true`로 표시한다. source map이 있으면 finding에
원본 파일 경로를 함께 표시한다.

`BB_SYNTAX_TARGET_UNAVAILABLE`은 기준선에서 esbuild 문법 target을 하나도
만들 수 없을 때 `syntax` 축 전체를 건너뛰었다는 뜻이다. 특정 파일의
문제가 아니므로 이 finding의 `file`은 `"*"`다. `runtime-js`와
`dependency` 축은 계속 검사한다.

## exit code

| exit | 의미                                       |
| ---- | ------------------------------------------ |
| `0`  | finding이 없고 검사가 완전함               |
| `1`  | finding이 하나 이상 있거나 검사가 불완전함 |
| `2`  | 사용법, 설정, 입력, 환경 오류              |

## 공개 API

- `@cp949/bb-check`: config 작성용 `defineConfig`와 config 타입
- `@cp949/bb-check/library`: `checkLibrary`, `BbError`, 검사 결과와 finding
  타입

## 0.1.0 제한

- Next.js 애플리케이션 검사는 0.1.0에서 지원하지 않는다.
- CSS 호환성 검사는 지원하지 않는다. 검사 축은 `syntax`, `runtime-js`,
  `dependency` 세 가지다.
- 실제 브라우저를 실행하지 않는다.
- `typeof`로 존재를 확인한 뒤 분기 안에서 호출하는 API는 자동 허용되지
  않는다. 필요한 경우 명시적인 허용 항목을 사용한다.
- `@mdn/browser-compat-data`에 대응 데이터가 없는 브라우저 7종(`and_qq`,
  `and_uc`, `baidu`, `bb`, `ie_mob`, `kaios`, `op_mini`)은 `runtime-js`
  축에서 해당 브라우저를 판정할 수 없으며 불완전 결과로 보고한다. BCD
  이름으로 매핑되는 모바일 브라우저 6종(Chrome Android, Firefox Android,
  Safari iOS, Samsung Internet Android, Opera Android, WebView Android)은
  검사한다.

## 보안 신고

취약점은 공개 Issue 대신
[GitHub의 비공개 보안 취약점 신고 양식](https://github.com/cp949/bb-check/security/advisories/new)으로
신고한다.

소스와 변경 이력은 [GitHub 저장소](https://github.com/cp949/bb-check)에서
확인할 수 있다. 라이선스는 MIT다.
