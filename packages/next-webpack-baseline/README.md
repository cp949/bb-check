# @cp949/next-webpack-baseline

Next.js webpack baseline integration의 공개 package 경계다.

```ts
import {
  createNextWebpackBaseline,
  defineConfig,
} from "@cp949/next-webpack-baseline";

const config = defineConfig({
  projectDir: import.meta.dirname,
  policy: [],
});
const baseline = createNextWebpackBaseline(config);
```
