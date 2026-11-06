import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyzeProject } from "../packages/analyzer/dist/index.js";
import { projectRoot } from "../scripts/fixture-tools.mjs";

const temporaryRoot = path.join(projectRoot, "artifacts/test-temp");
export function tempProject(t, files = {}) {
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(path.join(temporaryRoot, "project-"));
  const write = (name, text) => {
    const destination = path.resolve(root, name);
    if (!destination.startsWith(root + path.sep)) throw new Error("Test file escaped its temporary project");
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, text, "utf8");
  };
  for (const [name, text] of Object.entries(files)) write(name, text);
  t.after(() => {
    const resolved = path.resolve(root);
    const allowed = path.resolve(temporaryRoot) + path.sep;
    if (!resolved.startsWith(allowed)) throw new Error("Refusing cleanup outside the test workspace");
    rmSync(resolved, { recursive: true, force: true });
  });
  return { root, write, analyze: (options = {}) => analyzeProject({ rootDir: root, ...options }) };
}

export function findSymbol(snapshot, file, qualifiedName) {
  const fileRecord = snapshot.files.find((entry) => entry.path === file);
  const symbols = snapshot.symbols.filter((entry) => entry.fileId === fileRecord?.id && entry.qualifiedName === qualifiedName);
  if (symbols.length !== 1) throw new Error(`Expected one symbol: ${file}#${qualifiedName}; found ${symbols.length}`);
  return symbols[0];
}
