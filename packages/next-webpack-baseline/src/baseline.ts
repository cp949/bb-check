import browserslist from "browserslist";
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

type BrowserSupport = Readonly<Record<string, readonly [number, number]>>;

const MINIMUM_SUPPORT: Readonly<Record<SyntaxFeature, BrowserSupport>> = {
  "optional-chaining": {
    chrome: [80, 0],
    edge: [80, 0],
    firefox: [74, 0],
    ios_saf: [13, 4],
    opera: [67, 0],
    safari: [13, 1],
    samsung: [13, 0],
  },
  "nullish-coalescing": {
    chrome: [80, 0],
    edge: [80, 0],
    firefox: [72, 0],
    ios_saf: [13, 4],
    opera: [67, 0],
    safari: [13, 1],
    samsung: [13, 0],
  },
  "class-properties": {
    chrome: [72, 0],
    edge: [79, 0],
    firefox: [69, 0],
    ios_saf: [14, 5],
    opera: [59, 0],
    safari: [14, 1],
    samsung: [11, 1],
  },
  "private-methods": {
    chrome: [84, 0],
    edge: [84, 0],
    firefox: [90, 0],
    ios_saf: [15, 0],
    opera: [70, 0],
    safari: [15, 0],
    samsung: [14, 0],
  },
  "logical-assignment-operators": {
    chrome: [85, 0],
    edge: [85, 0],
    firefox: [79, 0],
    ios_saf: [14, 0],
    opera: [71, 0],
    safari: [14, 0],
    samsung: [14, 0],
  },
  "numeric-separator": {
    chrome: [75, 0],
    edge: [79, 0],
    firefox: [70, 0],
    ios_saf: [13, 0],
    opera: [62, 0],
    safari: [13, 0],
    samsung: [11, 1],
  },
  "async-generator-functions": {
    chrome: [63, 0],
    edge: [79, 0],
    firefox: [57, 0],
    ios_saf: [11, 0],
    opera: [50, 0],
    safari: [11, 0],
    samsung: [8, 2],
  },
  "object-rest-spread": {
    chrome: [60, 0],
    edge: [79, 0],
    firefox: [55, 0],
    ios_saf: [11, 3],
    opera: [47, 0],
    safari: [11, 1],
    samsung: [8, 2],
  },
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

const doesNotSupport = (feature: SyntaxFeature, target: string): boolean => {
  const parsed = parseTarget(target);
  if (parsed === undefined) return true;
  const minimum = MINIMUM_SUPPORT[feature][parsed[0]];
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
  for (const feature of Object.keys(MINIMUM_SUPPORT) as SyntaxFeature[]) {
    if (targets.some((target) => doesNotSupport(feature, target))) {
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
