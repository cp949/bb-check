import { resolve } from "node:path";
import {
  NEXT_WEBPACK_BASELINE_ERROR_CODES,
  NextWebpackBaselineError,
} from "./errors.js";
import type {
  NextWebpackBaselineConfig,
  PackagePolicy,
  PackageWaiver,
} from "./index.js";

export interface NormalizedConfig {
  readonly projectDir: string;
  readonly policyByPackage: ReadonlyMap<string, PackagePolicy>;
  readonly waiversByPackage: ReadonlyMap<string, readonly PackageWaiver[]>;
}

const npmPackageName =
  /^(?:@(?:[a-z0-9][a-z0-9._-]*)\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;

const invalid = (message: string): never => {
  throw new NextWebpackBaselineError(
    NEXT_WEBPACK_BASELINE_ERROR_CODES.CONFIG_INVALID,
    message,
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      invalid(`${label}에 알 수 없는 키 ${key}가 있습니다.`);
  }
};

/** sparse array와 overridden iteration method를 모두 피해서 own index를 순서대로 복사한다. */
const copyDenseArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value))
    return invalid(`${label}은(는) 배열이어야 합니다.`);

  const copied: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      invalid(`${label}[${index}]가 없어 sparse array는 사용할 수 없습니다.`);
    }
    copied.push(value[index]);
  }
  return copied;
};

const normalizePackageName = (value: unknown, label: string): string => {
  if (typeof value !== "string")
    return invalid(`${label}은(는) npm package name이어야 합니다.`);
  if (!npmPackageName.test(value))
    return invalid(`${label}은(는) npm package name이어야 합니다.`);
  return value;
};

const normalizeReason = (value: unknown, label: string): string => {
  if (typeof value !== "string")
    return invalid(
      `${label}은(는) trim 후 비어 있지 않은 문자열이어야 합니다.`,
    );
  if (value.trim() === "")
    return invalid(
      `${label}은(는) trim 후 비어 있지 않은 문자열이어야 합니다.`,
    );
  return value.trim();
};

const normalizePolicy = (value: unknown, label: string): PackagePolicy => {
  if (!isRecord(value)) return invalid(`${label}은(는) object여야 합니다.`);
  assertOnlyKeys(value, ["package", "reason"], label);
  return {
    package: normalizePackageName(value.package, `${label}.package`),
    reason: normalizeReason(value.reason, `${label}.reason`),
  };
};

const normalizeEntrypoints = (value: unknown, label: string): string[] => {
  const copied = copyDenseArray(value, label);
  const entrypoints: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < copied.length; index += 1) {
    const entrypoint = copied[index];
    if (typeof entrypoint !== "string")
      return invalid(
        `${label}[${index}]은(는) 비어 있지 않은 문자열이어야 합니다.`,
      );
    if (entrypoint.trim() === "")
      return invalid(
        `${label}[${index}]은(는) 비어 있지 않은 문자열이어야 합니다.`,
      );
    const normalized = entrypoint.trim();
    if (seen.has(normalized)) invalid(`${label}에 중복 entrypoint가 있습니다.`);
    seen.add(normalized);
    entrypoints.push(normalized);
  }
  return entrypoints;
};

const normalizeWaiver = (value: unknown, label: string): PackageWaiver => {
  if (!isRecord(value)) return invalid(`${label}은(는) object여야 합니다.`);
  assertOnlyKeys(value, ["package", "reason", "allowedEntrypoints"], label);
  return {
    package: normalizePackageName(value.package, `${label}.package`),
    reason: normalizeReason(value.reason, `${label}.reason`),
    allowedEntrypoints: normalizeEntrypoints(
      value.allowedEntrypoints,
      `${label}.allowedEntrypoints`,
    ),
  };
};

/** 입력을 모두 새 객체/배열로 옮겨 config source의 후속 mutation을 판정에서 격리한다. */
export const normalizeConfig = (input: unknown): NormalizedConfig => {
  if (!isRecord(input)) return invalid("config는 object여야 합니다.");
  assertOnlyKeys(input, ["projectDir", "policy", "waivers"], "config");

  if (typeof input.projectDir !== "string")
    return invalid(
      "config.projectDir은(는) 비어 있지 않은 경로 문자열이어야 합니다.",
    );
  if (input.projectDir.trim() === "")
    return invalid(
      "config.projectDir은(는) 비어 있지 않은 경로 문자열이어야 합니다.",
    );

  const policyByPackage = new Map<string, PackagePolicy>();
  const policy = copyDenseArray(input.policy, "config.policy");
  for (let index = 0; index < policy.length; index += 1) {
    const normalized = normalizePolicy(
      policy[index],
      `config.policy[${index}]`,
    );
    if (policyByPackage.has(normalized.package)) {
      invalid(`config.policy에 ${normalized.package} 중복 package가 있습니다.`);
    }
    policyByPackage.set(normalized.package, normalized);
  }

  const waiversByPackage = new Map<string, PackageWaiver[]>();
  if (input.waivers !== undefined) {
    const waivers = copyDenseArray(input.waivers, "config.waivers");
    const waiverKeys = new Set<string>();
    for (let index = 0; index < waivers.length; index += 1) {
      const normalized = normalizeWaiver(
        waivers[index],
        `config.waivers[${index}]`,
      );
      const waiverKey = `${normalized.package}\u0000${[...normalized.allowedEntrypoints].sort().join("\u0000")}`;
      if (waiverKeys.has(waiverKey)) {
        invalid(
          `config.waivers에 ${normalized.package} 중복 waiver가 있습니다.`,
        );
      }
      waiverKeys.add(waiverKey);
      const grouped = waiversByPackage.get(normalized.package);
      if (grouped === undefined) {
        waiversByPackage.set(normalized.package, [normalized]);
      } else {
        grouped.push(normalized);
      }
    }
  }

  const detachedWaiversByPackage = new Map<string, readonly PackageWaiver[]>();
  for (const [packageName, waivers] of waiversByPackage) {
    detachedWaiversByPackage.set(
      packageName,
      waivers.map((waiver) => ({
        package: waiver.package,
        reason: waiver.reason,
        allowedEntrypoints: [...waiver.allowedEntrypoints],
      })),
    );
  }

  return {
    projectDir: resolve(input.projectDir),
    policyByPackage: new Map(
      [...policyByPackage].map(([packageName, policy]) => [
        packageName,
        { package: policy.package, reason: policy.reason },
      ]),
    ),
    waiversByPackage: detachedWaiversByPackage,
  };
};

/** Public contract type is consumed here to keep internal normalization aligned with the facade. */
export type ConfigInput = NextWebpackBaselineConfig;
