# bb-check demo

`@cp949/bb-check`를 실제로 빌드해 쓰는 최소 재현 예제다. 비공개 workspace
패키지이며(`private: true`) npm에 게시되지 않는다.

## fixture

`npm run build`가 [Vite](https://vite.dev/) build API로 두 개의 최소
library 산출물을 만든다(`scripts/build-fixtures.ts`).

- `fixtures/compatible`: 현대 evergreen 브라우저 기준선(chrome/firefox/
  safari/edge 110 이상)만 요구하는 평범한 문법·표준 내장 API.
- `fixtures/incompatible`: `browserslist: ["ie 11"]`처럼 아주 오래된
  기준선에 optional chaining/nullish coalescing 문법과 `structuredClone`
  런타임 API를 함께 써서, `syntax`·`runtime-js` 두 축 모두에서 위반이
  나오게 만든 산출물.

두 fixture 모두 매 빌드마다 새로 생성되는 산출물이라 git에 커밋되지
않는다.

## 재현

저장소 루트에서 순서대로 실행한다.

```bash
npm run build --workspace=apps/demo
npm exec --workspace=apps/demo -- bb-check library check --config ./bb-check.config.mjs --dir ./fixtures/compatible
npm exec --workspace=apps/demo -- bb-check library check --config ./bb-check.config.mjs --dir ./fixtures/incompatible
```

첫 번째 검사 명령은 exit 0(통과), 두 번째 검사 명령은 exit 1(위반)로
끝난다.
