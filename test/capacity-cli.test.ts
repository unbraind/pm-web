/** Execute the actual CLI and report construction without allocating a measured workload. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "@babel/parser";
import { transformSync } from "esbuild";
import { capacityOptions } from "../scripts/capacity.ts";

for (const quiet of ["true", "false"]) {
  test(`capacity CLI forwards every run option and records its reproduction flags (quiet ${quiet})`, async () => {
    const source = readFileSync(new URL("../scripts/capacity.ts", import.meta.url), "utf8");
    const parsed = parse(source, { sourceType: "module", plugins: ["typescript"] });
    const names = new Set(["main", "runCapacity", "validateOptions"]);
    const bodies: string[] = [];
    for (const node of parsed.program.body) {
      const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
      if (declaration?.type === "FunctionDeclaration" && declaration.id && names.delete(declaration.id.name)) bodies.push(source.slice(declaration.start!, declaration.end!));
    }
    assert.equal(names.size, 0);
    const args = ["--rungs", "2", "--writers", "2", "--writes-per-writer", "1", "--slo-ms", "1000", "--drain-ms", "1000",
      "--trace", "true", "--idle-ms", "100", "--warmup-ms", "120000", "--setup-concurrency", "2", "--quiet-setup", quiet,
      "--writer-timeout-ms", "120000", "--output", "synthetic-report"];
    const { output, ...expected } = capacityOptions(args);
    const written = new Map<string, string>();
    const observed: unknown[] = [];
    const realm = { capacityOptions, cpus, totalmem, freemem, loadavg, path,
      process: { argv: ["node", "capacity.ts", ...args], platform: process.platform, arch: process.arch, version: process.version, stdout: { write: () => {} } },
      spawnSync: () => ({ status: 0 }), execFileSync: () => "synthetic-revision",
      runRung: async (_rung: number, options: unknown) => { observed.push(options); return { passed: true }; },
      mkdir: async () => {}, writeFile: async (file: string, body: string) => { written.set(file, body); },
      capacityMarkdown: () => "synthetic-markdown", result: undefined as Promise<void> | undefined };
    runInNewContext(transformSync(bodies.join("\n") + "\nglobalThis.result = main();", { loader: "ts", target: "es2022" }).code, realm);
    await realm.result;
    const report = JSON.parse(written.get(`${output}.json`)!);
    assert.deepEqual(report.options, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(observed)), [expected]);
    for (const flag of ["--warmup-ms 120000", "--setup-concurrency 2", "--writer-timeout-ms 120000", "--trace true", "--idle-ms 100"]) assert.ok(report.command.includes(flag), flag);
    assert.ok(report.command.includes(`--quiet-setup ${quiet}`));
    assert.equal(written.get(`${output}.md`), "synthetic-markdown");
  });
}

test("every Babel parser consumer has an explicit manifest and lockfile development dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  // An exact pin of any version: Dependabot moves it, and this test must not need an edit per release.
  assert.match(manifest.devDependencies["@babel/parser"], /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages[""].devDependencies["@babel/parser"], manifest.devDependencies["@babel/parser"]);
  assert.equal(lock.packages["node_modules/@babel/parser"].version, manifest.devDependencies["@babel/parser"]);
});
