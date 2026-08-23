#!/usr/bin/env node
// 저장소 루트의 README.md/LICENSE를 호출 시점의 cwd(공개 package 디렉터리)로
// 복사한다. `npm pack`/`npm publish`는 package 디렉터리 밖의 파일을 tarball에
// 포함할 수 없으므로, 공개 package는 이 script를 `prepack`에서 실행해 매번
// 루트 문서 최신본을 그대로 끌어온다 — 사본을 손으로 유지하며 원본과
// 어긋나는 걸 막는다.
//
// 사용: package 디렉터리에서 `node <repo root>/scripts/copy-root-docs.mjs`

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destDir = process.cwd();

for (const name of ["README.md", "LICENSE"]) {
  copyFileSync(join(repoRoot, name), join(destDir, name));
}

// stdout에는 아무것도 쓰지 않는다 — `npm pack --json`이 `prepack` lifecycle
// script로 이 파일을 실행하는데, stdout에 쓴 내용은 `npm pack --json`의
// JSON 출력 앞에 섞여 JSON.parse를 깨뜨린다(직접 재현 확인). 진단이
// 필요하면 stderr를 쓴다 — npm의 lifecycle 배너도 stderr로 간다.
console.error(`copy-root-docs: README.md, LICENSE → ${destDir}`);
