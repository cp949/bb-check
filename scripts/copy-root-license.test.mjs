import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const copyScript = resolve(import.meta.dirname, "copy-root-license.mjs");
const rootLicense = resolve(import.meta.dirname, "..", "LICENSE");

test("공개 package README를 보존하고 root LICENSE만 복사한다", async () => {
  const packageDir = await mkdtemp(
    join(tmpdir(), "bb-check-copy-root-license-"),
  );
  const packageReadme = Buffer.from("package README sentinel\r\n", "utf8");
  const packageLicense = Buffer.from("package LICENSE sentinel\r\n", "utf8");

  try {
    await writeFile(join(packageDir, "README.md"), packageReadme);
    await writeFile(join(packageDir, "LICENSE"), packageLicense);

    const result = spawnSync(process.execPath, [copyScript], {
      cwd: packageDir,
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      0,
      `copy-root-license가 실패했다:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `copy-root-license: LICENSE → ${packageDir}\n`);
    assert.deepEqual(
      await readFile(join(packageDir, "README.md")),
      packageReadme,
    );
    assert.deepEqual(
      await readFile(join(packageDir, "LICENSE")),
      await readFile(rootLicense),
    );
  } finally {
    await rm(packageDir, { recursive: true, force: true });
  }
});
