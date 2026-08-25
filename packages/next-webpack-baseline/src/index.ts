import { resolveBrowserBaseline } from "./baseline.js";
import { normalizeConfig } from "./config.js";
import {
  createWebpackPlugin,
  type WebpackPluginInstance,
} from "./webpack-plugin.js";

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
  readonly transpilePackages: readonly string[];
  webpackPlugin(options: { readonly dev: boolean }): WebpackPluginInstance;
}

export type { WebpackPluginInstance } from "./webpack-plugin.js";

export const defineConfig = <T extends NextWebpackBaselineConfig>(
  input: T,
): T => input;

export const createNextWebpackBaseline = (
  input: NextWebpackBaselineConfig,
): NextWebpackBaseline => {
  const config = normalizeConfig(input);
  const baseline = resolveBrowserBaseline(config.projectDir);

  return {
    transpilePackages: [...config.policyByPackage.keys()],
    webpackPlugin(options) {
      return createWebpackPlugin({ config, baseline }, options);
    },
  };
};
