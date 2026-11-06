import { cpSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const representativeProjects = [
  { name: "react-checkout", title: "React TSX 结账", focus: "App", path: "src/App.tsx", relation: { from: "App", to: "CheckoutForm", kind: "RENDERS" }, core: { from: "createOrder", to: "calculateTotal", kind: "CALLS" } },
  { name: "ts-inventory", title: "TS 库存服务", focus: "checkout", path: "src/checkout.ts", relation: { from: "checkout", to: "reserve", kind: "CALLS" }, core: { from: "main", to: "checkout", kind: "CALLS" } },
  { name: "git-alias", title: "Git 别名与删除", focus: "submit", path: "src/order.ts", relation: { from: "submit", to: "amount", kind: "CALLS" }, core: { from: "main", to: "submit", kind: "CALLS" } },
];

export function copyRepresentative(name, destination) {
  if (!representativeProjects.some((project) => project.name === name) || existsSync(destination)) throw Error("A known example and a new destination are required");
  cpSync(path.join(root, "examples", name), destination, { recursive: true, errorOnExist: true });
  return destination;
}

export function gitInOwnedDemo(directory, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${path.join(directory, ".git/codetrail-no-hooks")}`, "-c", "commit.gpgsign=false", "-c", "user.name=CodeTrail Acceptance", "-c", "user.email=acceptance@example.invalid", "-C", directory, ...args], { encoding: "utf8", windowsHide: true, env });
}

export function prepareGitDemo(destination) {
  copyRepresentative("git-alias", destination);
  gitInOwnedDemo(destination, ["init", "--quiet", "--initial-branch=main"]);
  gitInOwnedDemo(destination, ["add", "--all"]);
  gitInOwnedDemo(destination, ["commit", "--quiet", "-m", "CodeTrail acceptance baseline"]);
  writeFileSync(path.join(destination, "src/pricing/amount.ts"), "export function amount(value: number, floor = 1): number { return value < floor ? floor : value; }\n");
  gitInOwnedDemo(destination, ["add", "--", "src/pricing/amount.ts"]);
  writeFileSync(path.join(destination, "src/pricing/amount.ts"), "export function amount(value: number, floor = 2): number { return value < floor ? floor : value; }\n");
  unlinkSync(path.join(destination, "src/pricing/legacy.ts"));
  renameSync(path.join(destination, "src/display.ts"), path.join(destination, "src/format.ts"));
  gitInOwnedDemo(destination, ["add", "--", "src/display.ts", "src/format.ts"]);
  writeFileSync(path.join(destination, "src/新增.ts"), "import { amount } from '@pricing/amount';\nexport function newOrder() { return amount(9); }\n");
  return destination;
}

/** Deterministic parser workload, not generated accuracy labels or a real-team project. */
export function generateWorkload(destination, count) {
  if (!Number.isInteger(count) || count < 2 || count > 600 || existsSync(destination)) throw Error("Invalid/new workload destination");
  mkdirSync(path.join(destination, "src/modules"), { recursive: true });
  writeFileSync(path.join(destination, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" } }));
  writeFileSync(path.join(destination, "src/main.ts"), "import { step0 } from './modules/m000';\nexport function main() { return step0(1); }\n");
  for (let index = 0; index < count - 1; index++) {
    const next = index < count - 2;
    const body = [next ? `import { step${index + 1} } from './m${String(index + 1).padStart(3, "0")}';` : "// Terminal module", `export interface Input${index} { value: number; }`, `export function step${index}(value: number): number {`];
    for (let step = 0; step < 20; step++) body.push(`  const value${step} = ${step ? `value${step - 1}` : "value"} + ${step};`);
    body.push(next ? `  return step${index + 1}(value19);` : "  return value19;", "}", "");
    writeFileSync(path.join(destination, `src/modules/m${String(index).padStart(3, "0")}.ts`), body.join("\n"));
  }
  return destination;
}
