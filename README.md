# bb-check

Next.js 프로덕션 빌드가 오래된 브라우저에서 실제로 열리는지 확인하는 두 개의
독립 npm 패키지 저장소다.

## 왜 필요한가

빌드가 성공해도 오래된 브라우저에서는 화면이 열리기 전에 JavaScript 문법 오류가
날 수 있다. 애플리케이션 코드뿐 아니라 `node_modules`의 코드에도 최신 문법이 남을
수 있기 때문이다. Webpack 빌드 성공은 "그 브라우저에서 실행된다"를 보장하지
않는다.

이 저장소의 두 패키지는 서로 다른 시점에 이 문제를 찾는다.

| 패키지                         | 하는 일                                                                  | 실행 시점     |
| ------------------------------ | ------------------------------------------------------------------------ | ------------- |
| `@cp949/next-webpack-baseline` | Webpack 빌드 결과에 지원 대상보다 새 JavaScript 문법이 남았는지 검사한다 | 개발·빌드     |
| `@cp949/legacy-browser-smoke`  | 고정된 Chromium 75로 실제 페이지를 열어 로드 실패와 실행 오류를 검사한다 | 빌드 후 smoke |

첫 번째는 정적 검사이고, 두 번째는 실제 구형 브라우저로 하는 최종 확인이다. 하나가
다른 하나를 대신하지 않는다 — 정적 검사를 통과해도 특정 조합에서만 나타나는 런타임
오류는 실제 브라우저 실행으로만 잡힌다.

## 지원 범위

- Next.js **Pages Router** + **Webpack** (App Router, Turbopack은 지원하지 않음)
- Node.js 22 이상

## 설치

```bash
npm install -D @cp949/next-webpack-baseline @cp949/legacy-browser-smoke
```

적용 방법, 설정, 오류 코드는 각 패키지 문서에 있다.

- [`@cp949/next-webpack-baseline`](./packages/next-webpack-baseline/README.md) — Webpack 빌드 검사기
- [`@cp949/legacy-browser-smoke`](./packages/legacy-browser-smoke/README.md) — 고정 Chromium smoke 실행기

## 저장소 구조

| 경로                             | 역할                                           |
| -------------------------------- | ---------------------------------------------- |
| `packages/next-webpack-baseline` | 공개 npm 패키지: Webpack 빌드 검사             |
| `packages/legacy-browser-smoke`  | 공개 npm 패키지: 고정 Chromium 75 smoke 실행기 |
| `apps/next-pages-fixture`        | 실제 Next.js Pages Router 통합 fixture         |
| `scripts`                        | 패키지 파일 검증, packed import, 배포 안전장치 |

## 개발

저장소 개발 환경은 Node.js 22.12 이상과 npm 11.19.0을 사용한다.

```bash
npm clean-install
npm run check
```

패키지별 개별 검사, 릴리스 절차, publish 안전장치는 `package.json`의 `scripts`와
각 패키지 문서를 참고한다. Publish는 기본값이 dry-run이며, 실제 publish는 별도
플래그를 모두 명시해야 실행된다.

## 보안

취약점은 공개 Issue 대신
[GitHub의 비공개 보안 취약점 신고 양식](https://github.com/cp949/bb-check/security/advisories/new)으로
신고한다.

## 라이선스

[MIT](./LICENSE)
