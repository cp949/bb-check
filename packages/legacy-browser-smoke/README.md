# @cp949/legacy-browser-smoke

고정된 Chromium 75(2019년 build)를 실제로 실행해, 최신 문법으로 작성된
production 번들이 legacy 브라우저에서 로드조차 실패하는지 사전에 검증하는
smoke 실행기다. 정적 문법 검사가 아니라 실제 브라우저 실행 결과(로드 성공,
console/page-error, 실패한 요청)를 판정한다.

## 지원 범위

- 고정 Chromium: revision `650583`, `Chromium 75.0.3765.0`
- 실행 플랫폼: 자동 provisioning(관리형 Chromium 다운로드)은 Linux x64
  전용(다른 플랫폼은 `LBS_PLATFORM_UNSUPPORTED`) — `executablePath`를 직접
  지정하면 플랫폼 검사보다 먼저 그 경로를 검증하므로, 실행 파일을 직접
  지정하는 경우에는 다른 플랫폼에서도 동작한다
- Node.js 22 이상(`LBS_NODE_UNSUPPORTED`)
- 소비자가 지정한 loopback origin의 page 여러 개를 순회하며 로드 성공 여부와
  console/page-error/request-failed/http-error/script-parse/script-pending/path-mismatch
  신호를 판정
- package 자신의 `selfTest()` — baseline page 로드와 legacy 구문 거부를
  package 내부 고정 page 두 개로 검증

원격 URL smoke와 브라우저 자동화(클릭·입력 등)는 지원하지 않는다. 인증 상태
준비는 `injectBeforeNavigate` 하나로만 가능하다 — raw CDP session은 노출하지
않는다.

## 고정 브라우저와 checksum

| 항목         | 값                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| revision     | `650583`                                                                                                                                                        |
| version      | `Chromium 75.0.3765.0`                                                                                                                                          |
| platform     | `linux-x64`                                                                                                                                                     |
| archive 크기 | `115826533` bytes                                                                                                                                               |
| SHA-256      | `10ae4e05d9f01a8b646dd2ccc2ac1135e597c472abe5be71552aae7d8a35e2ac`                                                                                              |
| 실행 파일    | `chrome-linux/chrome`                                                                                                                                           |
| archive URL  | `https://storage.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Linux_x64%2F650583%2Fchrome-linux.zip?generation=1555131417316559&alt=media` |

archive URL은 generation 번호가 고정된 GCS object URL이다 — Chromium
snapshot bucket이 해당 revision을 덮어써도 이 URL은 항상 같은 byte
content를 가리킨다. 다운로드 후 SHA-256이 위 값과 일치하지 않으면
`LBS_CHECKSUM_MISMATCH`로 실패하며 그 브라우저를 실행하지 않는다
(fail-closed).

## Chromium cache

관리형 Chromium을 저장할 cache root는 다음 순서로 결정한다.

1. (package 내부 전용) provisioner에 넘긴 명시적 cache 디렉터리 — package
   내부 provisioning 로직에서만 쓰이며, 공개 API(`run`/`selfTest`)는 이
   값을 받는 파라미터를 노출하지 않으므로 소비자가 지정할 수 없다.
2. 절대 경로인 `XDG_CACHE_HOME` — 소비자가 실제로 조정할 수 있는 값
3. `$HOME/.cache`

실제로 파일을 쓰는 경로는 cache root 아래 다음 구조로 고정된다.

```text
<cacheRoot>/@cp949/legacy-browser-smoke/<platform>/<revision>/<sha256>/
  chromium.zip   # 다운로드한 archive(승격 전에는 chromium.zip.part-<token>)
  browser/       # 압축 해제된 최종 실행 트리(chrome-linux/chrome 포함)
  provision.lock # 동시 provisioning을 막는 lock 파일
```

설치된 package 디렉터리 내부(`node_modules/@cp949/legacy-browser-smoke` 등)는
cache 위치로 절대 쓰이지 않는다 — 그런 `cacheDirectory`/`XDG_CACHE_HOME`은
`LBS_CACHE_IO`로 거부된다.

