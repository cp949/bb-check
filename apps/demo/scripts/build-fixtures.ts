// apps/demo README가 재현하는 CLI 명령이 검사할 두 개의 최소 "library"
// 산출물(fixtures/compatible, fixtures/incompatible)을 Vite build API로
// 생성한다. 소스는 이 파일 안의 문자열 상수로만 존재한다 — 별도로 committed
// source 파일을 두지 않고, 빌드 시점에만 OS 임시 디렉터리에 소스를 써서
// Vite entry로 넘긴다(끝나면 지운다) — 이 스크립트 파일 하나가 두
// fixture의 유일한 진실 공급원이 되게 한다. (처음에는 실제 파일 없이
// Vite virtual module(resolveId/load 훅)로 시도했으나, 이 저장소의 Vite
// 8.2.2가 기본으로 쓰는 Rolldown 번들러가 `build.lib.entry`의 virtual
// module id를 resolveId 훅까지 넘기지 못하고 UNRESOLVED_ENTRY로 바로
// 실패했다 — 실측 확인됨. 그래서 실제 임시 파일을 쓰는 이 방식으로
// 바꿨다.)
//
// 각 fixture는 checkLibrary가 요구하는 두 가지를 갖춘 최소 package.json과
// 함께 만들어진다: package.json#browserslist(기준선)와
// package.json#exports(배포 진입점, "./dist/index.js").
//
//   - compatible: 현대 evergreen 브라우저 기준선(chrome/firefox/safari/edge
//     110 이상) + 평범한 문법·표준 내장 API만 쓴다 -> library check가 exit 0.
//   - incompatible: 아주 오래된 기준선(browserslist: ["ie 11"]) + optional
//     chaining/nullish coalescing(문법) + structuredClone(런타임 API)을
//     함께 써서 syntax·runtime-js 두 축 모두에서 확실히 위반이 나오게 한다
//     -> library check가 exit 1. IE11과 이 문법/API 사이의 격차는
//     caniuse-lite/@mdn/browser-compat-data가 갱신돼도 뒤집히지 않는다.
//
// vite build를 두 번 호출하되 매번 configFile: false로 이 디렉터리의
// vite.config.ts(데모 웹 페이지용 설정)를 명시적으로 우회한다 — 두 설정이
// 섞이지 않게 하기 위해서다.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const demoDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturesDir = join(demoDir, "fixtures");

const COMPATIBLE_SOURCE = `export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function greet(name) {
  return \`Hello, \${name}!\`;
}
`;

const INCOMPATIBLE_SOURCE = `export function cloneConfig(config) {
  const timeout = config?.timeout ?? 1000;
  return structuredClone({ ...config, timeout });
}
`;

interface FixtureSpec {
  readonly name: "compatible" | "incompatible";
  readonly source: string;
  readonly browserslist: readonly string[];
}

const FIXTURES: readonly FixtureSpec[] = [
  {
    name: "compatible",
    source: COMPATIBLE_SOURCE,
    browserslist: [
      "chrome >= 110",
      "firefox >= 110",
      "safari >= 16",
      "edge >= 110",
    ],
  },
  {
    name: "incompatible",
    source: INCOMPATIBLE_SOURCE,
    browserslist: ["ie 11"],
  },
];

const buildFixture = async (
  spec: FixtureSpec,
  sourceDir: string,
): Promise<void> => {
  const fixtureDir = join(fixturesDir, spec.name);
  const outDir = join(fixtureDir, "dist");
  const entryFile = join(sourceDir, `${spec.name}.js`);
  await writeFile(entryFile, spec.source, "utf8");

  await build({
    configFile: false,
    root: demoDir,
    publicDir: false,
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: true,
      target: "esnext",
      minify: false,
      sourcemap: false,
      lib: {
        entry: entryFile,
        formats: ["es"],
        fileName: () => "index.js",
      },
    },
  });

  await writeFile(
    join(fixtureDir, "package.json"),
    JSON.stringify(
      {
        name: `bb-check-demo-fixture-${spec.name}`,
        version: "0.0.0",
        private: true,
        type: "module",
        browserslist: [...spec.browserslist],
        exports: "./dist/index.js",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
};

const main = async (): Promise<void> => {
  await rm(fixturesDir, { recursive: true, force: true });
  await mkdir(fixturesDir, { recursive: true });

  const sourceDir = await mkdtemp(join(tmpdir(), "bb-check-demo-fixture-src-"));
  try {
    for (const spec of FIXTURES) {
      await buildFixture(spec, sourceDir);
    }
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
  }

  console.log(
    `build-fixtures: OK (${FIXTURES.map((fixture) => fixture.name).join(", ")} -> ${fixturesDir})`,
  );
};

await main();
