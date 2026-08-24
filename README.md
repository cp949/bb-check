# bb-check

`bb-check`는 라이브러리의 배포 JavaScript를 `package.json#browserslist`
기준선과 대조하는 정적 검사기다. `package.json#exports`가 가리키는 빌드
산출물을 문법, 런타임 API, 외부 의존성 세 축으로 검사한다.

실제 브라우저를 실행하는 도구가 아니다. 선언한 지원 범위와 배포 산출물
사이의 불일치를 빌드 이후에 찾는 용도다.

## npm 패키지

설치부터 최소 라이브러리 검사까지의 소비자 문서는
[`@cp949/bb-check` 패키지 README](./packages/bb-check/README.md)에 있다.

```bash
npm install --save-dev @cp949/bb-check
```

CLI는 Node.js 20 이상에서 실행한다.

## 검사 범위

| 축           | 검사 대상                                                     |
| ------------ | ------------------------------------------------------------- |
| `syntax`     | browserslist 기준선에 맞게 다시 변환해야 하는 JavaScript 문법 |
| `runtime-js` | 기준선 브라우저가 지원하지 않는 JavaScript 런타임 API         |
| `dependency` | 배포 산출물에 남은 외부 모듈 참조와 선언 상태                 |

검사는 source map이 있으면 finding 위치를 원본 소스로 역추적한다. CSS 실행
동작과 실제 브라우저 동작은 0.1.0 검사 범위가 아니다. Next.js 애플리케이션
검사는 0.1.0에서 지원하지 않는다.

## 저장소 구조

| 경로                  | 역할                                                |
| --------------------- | --------------------------------------------------- |
| `packages/core`       | 설정, 오류, finding 공통 타입                       |
| `packages/bb-library` | 기준선 산출과 라이브러리 검사 구현                  |
| `packages/bb-check`   | 공개 npm 패키지, CLI, 공개 API                      |
| `apps/demo`           | 호환/비호환 배포 산출물을 만드는 비공개 재현 앱     |
| `scripts`             | 패키지 파일, 격리 설치, 공개 문자열, 배포 절차 검증 |

## 개발

저장소 개발 환경은 Node.js 22.12 이상과 npm 11.19.0을 사용한다.

```bash
npm clean-install
npm run check
npm run test:scripts
npm run check-public-words
```

`npm run check`는 형식, lint, typecheck, build, Vitest, tarball 파일 목록,
packed consumer를 순서대로 검사한다. `npm run test:scripts`는 Node.js 기반
배포 script 테스트를 실행한다. `npm run check-public-words`는 제네릭 모드로
추적 파일과 공개 tarball 파일 수집 경로를 검사한다.

## demo 재현

저장소 루트에서 다음 명령을 실행한다.

```bash
npm run build --workspace=apps/demo
npm exec --workspace=apps/demo -- bb-check library check --config ./bb-check.config.mjs --dir ./fixtures/compatible
npm exec --workspace=apps/demo -- bb-check library check --config ./bb-check.config.mjs --dir ./fixtures/incompatible
```

첫 번째 검사는 exit 0, 두 번째 검사는 finding과 함께 exit 1이어야 한다.
fixture 구성은 [`apps/demo/README.md`](./apps/demo/README.md)에 설명되어 있다.

## 보안

취약점은 공개 Issue 대신
[GitHub의 비공개 보안 취약점 신고 양식](https://github.com/cp949/bb-check/security/advisories/new)으로
신고한다.

## 라이선스

[MIT](./LICENSE)
