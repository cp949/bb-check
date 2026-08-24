#!/usr/bin/env node
// 저장소 루트의 LICENSE를 호출 시점의 cwd(공개 package 디렉터리)로 복사한다.
// 공개 package의 README.md는 package 자체가 소유하므로 `prepack`은 README를
// 덮어쓰지 않고 LICENSE만 루트 정본으로 최신화한다.
//
// 사용: package 디렉터리에서 `node <repo root>/scripts/copy-root-license.mjs`

import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destDir = process.cwd();

copyFileSync(join(repoRoot, "LICENSE"), join(destDir, "LICENSE"));

// stdout에는 아무것도 쓰지 않는다 — `npm pack --json`이 `prepack` lifecycle
// script로 이 파일을 실행하는데, stdout에 쓴 내용은 `npm pack --json`의
// JSON 출력 앞에 섞여 JSON.parse를 깨뜨린다(직접 재현 확인). 진단이
// 필요하면 stderr를 쓴다 — npm의 lifecycle 배너도 stderr로 간다.
console.error(`copy-root-license: LICENSE → ${destDir}`);
