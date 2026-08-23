import { defineConfig } from "@cp949/bb-check";

// projectDir은 재현 명령이 항상 --dir로 재정의하므로 실질적으로 쓰이지
// 않지만, normalizeConfig가 non-empty string을 요구하므로 유효한 값을 둔다.
export default defineConfig({
  library: { projectDir: ".", allow: [] },
});
