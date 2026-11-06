import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const gitCommand = (root, args) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${path.join(root, ".git/codegraph-disabled-hooks")}`, "-c", "user.name=CodeGraph Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", root, ...args], { windowsHide: true, encoding: "utf8", env });
};
export function createGitFixture(root, commit = true) {
  mkdirSync(root, { recursive: true });
  const write = (name, body) => { const target = path.resolve(root, name); if (!target.startsWith(path.resolve(root) + path.sep)) throw Error("Fixture escaped root"); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, body); };
  gitCommand(root, ["init", "--quiet", "--initial-branch=main"]);
  const files = {
    "src/math.ts": "export function normalize(value: number): number { return value < 0 ? 0 : value; }\n",
    "src/service.ts": "import { normalize } from './math';\nexport function submit(value: number) { return normalize(value); }\n",
    "src/entry.ts": "import { submit } from './service';\nexport function main() { return submit(4); }\n",
    "src/obsolete.ts": "export function removed() { return 1; }\n",
    "src/legacy.ts": "import { removed } from './obsolete';\nexport function legacy() { return removed(); }\n",
    "src/rename.ts": "export function stable() { return 2; }\n",
    "src/types.ts": "export interface Payload { value: number; }\n",
    "src/typed.ts": "import type { Payload } from './types';\nexport function typed(value: Payload) { return value.value; }\n",
    "tests/service.test.ts": "import { submit } from '../src/service';\nexport function checkSubmit() { return submit(2); }\n",
  };
  for (const [name, body] of Object.entries(files)) write(name, body);
  if (commit) { gitCommand(root, ["add", "--all"]); gitCommand(root, ["commit", "--quiet", "-m", "Baseline fixture"]); }
  const change = () => {
    write("src/math.ts", "export function normalize(value: number, floor = 1): number { return value < floor ? floor : value; }\n");
    gitCommand(root, ["add", "--", "src/math.ts"]);
    write("src/math.ts", "export function normalize(value: number, floor = 2): number { return value < floor ? floor : value; }\n");
    unlinkSync(path.join(root, "src/obsolete.ts"));
    renameSync(path.join(root, "src/rename.ts"), path.join(root, "src/renamed.ts"));
    gitCommand(root, ["add", "--", "src/rename.ts", "src/renamed.ts"]);
    write("src/新增 helper.ts", "import { normalize } from './math';\nexport function fresh() { return normalize(7); }\n");
    write("src/types.ts", "export interface Payload { value: number; optional?: boolean; }\n");
  };
  return { root, write, change, files };
}
