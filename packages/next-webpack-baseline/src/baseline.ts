import browserslist from "browserslist";
import { createRequire } from "node:module";
import {
  NEXT_WEBPACK_BASELINE_ERROR_CODES,
  NextWebpackBaselineError,
} from "./errors.js";

export type SyntaxFeature =
  | "optional-chaining"
  | "nullish-coalescing"
  | "class-properties"
  | "private-methods"
  | "logical-assignment-operators"
  | "numeric-separator"
  | "async-generator-functions"
  | "object-rest-spread";

export interface BrowserBaseline {
  readonly targets: readonly string[];
  readonly unsupportedSyntax: ReadonlySet<SyntaxFeature>;
}

type BrowserSupport = Readonly<Record<string, string | readonly string[]>>;

const require = createRequire(import.meta.url);
const babelPluginSupport = require("@babel/compat-data/plugins") as Readonly<
  Record<string, BrowserSupport>
>;
const babelPluginBugfixSupport =
  require("@babel/compat-data/plugin-bugfixes") as Readonly<
    Record<string, BrowserSupport>
  >;

const COMPAT_DATA_FEATURES: Readonly<Record<SyntaxFeature, string>> = {
  "optional-chaining": "proposal-optional-chaining",
  "nullish-coalescing": "proposal-nullish-coalescing-operator",
  "class-properties": "proposal-class-properties",
  "private-methods": "proposal-private-methods",
  "logical-assignment-operators": "proposal-logical-assignment-operators",
  "numeric-separator": "proposal-numeric-separator",
  "async-generator-functions": "transform-async-generator-functions",
  "object-rest-spread": "proposal-object-rest-spread",
};

const TARGET_BROWSER_NAMES: Readonly<Record<string, string>> = {
  ios_saf: "ios",
  and_chr: "chrome",
  and_ff: "firefox",
  op_mob: "opera_mobile",
};

const parseTarget = (
  target: string,
): readonly [string, number, number] | undefined => {
  const match = /^([^\s]+)\s+(\d+)(?:\.(\d+))?/u.exec(target);
  if (!match?.[1] || !match[2]) return undefined;
  return [match[1], Number(match[2]), Number(match[3] ?? "0")];
};

const isBefore = (
  actual: readonly [number, number],
  minimum: readonly [number, number],
): boolean =>
  actual[0] < minimum[0] ||
  (actual[0] === minimum[0] && actual[1] < minimum[1]);

const parseVersion = (
  version: string,
): readonly [number, number] | undefined => {
  const match = /^(\d+)(?:\.(\d+))?/u.exec(version);
  if (!match?.[1]) return undefined;
  return [Number(match[1]), Number(match[2] ?? "0")];
};

/** @internal Browserslist target 하나의 compat-data 지원 여부를 순수하게 계산한다. */
export const isSyntaxUnsupportedForTarget = (
  feature: SyntaxFeature,
  target: string,
): boolean => {
  const parsed = parseTarget(target);
  if (parsed === undefined) return true;
  const compatFeature = COMPAT_DATA_FEATURES[feature];
  const support =
    babelPluginBugfixSupport[compatFeature] ??
    babelPluginSupport[compatFeature];
  if (support === undefined) return true;
  const browser = TARGET_BROWSER_NAMES[parsed[0]] ?? parsed[0];
  const version = support[browser];
  if (typeof version !== "string") return true;
  const minimum = parseVersion(version);
  if (minimum === undefined) return true;
  return isBefore([parsed[1], parsed[2]], minimum);
};

const browserlistMissing = (projectDir: string): never => {
  throw new NextWebpackBaselineError(
    NEXT_WEBPACK_BASELINE_ERROR_CODES.BROWSERSLIST_MISSING,
    `${projectDir}에서 production browserslist를 찾을 수 없습니다.`,
  );
};

const browserlistInvalid = (projectDir: string, cause: unknown): never => {
  throw new NextWebpackBaselineError(
    NEXT_WEBPACK_BASELINE_ERROR_CODES.CONFIG_INVALID,
    `${projectDir}의 production browserslist를 해석할 수 없습니다.`,
    { cause },
  );
};

export const resolveBrowserBaseline = (projectDir: string): BrowserBaseline => {
  let config: string | string[] | undefined;
  try {
    config = browserslist.loadConfig({
      path: projectDir,
      env: "production",
    });
  } catch (cause) {
    return browserlistInvalid(projectDir, cause);
  }
  if (config === undefined) browserlistMissing(projectDir);

  let loadedTargets: string[];
  try {
    loadedTargets = browserslist(config, {
      path: projectDir,
      env: "production",
    });
  } catch (cause) {
    return browserlistInvalid(projectDir, cause);
  }

  const targets = [...new Set(loadedTargets)].sort();
  const unsupportedSyntax = new Set<SyntaxFeature>();
  for (const feature of Object.keys(COMPAT_DATA_FEATURES) as SyntaxFeature[]) {
    if (
      targets.some((target) => isSyntaxUnsupportedForTarget(feature, target))
    ) {
      unsupportedSyntax.add(feature);
    }
  }

  if (unsupportedSyntax.size === 0) {
    throw new NextWebpackBaselineError(
      NEXT_WEBPACK_BASELINE_ERROR_CODES.BROWSERSLIST_MODERN_ONLY,
      `${projectDir}의 production browserslist에는 검사할 legacy target이 없습니다.`,
    );
  }

  return { targets, unsupportedSyntax };
};
