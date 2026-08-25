import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { dts } from "rollup-plugin-dts";

const packageDir = dirname(fileURLToPath(import.meta.url));

export default {
  input: resolve(packageDir, "src/index.ts"),
  output: {
    file: resolve(packageDir, "dist/index.d.ts"),
    format: "es",
  },
  plugins: [dts({ tsconfig: resolve(packageDir, "tsconfig.build.json") })],
};
