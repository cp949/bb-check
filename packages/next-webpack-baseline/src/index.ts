export interface NextWebpackBaselineConfig {
  readonly projectDir: string;
  readonly policy: readonly PackagePolicy[];
  readonly waivers?: readonly PackageWaiver[];
}

export interface PackagePolicy {
  readonly package: string;
  readonly reason: string;
}

export interface PackageWaiver {
  readonly package: string;
  readonly reason: string;
  readonly allowedEntrypoints: readonly string[];
}

export interface NextWebpackBaseline {
  readonly options: NextWebpackBaselineConfig;
}

export const defineConfig = <T extends NextWebpackBaselineConfig>(
  input: T,
): T => input;

export const createNextWebpackBaseline = (
  input: NextWebpackBaselineConfig,
): NextWebpackBaseline => ({ options: input });
