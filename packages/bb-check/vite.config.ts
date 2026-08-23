// @cp949/bb-check 공개 build 설정.
//
// 목적: 이 패키지만 공개(npm publish)되므로, private workspace
// package(@cp949/bb-core, @cp949/bb-library)를 dist에 번들로 inline하고
// runtime external 5종(acorn, browserslist, browserslist-to-esbuild,
// esbuild, @mdn/browser-compat-data)과 Node 내장 모듈은 절대 번들에
// 포함하지 않는다 — 이 패키지만 설치한 소비자에게 resolve 안 되는
// 의존성이 하나도 남지 않아야 한다.
//
// declaration(.d.ts)은 이 빌드가 아니라 별도의 classic Rollup invocation
// (rollup.dts.config.mjs, package.json build script에서 `vite build` 다음에
// 실행)이 생성한다 — Vite/Rolldown은 .js 산출물만 책임진다.
//
// 처음에는 `vite-plugin-dts`(bundleTypes.bundledPackages로 이 빌드 안에서
// .d.ts도 함께 rollup)를 시도했으나, 이 저장소의 TypeScript 6.0.3 +
// @cp949/bb-library의 checkLibrary(비동기 함수, 구조분해 매개변수)에서
// 내부적으로 쓰는 @microsoft/api-extractor@7.59.0이 internal error로
// 죽었다(Unable to determine semantic information for declaration,
// check-library.ts:204:9). bb-core만 inline해도 생성된 BbError 클래스
// 선언에 constructor 본문이 그대로 남아 TS1183(ambient context에 구현체
// 불가)으로 깨지는 것까지 확인했다 — api-extractor를 전혀 쓰지 않는
// `rollup-plugin-dts`(TypeScript Compiler API로 직접 rollup, TS 6.x를
// peerDependencies에서 명시적으로 지원)로 바꿔 해결했다. 재현 절차와
// 정확한 오류는 task-10-report.md의 "Fix 1" 절 참고.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    target: "node22",
    lib: {
      entry: {
        index: resolve(packageDir, "src/index.ts"),
        library: resolve(packageDir, "src/library.ts"),
        cli: resolve(packageDir, "src/cli.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: [
        /^node:/,
        "acorn",
        "browserslist",
        "browserslist-to-esbuild",
        "esbuild",
        "@mdn/browser-compat-data",
      ],
    },
  },
});
