// bb-check library check CLI의 argument 파싱(cli/args.ts)과 결과/오류를
// exit code·stdout·stderr로 옮기는 오케스트레이션(cli/main.ts)을 검증한다.
// checkLibrary/normalizeConfig 자체의 판정 로직은 여기서 다시 검증하지
// 않는다 — main()이 그 결과를 올바른 채널과 exit code로 옮기는지만 본다.
// 브리핑에 따라 아직 빌드되지 않은 main(args, io)를 함수로 직접 호출한다
// (자식 프로세스로 실행하는 것은 Vite 빌드가 들어오는 이후 task의 몫이다).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { main, type CliIo } from "../src/cli/main.js";

describe("parseArgs: 명시적 library check 문법", () => {
  it("명시적 library check만 허용한다", () => {
    expect(parseArgs(["library", "check", "--dir", "."])).toMatchObject({
      target: "library",
      action: "check",
      dir: ".",
    });
    expect(() => parseArgs(["check"])).toThrowError(/\[BB_USAGE\]/);
  });

  it("옵션이 없어도 통과한다", () => {
    const parsed = parseArgs(["library", "check"]);
    expect(parsed).toMatchObject({
      target: "library",
      action: "check",
      debug: false,
    });
    expect(parsed.config).toBeUndefined();
    expect(parsed.dir).toBeUndefined();
  });

  it("--config, --dir, --debug를 함께 파싱한다", () => {
    const parsed = parseArgs([
      "library",
      "check",
      "--config",
      "./bb-check.config.mjs",
      "--dir",
      "./target",
      "--debug",
    ]);
    expect(parsed).toEqual({
      target: "library",
      action: "check",
      config: "./bb-check.config.mjs",
      dir: "./target",
      debug: true,
    });
  });

  it.each([
    [[]],
    [["library"]],
    [["nextjs", "check"]],
    [["library", "check", "extra"]],
    [["library", "check", "--unknown"]],
    [["library", "check", "--dir"]],
    [["library", "check", "--config"]],
  ])("잘못된 argv %j는 BB_USAGE로 거절한다", (argv) => {
    expect(() => parseArgs(argv)).toThrowError(/\[BB_USAGE\]/);
  });
});

/** stdout/stderr에 write된 문자열을 모으는 테스트용 IO. */
const createRecordingIo = (cwd: string) => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io: CliIo = {
    stdout: (text) => stdoutChunks.push(text),
    stderr: (text) => stderrChunks.push(text),
    cwd,
  };
  return {
    io,
    stdoutText: () => stdoutChunks.join(""),
    stderrText: () => stderrChunks.join(""),
  };
};

/** package.json + dist/index.js + bb-check.config.mjs로 구성된 최소 project fixture를 만든다. */
const writeProjectFixture = async (
  dir: string,
  options: {
    browserslist: readonly string[];
    distSource: string;
  },
) => {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "cli-fixture",
      version: "1.0.0",
      private: true,
      browserslist: options.browserslist,
      exports: "./dist/index.js",
    }),
    "utf8",
  );
  await writeFile(join(dir, "dist", "index.js"), options.distSource, "utf8");
  await writeFile(
    join(dir, "bb-check.config.mjs"),
    'export default { library: { projectDir: ".", allow: [] } };\n',
    "utf8",
  );
};

