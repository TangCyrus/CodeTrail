import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "../scripts/fixture-tools.mjs";
import { tempProject } from "./helpers.mjs";

const run = (args) => spawnSync(process.execPath, [path.join(projectRoot, "apps/local/dist/cli.js"), ...args], { encoding: "utf8", cwd: projectRoot, timeout: 20_000 });

test("CLI stdout is parseable JSON and progress summary stays on stderr", () => {
  const result = run(["analyze", "fixtures/reference-lab"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).schemaVersion, "0.1");
  assert.match(result.stderr, /14 files/);
  const summary = JSON.parse(result.stdout).resolutionSummary;
  assert.ok(result.stderr.includes(`${summary.gaps} gaps, ${summary.external} external references (${summary.totalUnlinked} unlinked total)`));
});

test("CLI publishes a snapshot atomically to a path with Chinese characters and spaces", (t) => {
  const target = tempProject(t, { "index.ts": "export const value = 1;" });
  const output = tempProject(t);
  const destination = path.join(output.root, "中文 输出", "快照.json");
  const result = run(["analyze", target.root, "--out", destination]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(JSON.parse(readFileSync(destination, "utf8")).files.length, 1);
  assert.deepEqual(readdirSync(path.dirname(destination)), ["快照.json"]);
});

test("CLI rejects missing paths and invalid arguments", () => {
  for (const args of [["analyze"], ["analyze", "fixtures/reference-lab", "--max-files", "0"], ["analyze", "fixtures/reference-lab", "--unknown", "x"]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.length > 0);
  }
  assert.equal(run(["--help"]).status, 0);
});
