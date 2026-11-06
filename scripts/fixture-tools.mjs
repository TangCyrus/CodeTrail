import { readFileSync } from "node:fs";
import path from "node:path";
import { analyzeProject } from "../packages/analyzer/dist/index.js";

export const projectRoot = path.resolve(import.meta.dirname, "..");
export function analyzeFixture(name) {
  return analyzeProject({ rootDir: path.join(projectRoot, "fixtures", name) });
}
export function describeSnapshot(snapshot) {
  const files = new Map(snapshot.files.map((file) => [file.id, file]));
  const evidence = new Map(snapshot.evidence.map((entry) => [entry.id, entry]));
  const labels = new Map([
    ...snapshot.files.map((file) => [file.id, file.path]),
    ...snapshot.symbols.map((symbol) => [symbol.id, `${files.get(symbol.fileId).path}#${symbol.qualifiedName}`]),
  ]);
  const describe = (entry) => {
    const proof = evidence.get(entry.evidenceId);
    return {
      kind: entry.kind, from: labels.get(entry.from),
      ...(entry.to ? { to: labels.get(entry.to) } : {}),
      file: files.get(proof.fileId).path, line: proof.range.start.line, excerpt: proof.excerpt,
      ...(entry.usage ? { usage: entry.usage } : {}), ...(entry.reason ? { reason: entry.reason } : {}),
    };
  };
  return { relations: snapshot.relations.map(describe), unresolved: snapshot.unresolved.map(describe), labels };
}
const key = (item) => JSON.stringify([item.kind, item.from, item.to, item.file, item.line, item.excerpt, item.usage, item.reason]);
const siteKey = (item) => JSON.stringify([item.file, item.line, item.excerpt]);

/** Multiset scoring counts duplicated or unexpected edges as false positives. */
export function score(expected, actual) {
  const remaining = new Map();
  for (const item of expected) remaining.set(key(item), (remaining.get(key(item)) ?? 0) + 1);
  let truePositive = 0;
  const unexpected = [];
  for (const item of actual) {
    const count = remaining.get(key(item)) ?? 0;
    if (count > 0) { truePositive++; remaining.set(key(item), count - 1); }
    else unexpected.push(item);
  }
  const falsePositive = unexpected.length;
  const falseNegative = expected.length - truePositive;
  return {
    expected: expected.length, actual: actual.length, truePositive, falsePositive, falseNegative,
    precision: actual.length ? truePositive / actual.length : null,
    recall: expected.length ? truePositive / expected.length : null,
    unexpected,
    missing: expected.filter((item) => {
      const count = remaining.get(key(item)) ?? 0;
      if (!count) return false;
      remaining.set(key(item), count - 1);
      return true;
    }),
  };
}

export function evaluateGold(snapshot) {
  const gold = JSON.parse(readFileSync(path.join(projectRoot, "fixtures/gold/reference-lab.json"), "utf8"));
  const described = describeSnapshot(snapshot);
  const results = {};
  for (const kind of gold.fullInventoryKinds) {
    results[kind] = { scope: "all occurrences in reference-lab", ...score(gold.relations.filter((item) => item.kind === kind), described.relations.filter((item) => item.kind === kind)) };
  }
  const reviewedSites = new Set(gold.reviewedReferences.map(siteKey));
  results.REFERENCES = { scope: "only the eight manually reviewed identifier sites; not all references", ...score(gold.reviewedReferences, described.relations.filter((item) => item.kind === "REFERENCES" && reviewedSites.has(siteKey(item)))) };
  results.UNRESOLVED = { scope: "all unresolved occurrences in reference-lab", ...score(gold.unresolved, described.unresolved) };
  return results;
}
