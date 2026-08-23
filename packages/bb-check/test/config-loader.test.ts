// bb-check.config.mjs 탐색·동적 import·경로 정규화(config-loader.ts)를 검증한다.
// normalizeConfig 자체의 검증 로직(hostile input matrix 등)은 packages/core/test/config.test.ts가
// 이미 다루므로, 여기서는 loader가 "어떤 파일을 어떻게 찾아 넘기는가"만 확인한다.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config-loader.js";

/** library.projectDir만 있는 최소 config 파일 본문을 만든다. */
const configSource = (projectDir: string, extra = "") =>
  [
    `export default {`,
    `  library: {`,
    `    projectDir: ${JSON.stringify(projectDir)},`,
    `    allow: [],`,
    `  },`,
    `};`,
    extra,
    "",
  ].join("\n");

describe("loadConfig: config 탐색", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-check-config-loader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("가장 가까운 package 경계까지만 config를 찾는다", async () => {
    // package.json은 root에만 있고 bb-check.config.mjs는 어디에도 없다.
    // 탐색이 root(패키지 경계)에서 멈추지 않고 더 위로 올라가면(예: 실제
    // 저장소 루트의 package.json까지 올라가면) 이 테스트가 감지하지
    // 못하는 잘못된 config를 주울 수 있으므로, 경계를 명시적으로 만든다.
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "boundary-fixture", version: "1.0.0" }),
      "utf8",
    );
    const cwd = join(root, "nested", "deep");
    await mkdir(cwd, { recursive: true });

    await expect(loadConfig({ cwd })).rejects.toMatchObject({
      code: "BB_CONFIG_NOT_FOUND",
    });
  });

  it("cwd에서 가장 가까운 bb-check.config.mjs를 찾아 사용한다", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "found-fixture", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      join(root, "bb-check.config.mjs"),
      configSource("./target"),
      "utf8",
    );
    const cwd = join(root, "nested", "deep");
    await mkdir(cwd, { recursive: true });

    const config = await loadConfig({ cwd });
    expect(config.library.projectDir).toBe(join(root, "target"));
  });

  it("cwd도 package 경계도 아닌 중간 디렉터리의 config를 찾는다", async () => {
    // config가 cwd 자신(가장 가까운 경우)이나 package 경계(가장 먼 경우)가
    // 아니라 그 사이 어딘가에 있을 때도 위로 걸어 올라가며 찾아야 한다.
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "middle-fixture", version: "1.0.0" }),
      "utf8",
    );
    const middle = join(root, "nested");
    await mkdir(middle, { recursive: true });
    await writeFile(
      join(middle, "bb-check.config.mjs"),
      configSource("./target"),
      "utf8",
    );
    const cwd = join(middle, "deep");
    await mkdir(cwd, { recursive: true });

    const config = await loadConfig({ cwd });
    expect(config.library.projectDir).toBe(join(middle, "target"));
  });

  it("cwd 자신에 config가 있으면 그 파일을 쓴다", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "self-fixture", version: "1.0.0" }),
      "utf8",
    );
    await writeFile(
      join(root, "bb-check.config.mjs"),
      configSource("."),
      "utf8",
    );

    const config = await loadConfig({ cwd: root });
    expect(config.library.projectDir).toBe(root);
  });
});

