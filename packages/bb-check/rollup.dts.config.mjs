// @cp949/bb-check 공개 declaration(.d.ts) build.
//
// `vite.config.ts`(Rolldown 기반)와 별개의, 독립된 classic Rollup 실행이다.
// `vite-plugin-dts`(내부적으로 @microsoft/api-extractor 사용)를 먼저
// 시도했으나, 이 저장소의 TypeScript 6.0.3 + @cp949/bb-library의
// checkLibrary에서 api-extractor가 internal error로 죽고(analyzer가
// bundled TypeScript 5.9.3에 고정돼 있어 6.x를 제대로 못 봄), bb-core만
// inline해도 생성된 클래스 선언에 constructor 구현체가 남아 TS1183으로
// 깨지는 것까지 확인했다(task-10-report.md "Fix 1" 절 참고). `rollup-plugin-dts`
// 는 api-extractor를 전혀 쓰지 않고 TypeScript Compiler API로 직접 rollup
// 하고, peerDependencies가 TypeScript 6.x를 명시적으로 지원한다고 밝혀서
// 이 경로를 대신 쓴다.
//
// `respectExternal`(기본값)은 workspace 밖의 모든 import를 external로
// 남기므로, `includeExternal`로 @cp949/bb-core/@cp949/bb-library만 예외로
// inline한다 — .js와 동일하게 이 두 package만 dist에 번들되고, 5개
// runtime external(acorn 등)은 여전히 bare import로 남는다(그 패키지들은
// 어차피 `dependencies`로 published되므로 타입도 그쪽에서 resolve된다).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { dts } from "rollup-plugin-dts";

// `new URL(...)` global 대신 fileURLToPath + dirname을 쓴다 — 저장소
// eslint globals 설정(.mjs에 process/console만 허용)과 충돌하지 않는다.
const packageDir = dirname(fileURLToPath(import.meta.url));

export default {
  input: {
    index: resolve(packageDir, "src/index.ts"),
    library: resolve(packageDir, "src/library.ts"),
    cli: resolve(packageDir, "src/cli.ts"),
  },
  output: {
    dir: resolve(packageDir, "dist"),
    format: "es",
  },
  plugins: [
    dts({
      tsconfig: resolve(packageDir, "tsconfig.json"),
      includeExternal: ["@cp949/bb-core", "@cp949/bb-library"],
    }),
  ],
};
