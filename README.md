# next-webpack-baseline

`@cp949/next-webpack-baseline`은 Next.js Pages Router의 client Webpack
graph를 production Browserslist 기준선과 대조하는 빌드 검사기다. 지원 범위,
설정, 안정된 오류 코드와 해결 흐름은
[`package README`](./packages/next-webpack-baseline/README.md)에 있다.

## 저장소 구조

| 경로                             | 역할                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `packages/next-webpack-baseline` | 공개 npm 패키지와 Webpack 검사 구현                    |
| `apps/next-pages-fixture`        | 실제 Next.js 16 Pages Router 통합 fixture              |
| `scripts`                        | 패키지 파일, packed import, 공개 문자열, 배포 안전장치 |

## 개발

저장소 개발 환경은 Node.js 22.12 이상과 npm 11.19.0을 사용한다.

```bash
npm clean-install
npm run format:check:next
npm test --workspace=@cp949/next-webpack-baseline
npm run build --workspace=@cp949/next-webpack-baseline
npm run test-packed-package -- --package @cp949/next-webpack-baseline
npm run test:scripts:next
npm run check-public-words
```

Next.js 16 통합 fixture는 Webpack을 명시해 실행한다.

```bash
npm run build --workspace=next-pages-fixture -- --webpack
```

## 릴리스 안전장치

package 이름을 반드시 명시하며 기본 동작은 dry-run이다.

```bash
npm run publish:npm -- --package @cp949/next-webpack-baseline
```

실제 publish는 `--publish --confirm-publish`를 모두 명시하고, 호출자가
`BB_CHECK_FORBIDDEN_WORDS` CSV를 주입해야 한다. wrapper는 generic release
gate와 `check-public-words -- --release`를 모두 통과한 뒤에만 publish를
호출한다. package directory에서 직접 실행한 실제 `npm publish`는 lifecycle
guard가 차단하며, direct `npm publish --dry-run`은 허용한다. 금지어와 금지어가
포함된 파일 경로는 로그에 출력하지 않는다. CI는 publish, registry credential,
secret release scan을 실행하지 않는다.

Codiny pilot과 두 번째 소비자 pilot은 이 저장소 변경과 분리된 human gate다.
두 번째 소비자 경로와 release 금지어 목록이 제공되기 전에는 실행하지 않는다.

## 보안

취약점은 공개 Issue 대신
[GitHub의 비공개 보안 취약점 신고 양식](https://github.com/cp949/bb-check/security/advisories/new)으로
신고한다.

## 라이선스

[MIT](./LICENSE)