describe("main: exit code matrix", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bb-check-cli-main-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("위반이 없으면 stdout에 보고서를 쓰고 exit 0을 반환한다", async () => {
    const dir = join(root, "pass");
    await mkdir(dir, { recursive: true });
    await writeProjectFixture(dir, {
      browserslist: ["chrome >= 80"],
      distSource: "export const noop = () => {};\n",
    });

    const { io, stdoutText, stderrText } = createRecordingIo(dir);
    const exitCode = await main(["library", "check"], io);

    expect(exitCode).toBe(0);
    expect(stdoutText()).toContain("판정: 통과");
    expect(stderrText()).toBe("");
  });

  it("위반이 있으면 stdout에 보고서를 쓰고 exit 1을 반환한다", async () => {
    const dir = join(root, "violation");
    await mkdir(dir, { recursive: true });
    await writeProjectFixture(dir, {
      browserslist: ["chrome >= 50"],
      distSource: [
        "export function greet(person) {",
        '  return person?.name ?? "guest";',
        "}",
        "",
      ].join("\n"),
    });

    const { io, stdoutText, stderrText } = createRecordingIo(dir);
    const exitCode = await main(["library", "check"], io);

    expect(exitCode).toBe(1);
    expect(stdoutText()).toContain("판정:");
    expect(stdoutText()).toContain("위반");
    expect(stderrText()).toBe("");
  });

  it("findings 없이 incomplete만 있어도 exit 1이다", async () => {
    // ChromeAndroid/FirefoxAndroid/OperaMobile/Samsung 조합은 esbuild가
    // 표현할 수 있는 문법 target이 없어(bb-library check-library.test.ts와
    // 동일한 실측 사례) BB_SYNTAX_TARGET_UNAVAILABLE로 incomplete가 된다.
    // ok는 findings.length===0 && !incomplete이므로, 이 경로가 findings
    // 유무와 무관하게 exit 1로 이어지는지 실제 파이프라인으로 확인한다.
    const dir = join(root, "incomplete");
    await mkdir(dir, { recursive: true });
    await writeProjectFixture(dir, {
      browserslist: [
        "ChromeAndroid >= 100",
        "FirefoxAndroid >= 100",
        "OperaMobile >= 60",
        "Samsung >= 15",
      ],
      distSource: "export const noop = () => {};\n",
    });

    const { io, stdoutText, stderrText } = createRecordingIo(dir);
    const exitCode = await main(["library", "check"], io);

    expect(exitCode).toBe(1);
    expect(stdoutText()).toContain("불완전");
    expect(stderrText()).toBe("");
  });

  it("사용법 오류는 stderr에 [BB_USAGE]를 쓰고 exit 2를 반환한다", async () => {
    const { io, stdoutText, stderrText } = createRecordingIo(root);
    const exitCode = await main(["check"], io);

    expect(exitCode).toBe(2);
    expect(stderrText()).toContain("[BB_USAGE]");
    expect(stdoutText()).toBe("");
  });

  it("config를 찾지 못하면 stderr에 [BB_CONFIG_NOT_FOUND]를 쓰고 exit 2를 반환한다", async () => {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "no-config-fixture", version: "1.0.0" }),
      "utf8",
    );
    const { io, stdoutText, stderrText } = createRecordingIo(root);
    const exitCode = await main(["library", "check"], io);

    expect(exitCode).toBe(2);
    expect(stderrText()).toContain("[BB_CONFIG_NOT_FOUND]");
    expect(stdoutText()).toBe("");
  });

  it("예상하지 못한 오류는 [BB_UNEXPECTED]로 감싸 exit 2를 반환한다", async () => {
    // cwd에 문자열이 아닌 값을 흘려보내는 것은 io 계약을 어기는 호출자
    // 버그를 흉내낸 것이다 — path.resolve가 던지는 TypeError는 core가
    // 분류한 BbError가 아니므로, main()의 catch-all이 [BB_UNEXPECTED]로
    // 감싸는지 검증하는 정직한 방법이다.
    const { io, stdoutText, stderrText } = createRecordingIo(
      undefined as unknown as string,
    );
    const exitCode = await main(["library", "check"], io);

    expect(exitCode).toBe(2);
    expect(stderrText()).toContain("[BB_UNEXPECTED]");
    expect(stdoutText()).toBe("");
  });

  it("기본 출력은 stack trace를 stderr에 남기지 않는다", async () => {
    const { io, stderrText } = createRecordingIo(root);
    await main(["check"], io);
    expect(stderrText()).not.toMatch(/\n\s+at /);
  });

  it("--debug는 stderr에 stack trace를 추가한다", async () => {
    const { io, stderrText } = createRecordingIo(root);
    await main(["check", "--debug"], io);
    expect(stderrText()).toMatch(/\n\s+at /);
  });
});