describe("loadConfig: --config 명시 경로", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-check-config-loader-explicit-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--config가 있으면 자동 탐색을 생략하고 그 파일만 사용한다", async () => {
    // cwd 바로 아래에도 config가 있지만, --config로 다른 파일을 명시하면
    // cwd 쪽 config는 전혀 읽지 않아야 한다.
    await writeFile(
      join(root, "bb-check.config.mjs"),
      configSource("./from-cwd-search"),
      "utf8",
    );
    const explicitDir = join(root, "explicit");
    await mkdir(explicitDir, { recursive: true });
    const explicitConfigPath = join(explicitDir, "other.config.mjs");
    await writeFile(
      explicitConfigPath,
      configSource("./from-explicit-config"),
      "utf8",
    );

    const config = await loadConfig({
      cwd: root,
      config: explicitConfigPath,
    });
    expect(config.library.projectDir).toBe(
      join(explicitDir, "from-explicit-config"),
    );
  });

  it("--config 경로가 cwd 기준 상대 경로면 cwd 기준으로 해석한다", async () => {
    const explicitDir = join(root, "explicit");
    await mkdir(explicitDir, { recursive: true });
    await writeFile(
      join(explicitDir, "other.config.mjs"),
      configSource("./target"),
      "utf8",
    );

    const config = await loadConfig({
      cwd: root,
      config: "explicit/other.config.mjs",
    });
    expect(config.library.projectDir).toBe(join(explicitDir, "target"));
  });

  it("--config로 지정한 파일이 없으면 BB_CONFIG_NOT_FOUND다", async () => {
    await expect(
      loadConfig({ cwd: root, config: "missing.config.mjs" }),
    ).rejects.toMatchObject({ code: "BB_CONFIG_NOT_FOUND" });
  });
});

describe("loadConfig: --dir 우선순위와 경로 기준", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-check-config-loader-dir-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("--dir이 있으면 config의 projectDir보다 우선한다", async () => {
    const configPath = join(root, "bb-check.config.mjs");
    await writeFile(configPath, configSource("./from-config"), "utf8");

    const config = await loadConfig({
      cwd: root,
      config: configPath,
      dir: "./from-dir-flag",
    });
    expect(config.library.projectDir).toBe(join(root, "from-dir-flag"));
  });

  it("--dir과 projectDir 모두 cwd가 아니라 config 파일 위치 기준으로 절대 경로화한다", async () => {
    // cwd는 config 파일과 다른 디렉터리다. --dir을 cwd 기준으로 잘못
    // 해석하면(버그) 이 assertion이 실패해 감지한다.
    const configDir = join(root, "config-dir");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "bb-check.config.mjs");
    await writeFile(configPath, configSource("./from-config"), "utf8");

    const otherCwd = join(root, "unrelated-cwd");
    await mkdir(otherCwd, { recursive: true });

    const withDirOverride = await loadConfig({
      cwd: otherCwd,
      config: configPath,
      dir: "./target",
    });
    expect(withDirOverride.library.projectDir).toBe(join(configDir, "target"));

    const withoutDirOverride = await loadConfig({
      cwd: otherCwd,
      config: configPath,
    });
    expect(withoutDirOverride.library.projectDir).toBe(
      join(configDir, "from-config"),
    );
  });

  it("allow 목록은 --dir 적용 여부와 무관하게 정규화된 값을 그대로 유지한다", async () => {
    const configPath = join(root, "bb-check.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        "  library: {",
        '    projectDir: ".",',
        "    allow: [",
        '      { file: "dist/index.js", name: "structuredClone", reason: "테스트" },',
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig({
      cwd: root,
      config: configPath,
      dir: "./override",
    });
    expect(config.library.allow).toEqual([
      { file: "dist/index.js", name: "structuredClone", reason: "테스트" },
    ]);
  });
});

describe("loadConfig: config 파일 내용 검증", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-check-config-loader-invalid-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("default export가 없거나 object가 아니면 BB_CONFIG_INVALID로 실패한다", async () => {
    // normalizeConfig가 실제로 호출되는지 확인하는 배선(wiring) 테스트다.
    // normalizeConfig 자체의 hostile input 판정 로직은 core 쪽 테스트가 이미 다룬다.
    const configPath = join(root, "bb-check.config.mjs");
    await writeFile(configPath, "export default 123;\n", "utf8");

    await expect(
      loadConfig({ cwd: root, config: configPath }),
    ).rejects.toMatchObject({ code: "BB_CONFIG_INVALID" });
  });

  it("config 파일 로드 중 예외가 발생하면 BB_CONFIG_INVALID로 감싼다", async () => {
    const configPath = join(root, "bb-check.config.mjs");
    await writeFile(
      configPath,
      "throw new Error('config가 스스로 실패한다');\n",
      "utf8",
    );

    await expect(
      loadConfig({ cwd: root, config: configPath }),
    ).rejects.toMatchObject({ code: "BB_CONFIG_INVALID" });
  });
});
