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
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

// vite build(Rolldown)는 dist/cli.js를 shebang까지 그대로 써주지만 실행
// 권한(+x)은 주지 않는다 — 매번 새로 만드는 일반 파일이라 기본 umask
// 권한(보통 644)으로 끝난다. `npm pack`/`npm install`로 실제 배포되는
// 경로에서는 npm이 package.json#bin 항목을 설치 시점에 항상 chmod하므로
// 이 문제가 드러나지 않는다(test-packed-package.mjs가 검증하는 경로).
// 하지만 이 workspace 안에서 다른 package가 `@cp949/bb-check`를
// devDependency로 참조해 npm workspaces symlink(node_modules/.bin/bb-check)
// 로 직접 실행하는 경우(예: apps/demo의 `npm exec --workspace=apps/demo --
// bb-check ...`)는 그 npm install 시점의 chmod가 "그때 있던 파일"에만
// 적용되고, 이후 `vite build`가 dist/cli.js를 다시 쓰면 실행 권한이
// 사라진 채로 남는다 — 실측 확인됨(Permission denied). 그래서 빌드가
// 끝날 때마다 이 plugin이 직접 chmod 0o755를 건다.
const chmodCliBinPlugin = (): Plugin => ({
  name: "bb-check-chmod-cli-bin",
  writeBundle(_options, bundle) {
    if (!Object.hasOwn(bundle, "cli.js")) return;
    chmodSync(resolve(packageDir, "dist/cli.js"), 0o755);
  },
});

export default defineConfig({
  plugins: [chmodCliBinPlugin()],
  build: {
    target: "node20",
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