## loopback 제한

`run({ origin })`의 `origin`은 다음을 모두 만족해야 한다. 하나라도 어긋나면
`LBS_ORIGIN_NOT_LOOPBACK`이다.

- scheme이 `http:`
- host가 `127.0.0.1`, `localhost`, `[::1]` 중 하나
- path가 root(`/`)이고 query/hash/userinfo가 없음(port는 자유)

원격 URL을 대상으로 한 smoke는 지원하지 않는다. 소비자는 검사 대상 서버를
loopback으로 미리 띄운 뒤 그 origin을 넘긴다.

## `injectBeforeNavigate`

`run({ origin, injectBeforeNavigate })`의 `injectBeforeNavigate`는 각 page
navigate 전에 CDP `Page.addScriptToEvaluateOnNewDocument`로 등록되어, 그
page가 여는 새 문서마다 실행된다.

- Chromium 75(V8 7.5)가 파싱할 수 있는 구문만 쓸 수 있다.
- origin 제한이 필요하면 스크립트 스스로 `location.origin`을 확인해야 한다 —
  package가 별도로 origin을 강제하지 않는다.
- `selfTest()`에는 적용되지 않는다.
- 빈 문자열이거나 공백만 있으면 `LBS_CONFIG_INVALID`다.

```ts
await smoke.run({
  origin: "http://127.0.0.1:3000",
  injectBeforeNavigate: "localStorage.setItem('token', 'e2e-fixture-token');",
});
```

## `expectedPath`

page 선언에 `expectedPath?: "/..."`를 추가하면, `ready` 조건과 script settle이
끝난 뒤 CDP `Page.getNavigationHistory`로 그 page의 최종 도착 경로를
확인한다. 최종 경로가 `expectedPath`와 다르면 그 page는 `path-mismatch`
신호(text 형식 `expected=<expectedPath>; final=<최종 경로 또는 null>`)로
fail한다.

- 형식 제약은 `path`와 같다 — `/`로 시작하고 `//`·역슬래시·제어 문자를 포함할
  수 없다.
- known-unsupported로 선언할 수 없다 — 리다이렉트나 client-side 이동으로 다른
  경로에 정착하는 것을 "알려진 예외"로 흡수할 수 없다는 뜻이다.
- 비교 대상은 URL로 직렬화된 pathname이다 — 경로에 공백이나 비ASCII 문자가
  있으면 `expectedPath`도 `%20` 등 percent-encoding된 형태로 선언해야
  일치한다.

## no-sandbox 위험

```text
위험도: 높음
롤백: 실행 옵션에서 no-sandbox 허용을 제거하고 sandbox 사용 가능한 환경으로 복귀 가능
```

`sandbox: { mode: "disabled", reason }`는 명시적 opt-in이며 자동으로 켜지지
않는다. 기본은 sandbox 필수(`required`)이고, root(uid 0)에서 sandbox 필수
모드로 실행하면 `LBS_SANDBOX_UNAVAILABLE`로 거부한다. `--no-sandbox`(CLI) /
`sandbox: { mode: "disabled", ... }`(API) 허용은 격리된 CI container처럼
sandbox를 애초에 쓸 수 없는 환경에서만 사용한다. 신뢰할 수 없는 host의
일반 사용자 환경에서 sandbox를 끄지 않는다.

## 인증 경계와 소비자 책임

이 package는 여전히 인증/login/token/storage codec을 소유하지 않는다. 인증
상태 준비는 `injectBeforeNavigate` 하나로만 가능하다 — 소비자가 storage 주입
스크립트 문자열(예: `localStorage`/`sessionStorage`에 토큰을 심는 코드)을
직접 조립해 `run`에 넘기면 package는 그 문자열을 각 page navigate 전에
그대로 등록만 하고, token 형식이나 codec은 해석하지 않는다. 공개 package에는
소비자별 callback이나 이름 분기를 추가하지 않는다.

