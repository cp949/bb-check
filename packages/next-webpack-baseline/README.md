# @cp949/next-webpack-baseline

Next.js Pages Router의 client Webpack graph를 production Browserslist 기준으로 검사한다.
정책에 등록한 package는 `transpilePackages` 후보로 제공하고 변환 결과를 검증한다.
production에서는 정책에 없는 package도 관찰해 warning/error, policy 제안, JSON report를
만든다.

## 지원 범위

- Next.js Pages Router + Webpack production build
- Node.js 20 이상
- `package.json#browserslist.production` 기준 JavaScript 문법 검사
- package 단위 transpile policy와 정확한 package-relative entrypoint waiver
- production client graph의 미등록 package syntax 관찰

App Router 전용 graph 판정, Turbopack, 브라우저 runtime API, CSS 호환성은 지원하지
않는다. Next.js 16에서는 반드시 `next build --webpack`으로 Webpack build를 선택한다.
top-level await는 Webpack이 async module로 lowering하므로 module source 단계 판정에서
의도적으로 제외한다. 필요하면 최종 chunk 단계 검증을 별도로 설계해야 한다.

## 설정

```ts
import {
  createNextWebpackBaseline,
  defineConfig,
} from "@cp949/next-webpack-baseline";
import { fileURLToPath } from "node:url";

const config = defineConfig({
  projectDir: fileURLToPath(new URL(".", import.meta.url)),
  unlistedPackages: "warn",
  policy: [
    {
      package: "legacy-widget",
      reason: "production baseline까지 transpile 필요",
    },
  ],
  waivers: [
    {
      package: "legacy-widget",
      reason: "검토된 배포 entrypoint",
      allowedEntrypoints: ["dist/compat.js"],
    },
  ],
});
const baseline = createNextWebpackBaseline(config);

const nextConfig = {
  transpilePackages: ["existing-package", ...baseline.transpilePackages],
  webpack(webpackConfig, context) {
    webpackConfig.plugins.push(baseline.webpackPlugin({ dev: context.dev }));
    return webpackConfig;
  },
};

export default nextConfig;
```

`policy`는 검사 대상 package와 transpile 이유를 명시한다. 기존
`transpilePackages`와 custom `webpack` 함수가 있으면 위 예시처럼 결과를 합성한다.

`unlistedPackages`는 production 미등록 package scan의 severity다.

| 값       | 동작                                                   |
| -------- | ------------------------------------------------------ |
| `warn`   | 기본값. package별 warning과 summary를 남기고 통과한다. |
| `error`  | 같은 report를 기록한 뒤 compilation error로 차단한다.  |
| `ignore` | 미등록 package를 분석하지 않고 이전 report를 삭제한다. |

development에서는 값과 무관하게 미등록 package를 분석하지 않으며 report를 읽거나 쓰거나
삭제하지 않는다. 등록 package 검증은 기존 계약을 유지한다.

`waivers[].allowedEntrypoints`는 glob이나 prefix가 아니라 package-relative 파일 경로와
정확히 일치할 때만 적용된다. production 미등록 scan에도 같은 exact waiver가 적용되며,
사용된 waiver는 `NextWebpackBaselineWaiverWarning`으로 남고 신규 집계와 policy 제안에서
제외된다. parse-incomplete와 source-unavailable은 waiver할 수 없다. development에서는
미등록 package를 분석하지 않으므로 그 waiver도 적용하거나 사용 여부를 감시하지 않는다.

## 미등록 package 도입 절차

1. 빈 `policy`와 기본 `warn`으로 production build를 실행한다.
2. `.next/diagnostics/baseline-unlisted.json`의 모든 package와 분석 불가 항목을 검토한다.
3. 각 항목을 policy 등록, exact waiver, 원인 수정 중 하나로 처리한다.
4. 자동 생성된 `reason`의 측정 수치에 전이 의존성, 초기 chunk, 제품 맥락을 사람이 보강한다.
5. 재build에서 미등록 diagnostics와 분석 불가가 모두 0인지 확인한다.
6. 분석 불가 0건을 확인한 뒤 CI의 `unlistedPackages: "error"` 승격을 검토한다.

config는 자동 수정하지 않는다. report의 수치는 package version과 bundle 구성의 snapshot이며
버전 사이에서 동일해야 하는 안정 계약이 아니다.

## JSON report

