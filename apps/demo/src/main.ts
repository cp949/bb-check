// bb-check demo의 정적 안내 페이지. 실제 검사는 이 브라우저 페이지가 아니라
// CLI로 재현한다 — @cp949/bb-check는 Node 전용 CLI/library이지 브라우저에서
// 실행할 수 있는 패키지가 아니다(esbuild 등 Node 전용 의존성을 쓴다). 이
// 페이지는 그 재현 명령을 사람이 읽기 좋게 보여주기만 한다.

const REPRO_COMMANDS = [
  "npm run build --workspace=apps/demo",
  "npm exec --workspace=apps/demo -- bb-check library check --config ./bb-check.config.mjs --dir ./fixtures/compatible",
  "npm exec --workspace=apps/demo -- bb-check library check --config ./bb-check.config.mjs --dir ./fixtures/incompatible",
];

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const render = (): void => {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (app === null) return;

  const commandItems = REPRO_COMMANDS.map(
    (command) => `<li><code>${escapeHtml(command)}</code></li>`,
  ).join("");

  app.innerHTML = `
    <main>
      <h1>@cp949/bb-check demo</h1>
      <p>
        이 페이지는 정적 안내용이다. 실제 검사 결과는 브라우저가 아니라
        CLI로 재현한다 — 아래 명령을 저장소 루트에서 순서대로 실행하면
        된다(자세한 설명은 이 앱의 README 참고).
      </p>
      <ol>${commandItems}</ol>
      <p>
        첫 번째 검사 명령(<code>fixtures/compatible</code>)은 exit 0으로
        끝나고, 두 번째 검사 명령(<code>fixtures/incompatible</code>)은
        exit 1로 끝난다.
      </p>
    </main>
  `;
};

render();