| 소유 주체 | 책임                                                                                 |
| --------- | ------------------------------------------------------------------------------------ |
| 소비자    | route(`pages`) 목록과 각 `path`/`ready`/`expectedPath` 값                            |
| 소비자    | 앱 전용 `knownUnsupported` 값과 근거(`reason`)                                       |
| 소비자    | 검사 대상 서버의 시작·종료, 그 서버가 이미 인증된 상태로 응답하게 만드는 일          |
| 소비자    | 인증 상태 준비 — storage 주입 스크립트 문자열을 조립해 `injectBeforeNavigate`로 전달 |
| package   | 고정 Chromium 확보·검증, CDP 실행, page 로드 판정, cleanup                           |

## cleanup 보장

- browser process, CDP 세션, 실행마다 만든 임시 user-data 디렉터리는 성공·
  실패 관계없이 정리된다.
- `selfTest()`가 만드는 임시 HTTP server도 성공·실패 모두 닫는다.
- Chromium 다운로드는 `chromium.zip.part-<token>` 파일에 받고, SHA-256이
  일치할 때만 최종 경로로 원자적으로 승격한다 — 중간에 실패한 다운로드가
  cache를 오염시키지 않는다.
- provisioning lock은 소유자(pid/token/startTime이 일치하는 프로세스)만
  해제한다. lock을 쥔 프로세스가 비정상 종료해 stale lock이 남아도
  자동으로 탈취하지 않는다 — `LBS_PROVISION_LOCK_TIMEOUT`으로 실패하며,
  복구하려면 `<cacheRoot>/@cp949/legacy-browser-smoke/.../provision.lock`을
  사람이 직접 지운다.

## 사용법

```ts
import {
  createLegacyBrowserSmoke,
  defineSmokeConfig,
} from "@cp949/legacy-browser-smoke";

const smoke = createLegacyBrowserSmoke(
  defineSmokeConfig({
    pages: [
      {
        name: "home",
        path: "/",
        ready: { kind: "selector", selector: "main" },
      },
    ],
    timeoutMs: 10_000,
    knownUnsupported: [
      {
        kind: "console",
        pattern: "[legacy-smoke] deprecated API",
        count: 1,
        reason: "레거시 polyfill이 의도적으로 남기는 경고",
      },
      {
        kind: "script-parse",
        sourcePath: "/_next/static/chunks/268430f7.496c3f1e31a417f7.js",
        lineNumber: 0,
        columnNumber: 0,
        count: 1,
        reason: "Chrome 75의 AG Grid chunk 문법 미지원",
      },
    ],
  }),
);

// 소비자가 loopback으로 띄운 production 빌드 서버를 검사한다.
const report = await smoke.run({ origin: "http://127.0.0.1:3000" });
if (report.status !== "pass") process.exitCode = 1;

// 고정 Chromium 자체가 legacy 엔진처럼 동작하는지 package가 스스로 확인한다.
const selfTestReport = await smoke.selfTest();
```

`script-parse` 신호의 text 표현은 `path=<sourcePath>; line=<lineNumber>;
column=<columnNumber>` 형식이며, 위 예시의 `sourcePath`/`lineNumber`/
`columnNumber`와 정확히 일치해야 매칭된다.

인라인 `<script>`의 구문 오류는 Chromium 75에서 `page-error`와 `script-parse`
신호를 모두 만들 수 있다 — known-unsupported로 흡수하려면 두 kind를 모두
선언해야 한다. 외부 스크립트 파일의 구문 오류는 `script-parse`만 발생한다.

판정 시점까지 끝나지 않은 Script 요청은 `script-pending` 신호(text 형식
`path=<경로>`)로 남는다. `script-parse`와 달리 다른 텍스트 신호와 같은
방식으로 `pattern`을 선언해 흡수한다(예:
`{ kind: "script-pending", pattern: "path=/vendor/chunk.js", count: 1, reason: "..." }`).

이 대기는 `ready` 조건 대기와 별도의 예산을 받지 않는다 — `timeoutMs`는 page
하나당 하나의 deadline이고, 그 page의 attach(연결)부터 navigate, `ready` 조건
대기, 이 Script settle 대기까지 전체가 그 예산 하나를 공유한다.