경로는 `<projectDir>/.next/diagnostics/baseline-unlisted.json`이다. UTF-8, 2칸 들여쓰기,
마지막 newline으로 기록한다.

```json
{
  "schemaVersion": 1,
  "mode": "warn",
  "packages": [
    {
      "package": "unlisted-widget",
      "diagnostics": [
        { "feature": "logical-assignment-operators", "count": 4 }
      ],
      "suggestedReason": "논리 할당 연산자 4건"
    }
  ],
  "unanalyzable": [
    {
      "package": "example",
      "entrypoint": "dist/index.js",
      "cause": "NWB_SYNTAX_PARSE_INCOMPLETE"
    }
  ]
}
```

`packages`는 package명, `unanalyzable`은 package → entrypoint → cause 순으로 정렬한다.
절대 경로는 기록하지 않는다. diagnostics와 `suggestedReason`, 콘솔 표시는 다음 canonical
feature 순서를 공유한다.

1. `optional-chaining` — `?.`
2. `nullish-coalescing` — `??`
3. `class-properties` — `클래스 필드`
4. `private-methods` — `#메서드`
5. `logical-assignment-operators` — `논리 할당 연산자`
6. `numeric-separator` — `숫자 구분자`
7. `async-generator-functions` — `async generator`
8. `object-rest-spread` — `object rest/spread`

`schemaVersion`은 feature enum과 JSON shape의 기계 소비 계약이다. `.next`는 다음 실행이
덮을 수 있으므로 CI에서 보존하려면 build 직후 별도 artifact로 복사한다.

## report lifecycle

| 실행                | 분석  | 파일 동작                                     |
| ------------------- | ----- | --------------------------------------------- |
| production `warn`   | 실행  | 발견 0건이어도 `mode: "warn"` JSON 작성       |
| production `error`  | 실행  | JSON을 먼저 작성하고 발견이 있으면 build 차단 |
| production `ignore` | 안 함 | reporter가 소유한 report 파일 한 개만 삭제    |
| development         | 안 함 | 파일 read/write/delete 전체 no-op             |

report는 같은 디렉터리의 temp 파일을 완전히 쓴 뒤 rename한다. Windows에서 기존 target 때문에
`EPERM`/`EEXIST`가 발생하면 target을 삭제하고 rename을 한 번 재시도한다. 이 fallback에는
delete와 rename 사이의 짧은 비원자 구간이 있다.

## 오류와 해결

| 오류 코드                      | 의미와 조치                                                           |
| ------------------------------ | --------------------------------------------------------------------- |
| `NWB_CONFIG_INVALID`           | config 형식 또는 mode 오류. package, reason, enum을 수정한다.         |
| `NWB_BROWSERSLIST_MISSING`     | production Browserslist가 없다. 소비자 `package.json`에 추가한다.     |
| `NWB_BROWSERSLIST_MODERN_ONLY` | 현재 기준선이 검사 가능한 구문보다 새롭다. 지원 범위를 재검토한다.    |
| `NWB_PACKAGE_PATH_UNRESOLVED`  | 모듈을 package-relative 경로로 확정하지 못했다. exports를 확인한다.   |
| `NWB_SYNTAX_UNSUPPORTED`       | 등록 package 변환 후에도 기준선보다 새 문법이다. 변환 설정을 고친다.  |
| `NWB_SYNTAX_PARSE_INCOMPLETE`  | parser가 source 전체를 확인하지 못했다. waiver 없이 처리한다.         |
| `NWB_WAIVER_INVALID`           | waiver 경로가 안전한 정확 경로가 아니다. entrypoint를 수정한다.       |
| `NWB_WEBPACK_UNSUPPORTED`      | 필요한 Webpack lifecycle/source 형상이 없다. Webpack 사용을 확인한다. |
| `NWB_REPORT_IO_FAILED`         | 미등록 report 작성/삭제 실패. `.next` 권한과 파일 점유를 확인한다.    |

등록 package의 `NWB_SYNTAX_PARSE_INCOMPLETE`와 `NWB_WEBPACK_UNSUPPORTED`는 항상 error다.
미등록 package의 분석 불가는 `warn`에서는 비차단 warning, `error`에서만 error다.

## 보안

취약점은 공개 Issue 대신
[GitHub의 비공개 보안 취약점 신고 양식](https://github.com/cp949/bb-check/security/advisories/new)으로
신고한다.

## 라이선스

[MIT](./LICENSE)
