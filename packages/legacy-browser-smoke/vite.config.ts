import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    // ssr(Node 대상) 빌드로 표시해 Vite의 브라우저 전용 asset-URL 변환을
    // 끈다. 이 변환은 `new URL("...", import.meta.url)`(chromium.ts가 자기
    // 자신의 설치 경로를 구하는 데 쓰는 흔한 Node 패턴)을 asset 참조로 잘못
    // 해석해, 해당 asset을 못 찾으면 번들 전체를 base64 data: URL로 다시
    // inline해 버린다(`ERR_INVALID_URL_SCHEME`로 런타임 실패). 부가 효과로
    // ssr 빌드는 minification도 끈다 — dist가 식별자를 그대로 유지한 채
    // 나가는데, Node 라이브러리이므로 의도한 동작이다.
    ssr: true,
    target: "node22",
    lib: {
      entry: resolve(packageDir, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    // yauzl은 package.json의 실제 runtime dependency다 — bundle에 inline하지
    // 않고 소비자 node_modules에서 resolve되도록 external로 둔다. inline하면
    // yauzl이 require하는 Node builtin(fs/util/stream 등)이 bare specifier로
    // 번들에 들어가 "browser compatibility"로 잘못 externalize되어 런타임에
    // 깨진다(예: `n.inherits is not a function`).
    rollupOptions: { external: [/^node:/u, "yauzl"] },
  },
});
