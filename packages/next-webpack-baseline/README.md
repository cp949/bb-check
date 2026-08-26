# @cp949/next-webpack-baseline

Next.js Pages Router의 client Webpack graph가 production Browserslist보다
새로운 JavaScript 문법을 포함하지 않는지 빌드 시점에 검사한다. 정책에 넣은
package는 `transpilePackages` 후보로 제공하고, Webpack plugin은 transpile
결과를 다시 검사한다.

## 지원 범위

- Next.js Pages Router + Webpack production build
- Node.js 20 이상
- `package.json#browserslist.production` 기준 JavaScript 문법 검사
- package 단위 transpile policy와 정확한 package-relative entrypoint waiver

App Router 전용 graph 판정, Turbopack, 브라우저 runtime API, CSS 호환성은
지원하지 않는다. Next.js 16에서는 반드시 `next build --webpack`으로
Webpack build를 선택한다. 이 package는 삭제 완료된 기존 검사기와 의존성 및
제품 계약을 공유하지 않는 별도 제품이며, 그 검사기와의 호환성을 보장하지
않는다.

## 설정

```ts
import {
  createNextWebpackBaseline,
  defineConfig,
} from "@cp949/next-webpack-baseline";
import { fileURLToPath } from "node:url";

const config = defineConfig({
  projectDir: fileURLToPath(new URL(".", import.meta.url)),
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
`transpilePackages` 및 custom `webpack` 함수가 있으면 위 예시처럼 결과를
합성해야 한다. `waivers[].allowedEntrypoints`는 glob이나 prefix가 아니라
package-relative 파일 경로와 정확히 일치할 때만 적용된다. 사용된 waiver는
빌드 warning으로 남는다.

## 오류와 해결

| 오류 코드                      | 의미와 조치                                                           |
| ------------------------------ | --------------------------------------------------------------------- |
| `NWB_CONFIG_INVALID`           | config 형식 오류. package, reason, 중복 항목을 수정한다.              |
| `NWB_BROWSERSLIST_MISSING`     | production Browserslist가 없다. 소비자 `package.json`에 추가한다.     |
| `NWB_BROWSERSLIST_MODERN_ONLY` | 현재 기준선이 검사 가능한 구문보다 새롭다. 지원 범위를 재검토한다.    |
| `NWB_PACKAGE_PATH_UNRESOLVED`  | 모듈을 package-relative 경로로 확정하지 못했다. exports를 확인한다.   |
| `NWB_SYNTAX_UNSUPPORTED`       | transpile 후에도 기준선이 지원하지 않는 문법이다. 변환 설정을 고친다. |
| `NWB_SYNTAX_PARSE_INCOMPLETE`  | parser가 source 전체를 확인하지 못했다. waiver 없이 차단한다.         |
| `NWB_WAIVER_INVALID`           | waiver 경로가 안전한 정확 경로가 아니다. entrypoint를 수정한다.       |
| `NWB_WEBPACK_UNSUPPORTED`      | 필요한 Webpack lifecycle/source 형상이 없다. Webpack 사용을 확인한다. |

`NWB_SYNTAX_PARSE_INCOMPLETE`는 분석 누락 가능성을 뜻하므로 exact waiver가
있어도 통과시키지 않는 fail-closed 오류다.

## 보안

취약점은 공개 Issue 대신
[GitHub의 비공개 보안 취약점 신고 양식](https://github.com/cp949/bb-check/security/advisories/new)으로
신고한다.

## 라이선스

[MIT](./LICENSE)
