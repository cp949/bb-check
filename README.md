# bb-check

라이브러리 배포 산출물(dist)이 실제로 선언한 browserslist 기준선에서
동작하는지 정적으로 검사하는 CLI다. 트랜스파일로 해소되지 않는 문법·런타임
API·의존성 문제를 빌드 시점에 잡는다.

## 문제

`package.json#browserslist`로 지원 브라우저를 선언해 두어도, 실제 배포
JavaScript(`dist/**`)가 그 선언을 지키는지는 보통 아무도 자동으로
검사하지 않는다. 트랜스파일러 설정 실수, 최신 런타임 API의 무심결 사용,
번들링 누락으로 남은 외부 참조는 전부 "선언한 지원 범위"와 "실제 동작
범위"를 조용히 벌려 놓는다. `bb-check`는 이 간극을 빌드 산출물 자체를
정적으로 분석해 찾는다 — 실제 브라우저를 띄우지 않는다.

## 설치

```bash
npm install --save-dev @cp949/bb-check
```

Node 22.12 이상이 필요하다(아래 [Node 지원](#node-지원) 참고). 검사
대상 라이브러리 자체가 지원해야 하는 Node/브라우저 버전과는 별개다 —
`bb-check`를 실행하는 환경의 요구사항이다.

## 설정: `bb-check.config.mjs`

프로젝트 루트(또는 `--config`로 지정한 위치)에 둔다.

```js
import { defineConfig } from "@cp949/bb-check";

export default defineConfig({
  library: {
    // 검사 대상 프로젝트 디렉터리. package.json#browserslist와
    // package.json#exports를 여기서 읽는다.
    projectDir: ".",
    // 특정 파일의 특정 런타임 API 사용을 예외로 허용한다. reason은
    // 사람이 읽는 근거이며 검사에는 영향을 주지 않는다.
    allow: [
      {
        file: "dist/index.js",
        name: "structuredClone",
        reason: "feature-detection으로 감싸 호출한다",
      },
    ],
  },
});
```

## `library check`

```bash
npx bb-check library check [--config <path>] [--dir <path>] [--debug]
```

- `--config`: config 파일 경로. 없으면 cwd부터 가장 가까운
  `package.json` 디렉터리까지 `bb-check.config.mjs`를 찾는다.
- `--dir`: 검사 대상 프로젝트 디렉터리. 있으면 config의
  `library.projectDir`보다 우선한다.
- `--debug`: 오류 발생 시 stderr에 원인 체인의 stack trace까지 출력한다.

검사 절차: 대상 `package.json#browserslist`에서 브라우저별 최소 버전
기준선을 만들고, `package.json#exports`에서 실제 배포 진입점(`.js`/
`.mjs`/`.cjs`)을 모은 뒤, 각 진입점을 문법(`syntax`) · 런타임 API
(`runtime-js`) · 의존성(`dependency`) 세 축으로 검사한다. source map이
있으면(외부 파일 또는 inline data URL) 위반 위치를 원본 소스로
되짚는다.

## finding 축

| 축           | 의미                                                          |
| ------------ | ------------------------------------------------------------- |
| `syntax`     | 기준선 esbuild target으로 다시 써야 하는 문법(트랜스파일 누락) |
| `runtime-js` | 기준선 브라우저가 아직/전혀 지원하지 않는 런타임 API 사용      |
| `dependency` | 배포 산출물에 남은, 설치·번들 보장이 안 되는 외부 참조         |

0.1.0에는 `css` 축이 없다(아래 [알려진 범위](#알려진-범위) 참고).

finding의 `name`은 다음 중 하나다.

- 실제 위반: `syntax-divergence`, `dependency-leak`,
  `optional-dependency-leak`, `undeclared-runtime`,
  `computed-specifier`, `unused-allowance`, 또는 실제 런타임 API
  식별자 자체(예: `structuredClone`, `AbortSignal.timeout`).
- 검사 진행 자체의 문제(항상 `incomplete: true`와 함께 나온다):
  `BB_TARGET_PARSE`(어떤 파일·축이 파싱에 실패함),
  `BB_SYNTAX_TARGET_UNAVAILABLE`(기준선의 브라우저 조합에 esbuild가
  표현할 수 있는 문법 target이 없어 `syntax` 축 전체를 건너뜀 — 이때
  `file`은 특정 파일이 아니라 `"*"`다).

## exit code

| exit | 의미                                    |
| ---- | --------------------------------------- |
| `0`  | 통과                                    |
| `1`  | 위반이 있거나(`findings.length > 0`) 검사가 불완전함(`incomplete: true`) |
| `2`  | 사용법/설정/환경 오류                   |

## Node 지원

`@cp949/bb-check` CLI 자체는 Node 22.12 이상에서 실행해야 한다
(`package.json#engines`). 그보다 낮은 Node에서 설치·실행했을 때의
동작은 보증하지 않는다.

## 알려진 범위

- `typeof X === "..."` feature-detection guard는 `typeof` 바로 아래의
  식별자 자체만 예외로 인정하고, 그 분기 **안에서** `X`를 실제로 쓰는
  코드는 그대로 검사한다. 예를 들어
  `if (typeof structuredClone === "function") { return structuredClone(x); }`
  에서도 `structuredClone(x)` 호출은 그대로 finding으로 남는다 — 흔한
  방어적 feature-detection 패턴이 0.1.0에서는 자동으로 면제되지
  않는다. 이런 경우 위 [설정](#설정-bb-checkconfigmjs)의 `allow`
  항목으로 명시적으로 허용해야 한다.
- Next.js 애플리케이션 검사(`@cp949/bb-nextjs`)는 0.1.0에 런타임
  구현이 없다(비공개 skeleton package만 존재). 0.2.0에서 계획 중이다.
- CSS 실행 동작(지원 여부) 검사는 0.1.0 범위 밖이다 — 검사 축은
  `syntax`/`runtime-js`/`dependency` 셋뿐이다.
- 실제 브라우저를 띄워 실행하거나 CSS 지원 여부를 실측하는 검사는
  현재 로드맵 전체에서 범위 밖이다(정적 분석만 한다).
- 일부 오래되었거나 드문 브라우저(`and_qq`, `and_uc`, `baidu`, `bb`,
  `ie_mob`, `kaios`, `op_mini`)는 `@mdn/browser-compat-data`에 대응
  데이터가 없어 `runtime-js` 축에서 그 브라우저만 특정해 검사할 수
  없다. 데스크톱 브라우저와 매핑된 모바일 브라우저 6종(Chrome/
  Firefox/Safari/Samsung Internet/Opera/WebView Android, Safari iOS)은
  전부 검사된다.

## 예제

`apps/demo`가 `bb-check.config.mjs`와 함께 실제로 통과/실패하는 최소
library 산출물 두 개를 만들어 재현하는 방법을 보여준다.

## 보안 신고

취약점을 발견했다면 이 저장소의 GitHub Issues에 등록해 달라.
