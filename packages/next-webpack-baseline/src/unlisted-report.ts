import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { PackageResource } from "./package-name.js";
import { SYNTAX_FEATURE_METADATA, SYNTAX_FEATURES } from "./syntax.js";
import type { SyntaxFeature } from "./baseline.js";
import type { SyntaxOccurrence } from "./syntax.js";
import {
  NEXT_WEBPACK_BASELINE_ERROR_CODES,
  NextWebpackBaselineError,
} from "./errors.js";

export const UNLISTED_REPORT_RELATIVE_PATH =
  ".next/diagnostics/baseline-unlisted.json";

export interface ReportFileSystem {
  temporaryPath(target: string): string;
  mkdirSync(path: string): void;
  writeFileSync(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

const nodeReportFileSystem: ReportFileSystem = {
  temporaryPath: (target) => `${target}.tmp-${process.pid}-${randomUUID()}`,
  mkdirSync: (path) => mkdirSync(path, { recursive: true }),
  writeFileSync: (path, data) =>
    writeFileSync(path, data, { encoding: "utf8", flag: "wx" }),
  renameSync,
  unlinkSync,
};

export type UnlistedReportMode = "warn" | "error";
export type UnanalyzableCause =
  "NWB_SYNTAX_PARSE_INCOMPLETE" | "NWB_WEBPACK_UNSUPPORTED";

export interface UnlistedPackageDiagnostic {
  readonly feature: SyntaxFeature;
  readonly count: number;
}

export interface UnlistedPackageReport {
  readonly package: string;
  readonly diagnostics: readonly UnlistedPackageDiagnostic[];
  readonly suggestedReason: string;
}

export interface UnanalyzableReport {
  readonly package: string;
  readonly entrypoint: string;
  readonly cause: UnanalyzableCause;
}

export interface UnlistedReport {
  readonly schemaVersion: 1;
  readonly mode: UnlistedReportMode;
  readonly packages: readonly UnlistedPackageReport[];
  readonly unanalyzable: readonly UnanalyzableReport[];
}

export interface AddSyntaxInput {
  readonly analysisKey: string;
  readonly resource: PackageResource;
  readonly occurrences: readonly SyntaxOccurrence[];
}

export interface AddUnanalyzableInput {
  readonly resource: PackageResource;
  readonly cause: UnanalyzableCause;
}

export interface UnlistedCollector {
  addSyntax(input: AddSyntaxInput): void;
  addUnanalyzable(input: AddUnanalyzableInput): void;
  createReport(mode: UnlistedReportMode): UnlistedReport;
}

export interface RenderedUnlistedReport {
  readonly packageMessages: readonly RenderedPackageMessage[];
  readonly summary: string | undefined;
}

export interface RenderedPackageMessage {
  readonly package: string;
  readonly message: string;
  readonly policySnippet?: string;
}

interface SyntaxObservation {
  readonly resource: PackageResource;
  readonly occurrences: readonly SyntaxOccurrence[];
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const reasonFor = (diagnostics: readonly UnlistedPackageDiagnostic[]): string =>
  diagnostics
    .map(
      ({ feature, count }) =>
        `${SYNTAX_FEATURE_METADATA[feature].reasonLabel} ${count}건`,
    )
    .join(" · ");

/** 미등록 source observation을 보관하고 표현 직전에만 결정적으로 정규화한다. */
export const createUnlistedCollector = (): UnlistedCollector => {
  const syntaxByAnalysisKey = new Map<string, SyntaxObservation>();
  const unanalyzableByKey = new Map<string, UnanalyzableReport>();

  return {
    addSyntax(input) {
      if (syntaxByAnalysisKey.has(input.analysisKey)) return;
      syntaxByAnalysisKey.set(input.analysisKey, {
        resource: { ...input.resource },
        occurrences: input.occurrences.map((occurrence) => ({ ...occurrence })),
      });
    },
    addUnanalyzable(input) {
      const key = `${input.resource.package}\u0000${input.resource.entrypoint}\u0000${input.cause}`;
      if (unanalyzableByKey.has(key)) return;
      unanalyzableByKey.set(key, {
        package: input.resource.package,
        entrypoint: input.resource.entrypoint,
        cause: input.cause,
      });
    },
    createReport(mode) {
      const countsByPackage = new Map<string, Map<SyntaxFeature, number>>();
      for (const observation of syntaxByAnalysisKey.values()) {
        let counts = countsByPackage.get(observation.resource.package);
        if (counts === undefined) {
          counts = new Map();
          countsByPackage.set(observation.resource.package, counts);
        }
        for (const { feature, count } of observation.occurrences) {
          counts.set(feature, (counts.get(feature) ?? 0) + count);
        }
      }

      const packages = [...countsByPackage]
        .sort(([left], [right]) => compareText(left, right))
        .flatMap(([packageName, counts]) => {
          const diagnostics = SYNTAX_FEATURES.flatMap((feature) => {
            const count = counts.get(feature);
            return count === undefined ? [] : [{ feature, count }];
          });
          if (diagnostics.length === 0) return [];
          return [
            {
              package: packageName,
              diagnostics,
              suggestedReason: reasonFor(diagnostics),
            },
          ];
        });
      const unanalyzable = [...unanalyzableByKey.values()].sort(
        (left, right) =>
          compareText(left.package, right.package) ||
          compareText(left.entrypoint, right.entrypoint) ||
          compareText(left.cause, right.cause),
      );

      return {
        schemaVersion: 1,
        mode,
        packages,
        unanalyzable,
      };
    },
  };
};

/** normalized report 하나에서 Webpack message와 복사 가능한 policy 제안을 함께 만든다. */
export const renderUnlistedReport = (
  report: UnlistedReport,
): RenderedUnlistedReport => {
  const packageByName = new Map(
    report.packages.map((packageReport) => [
      packageReport.package,
      packageReport,
    ]),
  );
  const unanalyzableCounts = new Map<string, number>();
  for (const item of report.unanalyzable) {
    unanalyzableCounts.set(
      item.package,
      (unanalyzableCounts.get(item.package) ?? 0) + 1,
    );
  }
  const packageNames = [
    ...new Set([
      ...packageByName.keys(),
      ...report.unanalyzable.map((item) => item.package),
    ]),
  ].sort(compareText);
  const packageMessages = packageNames.map((packageName) => {
    const reason = packageByName.get(packageName)?.suggestedReason;
    const unanalyzableCount = unanalyzableCounts.get(packageName) ?? 0;
    const detail = [
      ...(reason === undefined ? [] : [reason]),
      ...(unanalyzableCount === 0 ? [] : [`분석 불가 ${unanalyzableCount}건`]),
    ].join(" | ");
    return {
      package: packageName,
      message: `${packageName}: ${detail} — policy 등록 또는 waiver 검토`,
      ...(reason === undefined
        ? {}
        : {
            policySnippet: `{ package: '${packageName}', reason: '${reason}' },`,
          }),
    };
  });
  const syntaxCount = report.packages.reduce(
    (packageTotal, packageReport) =>
      packageTotal +
      packageReport.diagnostics.reduce(
        (diagnosticTotal, diagnostic) => diagnosticTotal + diagnostic.count,
        0,
      ),
    0,
  );
  const summary =
    packageNames.length === 0
      ? undefined
      : `미등록 ${packageNames.length}패키지 · 미지원 문법 ${syntaxCount}건 · 분석 불가 ${report.unanalyzable.length}건 — ${
          report.unanalyzable.length === 0
            ? "상세"
            : "분석 불가는 error 승격 전 해소 필요; 상세"
        }: .next/diagnostics/baseline-unlisted.json`;

  return {
    packageMessages,
    summary,
  };
};

const errorCodeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  typeof cause.code === "string"
    ? cause.code
    : undefined;

const reportIoFailed = (operation: string, cause: unknown): never => {
  throw new NextWebpackBaselineError(
    NEXT_WEBPACK_BASELINE_ERROR_CODES.REPORT_IO_FAILED,
    `미등록 package report ${operation}에 실패했습니다.`,
    { cause },
  );
};

const tryCleanup = (path: string, fileSystem: ReportFileSystem): void => {
  try {
    fileSystem.unlinkSync(path);
  } catch {
    // 원래 I/O 오류를 보존하기 위해 cleanup 실패는 덮어쓰지 않는다.
  }
};

const replaceReport = (
  temporaryPath: string,
  targetPath: string,
  fileSystem: ReportFileSystem,
): void => {
  try {
    fileSystem.renameSync(temporaryPath, targetPath);
  } catch (cause) {
    const code = errorCodeOf(cause);
    if (code !== "EPERM" && code !== "EEXIST") throw cause;

    try {
      fileSystem.unlinkSync(targetPath);
      fileSystem.renameSync(temporaryPath, targetPath);
    } catch {
      throw cause;
    }
  }
};

/** JSON 전체를 temp에 쓴 뒤 교체하며 Windows replace 제약만 한 번 fallback 한다. */
export const writeUnlistedReport = (
  projectDir: string,
  report: UnlistedReport,
  fileSystem: ReportFileSystem = nodeReportFileSystem,
): void => {
  const targetPath = resolve(projectDir, UNLISTED_REPORT_RELATIVE_PATH);
  const temporaryPath = fileSystem.temporaryPath(targetPath);
  try {
    fileSystem.mkdirSync(dirname(targetPath));
    fileSystem.writeFileSync(
      temporaryPath,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    replaceReport(temporaryPath, targetPath, fileSystem);
  } catch (cause) {
    tryCleanup(temporaryPath, fileSystem);
    reportIoFailed("작성", cause);
  }
};

/** production ignore에서 reporter가 소유한 stale JSON 한 파일만 삭제한다. */
export const removeUnlistedReport = (
  projectDir: string,
  fileSystem: ReportFileSystem = nodeReportFileSystem,
): void => {
  const targetPath = resolve(projectDir, UNLISTED_REPORT_RELATIVE_PATH);
  try {
    fileSystem.unlinkSync(targetPath);
  } catch (cause) {
    if (errorCodeOf(cause) === "ENOENT") return;
    reportIoFailed("삭제", cause);
  }
};
