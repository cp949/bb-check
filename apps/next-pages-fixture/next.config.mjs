import {
  createNextWebpackBaseline,
  defineConfig,
} from "@cp949/next-webpack-baseline";
import { fileURLToPath } from "node:url";

const fixtureDir = fileURLToPath(new URL(".", import.meta.url));

const fixtureCase = process.env.NWB_FIXTURE_CASE ?? "green";
const supportedCases = new Set([
  "control",
  "red",
  "green",
  "waiver-exact",
  "waiver-prefix",
  "server-only",
  "unlisted-warn",
  "unlisted-error",
  "unlisted-ignore",
  "unlisted-dev-option",
  "unlisted-waiver",
]);

if (!supportedCases.has(fixtureCase)) {
  throw new Error(`Unknown NWB fixture case: ${fixtureCase}`);
}

const hasPolicy = new Set([
  "red",
  "green",
  "waiver-exact",
  "waiver-prefix",
  "server-only",
]).has(fixtureCase);
const allowedEntrypoints =
  fixtureCase === "waiver-exact" || fixtureCase === "unlisted-waiver"
    ? ["index.js"]
    : fixtureCase === "waiver-prefix"
      ? ["index"]
      : undefined;

const baseline = createNextWebpackBaseline(
  defineConfig({
    projectDir: fixtureDir,
    policy: hasPolicy
      ? [
          {
            package: "syntax-fixture",
            reason: "legacy target syntax integration fixture",
          },
        ]
      : [],
    ...(allowedEntrypoints === undefined
      ? {}
      : {
          waivers: [
            {
              package: "syntax-fixture",
              reason: "exact entrypoint integration fixture",
              allowedEntrypoints,
            },
          ],
        }),
    ...(fixtureCase === "unlisted-error"
      ? { unlistedPackages: "error" }
      : fixtureCase === "unlisted-ignore"
        ? { unlistedPackages: "ignore" }
        : {}),
  }),
);

export default {
  pageExtensions:
    fixtureCase === "server-only" ? ["server.tsx"] : ["client.tsx"],
  transpilePackages:
    fixtureCase === "green" ? [...baseline.transpilePackages] : [],
  webpack(config, context) {
    config.plugins.push(
      baseline.webpackPlugin({
        dev: fixtureCase === "unlisted-dev-option" ? true : context.dev,
      }),
    );
    return config;
  },
};
