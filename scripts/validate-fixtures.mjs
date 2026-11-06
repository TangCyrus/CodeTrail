import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { analyzeFixture, evaluateGold, projectRoot } from "./fixture-tools.mjs";

const reference = analyzeFixture("reference-lab");
const degraded = analyzeFixture("degraded-lab");
const results = evaluateGold(reference);
const passed = reference.status === "complete" && degraded.status === "partial"
  && Object.values(results).every((entry) => entry.falsePositive === 0 && entry.falseNegative === 0);
const report = {
  generatedAt: new Date().toISOString(), passed, nodeVersion: process.version,
  environment: { platform: process.platform, release: os.release(), architecture: process.arch, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  analyzer: reference.analyzer, scope: "Small fixed fixtures; annotation agreement is not real-project accuracy or runtime call coverage.",
  results,
  fixtures: [reference, degraded].map((snapshot) => ({
    root: path.relative(projectRoot, snapshot.rootDir).replaceAll("\\", "/"),
    status: snapshot.status, statistics: snapshot.statistics,
    unresolvedByReason: Object.fromEntries([...new Set(snapshot.unresolved.map((entry) => entry.reason))].map((reason) => [reason, snapshot.unresolved.filter((entry) => entry.reason === reason).length])),
    diagnostics: snapshot.diagnostics,
  })),
};
mkdirSync(path.join(projectRoot, "artifacts"), { recursive: true });
writeFileSync(path.join(projectRoot, "artifacts/phase-one-validation.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(path.join(projectRoot, "artifacts/reference-lab.json"), JSON.stringify(reference, null, 2) + "\n");
writeFileSync(path.join(projectRoot, "artifacts/degraded-lab.json"), JSON.stringify(degraded, null, 2) + "\n");
for (const [kind, result] of Object.entries(results)) {
  console.log(`${kind}: TP=${result.truePositive}, FP=${result.falsePositive}, FN=${result.falseNegative} (${result.scope})`);
  if (result.falsePositive || result.falseNegative) console.error(JSON.stringify({ unexpected: result.unexpected, missing: result.missing }, null, 2));
}
console.log(`Fixture validation ${passed ? "passed" : "failed"}; report: artifacts/phase-one-validation.json`);
if (!passed) process.exitCode = 1;