### CLI

```bash
npx legacy-browser-smoke-self-test
npx legacy-browser-smoke-self-test --help
npx legacy-browser-smoke-self-test --executable-path /opt/chromium-75/chrome
npx legacy-browser-smoke-self-test --no-sandbox "isolated CI container"
```

인자 없이 실행하면 관리형 Chromium 75를 확보(필요하면 다운로드)해
self-test를 실행하고, `browserVersion`, page별 `checks[].name`/`status`,
전체 `status`를 표준 출력에 남긴다. `status`가 `pass`면 exit 0, 아니면
exit 1이다. `--help`는 브라우저·네트워크·파일시스템을 전혀 건드리지 않고
사용법만 출력한다.

### self-test가 검증하는 것

`selfTest()`는 소비자 config와 무관하게 package 내부 loopback 서버가 제공하는
고정 page 두 개로 다음을 확인한다.

- **baseline**: 평범한 문서가 고정 Chromium에서 깨끗하게 로드되는지
- **legacy-syntax**: optional chaining(`?.`) 같은 최신 문법이 parse
  단계에서 실제로 거부되는지(uncaught `SyntaxError`) — 이 page는 실패해야
  정상이며, page-error로 실패했을 때만 판정을 `pass`로 매긴다

## 오류 코드

| 코드                                          | 의미                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LBS_CONFIG_INVALID`                          | `defineSmokeConfig`/`sandbox`/`injectBeforeNavigate` 옵션 형식 오류                                                                              |
| `LBS_NODE_UNSUPPORTED`                        | Node 22 미만에서 Chromium provisioning 시도                                                                                                      |
| `LBS_PLATFORM_UNSUPPORTED`                    | Linux x64가 아닌 플랫폼                                                                                                                          |
| `LBS_CACHE_IO`                                | cache 경로 계산·생성 실패, 또는 설치된 package 디렉터리를 cache로 지정                                                                           |
| `LBS_PROVISION_LOCK_TIMEOUT`                  | provisioning lock 대기 시간 초과(다른 프로세스가 보유 중이거나 stale)                                                                            |
| `LBS_DOWNLOAD_FAILED`                         | archive 다운로드 실패(비-HTTPS URL 포함)                                                                                                         |
| `LBS_ARCHIVE_UNSAFE` / `LBS_ARCHIVE_INVALID`  | archive 항목이 안전하지 않거나 형식이 예상과 다름                                                                                                |
| `LBS_CHECKSUM_MISMATCH`                       | 다운로드한 archive의 SHA-256이 registry 값과 불일치                                                                                              |
| `LBS_BROWSER_EXECUTABLE_INVALID`              | `executablePath`가 실행 가능한 일반 파일이 아님(symlink 포함 거부)                                                                               |
| `LBS_BROWSER_VERSION_MISMATCH`                | 지정한 실행 파일의 버전이 고정 버전과 다름                                                                                                       |
| `LBS_SANDBOX_UNAVAILABLE`                     | root에서 sandbox 필수 모드로 실행 시도                                                                                                           |
| `LBS_ORIGIN_NOT_LOOPBACK`                     | `run`의 `origin`이 loopback http root가 아님                                                                                                     |
| `LBS_CONNECT_TIMEOUT` / `LBS_COMMAND_TIMEOUT` | CDP 연결 또는 명령 응답 시간 초과                                                                                                                |
| `LBS_PAGE_NOT_READY`                          | page attach부터 script settle 대기까지 공유하는 `timeoutMs` deadline 안에 `ready` 조건이 참이 되지 않음                                          |
| `LBS_ABORTED`                                 | (package 내부 전용) 내부 로직이 자체 `AbortSignal`로 중단시킴 — 공개 API(`run`/`selfTest`)는 소비자가 signal을 넘기는 파라미터를 노출하지 않는다 |

## 보안

취약점은 공개 Issue 대신
[GitHub의 비공개 보안 취약점 신고 양식](https://github.com/cp949/bb-check/security/advisories/new)으로
신고한다.

## 라이선스

[MIT](./LICENSE)
