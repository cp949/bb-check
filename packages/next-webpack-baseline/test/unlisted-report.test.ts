import { describe, expect, it } from "vitest";
import {
  createUnlistedCollector,
  removeUnlistedReport,
  renderUnlistedReport,
  type ReportFileSystem,
  writeUnlistedReport,
} from "../src/unlisted-report.js";
import { NextWebpackBaselineError } from "../src/errors.js";

const ioError = (code: string, message: string): NodeJS.ErrnoException => {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

const createFileSystem = (options?: {
  readonly firstRenameError?: NodeJS.ErrnoException;
  readonly secondRenameError?: NodeJS.ErrnoException;
  readonly removeError?: NodeJS.ErrnoException;
}) => {
  const events: string[] = [];
  let renameCalls = 0;
  const fileSystem: ReportFileSystem = {
    temporaryPath(target) {
      return `${target}.tmp-test`;
    },
    mkdirSync(path) {
      events.push(`mkdir:${path}`);
    },
    writeFileSync(path, data) {
      events.push(`write:${path}:${data}`);
    },
    renameSync(from, to) {
      renameCalls += 1;
      events.push(`rename:${from}:${to}`);
      if (renameCalls === 1 && options?.firstRenameError !== undefined) {
        throw options.firstRenameError;
      }
      if (renameCalls === 2 && options?.secondRenameError !== undefined) {
        throw options.secondRenameError;
      }
    },
    unlinkSync(path) {
      events.push(`unlink:${path}`);
      if (
        options?.removeError !== undefined &&
        path.endsWith("baseline-unlisted.json")
      ) {
        throw options.removeError;
      }
    },
  };
  return { events, fileSystem };
};

describe("미등록 package reporter", () => {
  it("package별 count를 병합하고 canonical 순서와 tuple 중복 제거를 적용한다", () => {
    const collector = createUnlistedCollector();
    collector.addSyntax({
      analysisKey: "widget-z-source-a",
      resource: { package: "widget-z", entrypoint: "dist/z.js" },
      occurrences: [
        { feature: "logical-assignment-operators", count: 4 },
        { feature: "class-properties", count: 2 },
      ],
    });
    collector.addSyntax({
      analysisKey: "widget-z-source-a",
      resource: { package: "widget-z", entrypoint: "dist/z.js" },
      occurrences: [
        { feature: "logical-assignment-operators", count: 4 },
        { feature: "class-properties", count: 2 },
      ],
    });
    collector.addSyntax({
      analysisKey: "widget-a-source-b",
      resource: { package: "widget-a", entrypoint: "dist/b.js" },
      occurrences: [{ feature: "optional-chaining", count: 2 }],
    });
    collector.addUnanalyzable({
      resource: { package: "widget-z", entrypoint: "dist/a.js" },
      cause: "NWB_SYNTAX_PARSE_INCOMPLETE",
    });
    collector.addUnanalyzable({
      resource: { package: "widget-z", entrypoint: "dist/a.js" },
      cause: "NWB_SYNTAX_PARSE_INCOMPLETE",
    });

    expect(collector.createReport("warn")).toEqual({
      schemaVersion: 1,
      mode: "warn",
      packages: [
        {
          package: "widget-a",
          diagnostics: [{ feature: "optional-chaining", count: 2 }],
          suggestedReason: "?. 2건",
        },
        {
          package: "widget-z",
          diagnostics: [
            { feature: "class-properties", count: 2 },
            { feature: "logical-assignment-operators", count: 4 },
          ],
          suggestedReason: "클래스 필드 2건 · 논리 할당 연산자 4건",
        },
      ],
      unanalyzable: [
        {
          package: "widget-z",
          entrypoint: "dist/a.js",
          cause: "NWB_SYNTAX_PARSE_INCOMPLETE",
        },
      ],
    });
  });

  it("같은 normalized report에서 package message, summary, policy snippet을 렌더링한다", () => {
    const collector = createUnlistedCollector();
    collector.addSyntax({
      analysisKey: "mixed-syntax",
      resource: { package: "mixed-widget", entrypoint: "dist/index.js" },
      occurrences: [{ feature: "class-properties", count: 2 }],
    });
    collector.addUnanalyzable({
      resource: { package: "mixed-widget", entrypoint: "dist/broken.js" },
      cause: "NWB_SYNTAX_PARSE_INCOMPLETE",
    });
    collector.addUnanalyzable({
      resource: { package: "unreadable-widget", entrypoint: "dist/index.js" },
      cause: "NWB_WEBPACK_UNSUPPORTED",
    });

    expect(renderUnlistedReport(collector.createReport("error"))).toEqual({
      packageMessages: [
        {
          package: "mixed-widget",
          message:
            "mixed-widget: 클래스 필드 2건 | 분석 불가 1건 — policy 등록 또는 waiver 검토",
          policySnippet:
            "{ package: 'mixed-widget', reason: '클래스 필드 2건' },",
        },
        {
          package: "unreadable-widget",
          message:
            "unreadable-widget: 분석 불가 1건 — policy 등록 또는 waiver 검토",
        },
      ],
      summary:
        "미등록 2패키지 · 미지원 문법 2건 · 분석 불가 2건 — 분석 불가는 error 승격 전 해소 필요; 상세: .next/diagnostics/baseline-unlisted.json",
    });
  });

  it("발견이 없으면 빈 배열과 summary 부재를 유지한다", () => {
    const report = createUnlistedCollector().createReport("warn");

    expect(report).toEqual({
      schemaVersion: 1,
      mode: "warn",
      packages: [],
      unanalyzable: [],
    });
    expect(renderUnlistedReport(report)).toEqual({
      packageMessages: [],
      summary: undefined,
    });
  });
});

describe("미등록 package report 파일 lifecycle", () => {
  const emptyReport = {
    schemaVersion: 1,
    mode: "warn",
    packages: [],
    unanalyzable: [],
  } as const;
  const reportPath = "/consumer/.next/diagnostics/baseline-unlisted.json";

  it("0건 JSON도 같은 디렉터리 temp에 완전히 쓴 뒤 rename한다", () => {
    const { events, fileSystem } = createFileSystem();

    writeUnlistedReport("/consumer", emptyReport, fileSystem);

    expect(events[0]).toBe("mkdir:/consumer/.next/diagnostics");
    expect(events[1]).toMatch(
      /^write:\/consumer\/\.next\/diagnostics\/baseline-unlisted\.json\.tmp-[^:]+:\{/u,
    );
    expect(events[1]).toContain(
      '\n  "mode": "warn",\n  "packages": [],\n  "unanalyzable": []\n}\n',
    );
    const tempPath = events[1]?.slice("write:".length).split(":{")[0];
    expect(events[2]).toBe(`rename:${tempPath}:${reportPath}`);
  });

  it.each(["EPERM", "EEXIST"])(
    "Windows %s replace 실패는 target 삭제 후 rename을 한 번 재시도한다",
    (code) => {
      const { events, fileSystem } = createFileSystem({
        firstRenameError: ioError(code, "first replace failure"),
      });

      writeUnlistedReport("/consumer", emptyReport, fileSystem);

      expect(
        events.filter((event) => event.startsWith("rename:")),
      ).toHaveLength(2);
      expect(events).toContain(`unlink:${reportPath}`);
    },
  );

  it("fallback 재시도가 실패하면 temp를 정리하고 첫 replace 오류를 보존한다", () => {
    const firstError = ioError("EPERM", "first replace failure");
    const { events, fileSystem } = createFileSystem({
      firstRenameError: firstError,
      secondRenameError: ioError("EACCES", "second replace failure"),
    });

    let caught: unknown;
    try {
      writeUnlistedReport("/consumer", emptyReport, fileSystem);
    } catch (error) {
      caught = error;
    }

    expect(caught).toEqual(
      expect.objectContaining<Partial<NextWebpackBaselineError>>({
        code: "NWB_REPORT_IO_FAILED",
        cause: firstError,
      }),
    );
    expect(
      events.some(
        (event) => event.startsWith("unlink:") && event.endsWith(".tmp-test"),
      ),
    ).toBe(true);
  });

  it("ignore lifecycle은 소유 report만 삭제하고 ENOENT는 성공으로 처리한다", () => {
    const existing = createFileSystem();
    removeUnlistedReport("/consumer", existing.fileSystem);
    expect(existing.events).toEqual([`unlink:${reportPath}`]);

    const absent = createFileSystem({
      removeError: ioError("ENOENT", "already absent"),
    });
    expect(() =>
      removeUnlistedReport("/consumer", absent.fileSystem),
    ).not.toThrow();
  });
});
