export interface NextWebpackBaselineConfig {
  readonly [key: string]: unknown;
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
