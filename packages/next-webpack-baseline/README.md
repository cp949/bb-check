# @cp949/next-webpack-baseline

Next.js webpack baseline integration의 공개 package 경계다.

```ts
import {
  createNextWebpackBaseline,
  defineConfig,
} from "@cp949/next-webpack-baseline";
import { fileURLToPath } from "node:url";

const config = defineConfig({
  projectDir: fileURLToPath(new URL(".", import.meta.url)),
  policy: [],
});
const baseline = createNextWebpackBaseline(config);
```
