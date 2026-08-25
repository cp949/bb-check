import {
  createNextWebpackBaseline,
  defineConfig,
} from "@cp949/next-webpack-baseline";

const fixtureCase = process.env.NWB_FIXTURE_CASE ?? "green";
const supportedCases = new Set([
  "control",
  "red",
  "green",
  "waiver-exact",
  "waiver-prefix",
  "server-only",
]);

if (!supportedCases.has(fixtureCase)) {
  throw new Error(`Unknown NWB fixture case: ${fixtureCase}`);
}

const hasPolicy = fixtureCase !== "control";
const allowedEntrypoints =
  fixtureCase === "waiver-exact"
    ? ["index.js"]
    : fixtureCase === "waiver-prefix"
      ? ["index"]
      : undefined;

const baseline = createNextWebpackBaseline(
  defineConfig({
    projectDir: import.meta.dirname,
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
  }),
);

export default {
  transpilePackages:
    fixtureCase === "green" ? [...baseline.transpilePackages] : [],
  webpack(config, context) {
    config.plugins.push(baseline.webpackPlugin({ dev: context.dev }));
    if (fixtureCase === "server-only") {
      config.resolve.alias["syntax-fixture$"] = false;
    }
    return config;
  },
};
