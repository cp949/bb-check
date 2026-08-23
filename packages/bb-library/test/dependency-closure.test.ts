// createDependencyClosureScanner를 검사한다. 분류 우선순위(builtin/local/
// self/peer 허용 -> optional leak -> dependency leak -> undeclared ->
// computed), Windows/POSIX 로컬 경로 오인 방지, 5종 line terminator의
// line 번호 일관성, 그리고 실제 fixture 소스를 이용한 통합 검증까지
// 다룬다.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDependencyClosureScanner } from "../src/index.js";
import type { DependencyClosureScanner } from "../src/index.js";

const fixture = (name: string) => join(import.meta.dirname, "fixtures", name);

describe("createDependencyClosureScanner", () => {
  let tempDir: string;
  let scanner: DependencyClosureScanner;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bb-library-dependency-closure-"));
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "@scope/self",
        version: "1.0.0",
        exports: "./dist/index.js",
        dependencies: { "declared-dependency": "^1.0.0" },
        peerDependencies: { "declared-peer": "^1.0.0" },
        optionalDependencies: { "optional-only": "^1.0.0" },
      }),
      "utf8",
    );
    scanner = await createDependencyClosureScanner(tempDir);
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** specifier 하나를 side-effect import로 스캔해 finding을 돌려준다. */
  const scanImport = (specifier: string) =>
    scanner.scan(`import ${JSON.stringify(specifier)};`, "dist/index.js");

  describe("specifier 분류 우선순위", () => {
    it.each([
      ["node:fs", []],
      ["@scope/self/subpath", []],
      ["declared-peer", []],
      ["declared-dependency", ["dependency-leak"]],
      ["optional-only", ["optional-dependency-leak"]],
      ["missing-package", ["undeclared-runtime"]],
    ] as const)("specifier %s를 분류한다", (specifier, expectedKinds) => {
      expect(scanImport(specifier).map(({ kind }) => kind)).toEqual(
        expectedKinds,
      );
    });

    it.each([
      "./chunk.js",
      ".\\chunk.cjs",
      "C:\\chunk.cjs",
      "C:chunk.cjs",
      "\\\\server\\chunk.cjs",
    ])("로컬 경로 %s를 package import로 오인하지 않는다", (specifier) => {
      expect(scanImport(specifier)).toEqual([]);
    });

    it("dependencies와 optionalDependencies에 동시에 선언되면 optional-dependency-leak이 우선한다", async () => {
      const dir = await mkdtemp(
        join(tmpdir(), "bb-library-dependency-closure-both-"),
      );
      try {
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({
            name: "both-pkg",
            version: "1.0.0",
            dependencies: { "both-declared": "^1.0.0" },
            optionalDependencies: { "both-declared": "^1.0.0" },
          }),
          "utf8",
        );
        const s = await createDependencyClosureScanner(dir);
        expect(
          s
            .scan('import "both-declared";', "dist/index.js")
            .map(({ kind }) => kind),
        ).toEqual(["optional-dependency-leak"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("exports 필드가 없으면 자기 이름을 import해도 self-reference로 허용하지 않는다", async () => {
      const dir = await mkdtemp(
        join(tmpdir(), "bb-library-dependency-closure-no-exports-"),
      );
      try {
        await writeFile(
          join(dir, "package.json"),
          JSON.stringify({ name: "no-exports-pkg", version: "1.0.0" }),
          "utf8",
        );
        const s = await createDependencyClosureScanner(dir);
        expect(
          s
            .scan('import "no-exports-pkg";', "dist/index.js")
            .map(({ kind }) => kind),
        ).toEqual(["undeclared-runtime"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("import 형태", () => {
    it("export ... from 형태의 재-export도 분류한다", () => {
      expect(
        scanner
          .scan('export { x } from "missing-package";', "dist/index.js")
          .map(({ kind }) => kind),
      ).toEqual(["undeclared-runtime"]);
      expect(
        scanner
          .scan('export * from "missing-package";', "dist/index.js")
          .map(({ kind }) => kind),
      ).toEqual(["undeclared-runtime"]);
      expect(
        scanner
          .scan('export * as ns from "missing-package";', "dist/index.js")
          .map(({ kind }) => kind),
      ).toEqual(["undeclared-runtime"]);
    });

    it("from 없이 로컬 바인딩만 재-export하면 finding이 없다", () => {
      expect(
        scanner.scan("const x = 1;\nexport { x };", "dist/index.js"),
      ).toEqual([]);
    });

    it("literal require()도 import()와 동일하게 분류한다", () => {
      expect(
        scanner
          .scan('require("missing-package");', "dist/index.js")
          .map(({ kind }) => kind),
      ).toEqual(["undeclared-runtime"]);
    });

    it("literal dynamic import()도 동일하게 분류한다", () => {
      expect(
        scanner
          .scan('import("missing-package");', "dist/index.js")
          .map(({ kind }) => kind),
      ).toEqual(["undeclared-runtime"]);
    });
  });

  describe("computed specifier", () => {
    it("import(변수)는 정적으로 분류할 수 없어 computed-specifier로 보고한다", () => {
      const findings = scanner.scan(
        "const target = pick();\nimport(target);",
        "dist/index.js",
      );
      expect(findings).toEqual([
        expect.objectContaining({
          kind: "computed-specifier",
          name: "target",
          line: 2,
        }),
      ]);
    });

    it("require(변수)는 정적으로 분류할 수 없어 computed-specifier로 보고한다", () => {
      const findings = scanner.scan(
        "const target = pick();\nrequire(target);",
        "dist/index.js",
      );
      expect(findings).toEqual([
        expect.objectContaining({
          kind: "computed-specifier",
          name: "target",
          line: 2,
        }),
      ]);
    });
  });

  describe("line terminator", () => {
    const TERMINATORS: ReadonlyArray<readonly [string, string]> = [
      ["LF", "\n"],
      ["CRLF", "\r\n"],
      ["CR", "\r"],
      ["LS(U+2028)", "\u2028"],
      ["PS(U+2029)", "\u2029"],
    ];

    it.each(TERMINATORS)(
      "%s line terminator에서도 동일한 line 번호를 보고한다",
      (_label, terminator) => {
        const source = `const noop = 0;${terminator}import "missing-package";`;
        const findings = scanner.scan(source, "dist/index.js");
        expect(findings).toEqual([
          expect.objectContaining({ kind: "undeclared-runtime", line: 2 }),
        ]);
      },
    );
  });

  describe("정렬", () => {
    it("줄 번호 오름차순으로 정렬한다", () => {
      const source = [
        'import "zzz-missing";',
        'import "node:fs";',
        'import "aaa-missing";',
      ].join("\n");
      expect(
        scanner.scan(source, "dist/index.js").map(({ name }) => name),
      ).toEqual(["zzz-missing", "aaa-missing"]);
    });

    it("같은 줄이면 이름의 코드포인트 순으로 정렬한다", () => {
      const source = 'import "zzz-missing"; import "aaa-missing";';
      expect(
        scanner.scan(source, "dist/index.js").map(({ name }) => name),
      ).toEqual(["aaa-missing", "zzz-missing"]);
    });
  });

  describe("파싱 실패", () => {
    it("파싱할 수 없는 소스는 던진다", () => {
      expect(() => scanner.scan("const x = ;", "dist/index.js")).toThrow(
        /파싱할 수 없습니다/,
      );
    });
  });

  describe("manifest 오류", () => {
    it("package.json이 없으면 BB_INPUT_NOT_FOUND다", async () => {
      await expect(
        createDependencyClosureScanner(join(tempDir, "does-not-exist")),
      ).rejects.toMatchObject({ code: "BB_INPUT_NOT_FOUND" });
    });

    it("package.json이 올바른 JSON이 아니면 BB_CONFIG_INVALID다", async () => {
      const dir = await mkdtemp(
        join(tmpdir(), "bb-library-dependency-closure-invalid-"),
      );
      try {
        await writeFile(join(dir, "package.json"), "{ not json", "utf8");
        await expect(createDependencyClosureScanner(dir)).rejects.toMatchObject(
          { code: "BB_CONFIG_INVALID" },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("real fixture 통합", () => {
    it("dependency-clean fixture는 finding이 없다(builtin/local/self/peer 전부 허용)", async () => {
      const dir = fixture("dependency-clean");
      const cleanScanner = await createDependencyClosureScanner(dir);
      const source = await readFile(join(dir, "dist", "index.js"), "utf8");
      expect(cleanScanner.scan(source, "dist/index.js")).toEqual([]);
    });

    it("dependency-violations fixture는 4종 finding을 모두 보고한다", async () => {
      const dir = fixture("dependency-violations");
      const violationsScanner = await createDependencyClosureScanner(dir);
      const source = await readFile(join(dir, "dist", "index.js"), "utf8");
      const findings = violationsScanner.scan(source, "dist/index.js");

      expect(findings.map(({ kind, name }) => [kind, name])).toEqual([
        ["dependency-leak", "declared-leaky-dep"],
        ["optional-dependency-leak", "optional-leaky-dep"],
        ["undeclared-runtime", "totally-missing-dep"],
        ["computed-specifier", "chunkName"],
        ["computed-specifier", "`./chunks/${id}.js`"],
        ["computed-specifier", "chunkName"],
      ]);
      expect(new Set(findings.map(({ kind }) => kind))).toEqual(
        new Set([
          "dependency-leak",
          "optional-dependency-leak",
          "undeclared-runtime",
          "computed-specifier",
        ]),
      );
    });
  });
});
