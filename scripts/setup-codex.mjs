import { mkdirSync, existsSync, cpSync, writeFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const codegraphRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tomlString = (value) => JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

/** Generate a reviewable kit. Never overwrite or modify host/user configuration. */
export function createCodexKit(project, destination, { workbench = false } = {}) {
  const rootDir = realpathSync(path.resolve(project)), output = path.resolve(destination);
  if (!statSync(rootDir).isDirectory()) throw Error("Project must be a directory");
  if (existsSync(output)) throw Error("--out must name a new directory; existing configuration is never overwritten");
  const entry = path.join(codegraphRoot, "apps/local/dist/cli.js");
  if (!existsSync(entry)) throw Error("Run npm run build before generating the kit");
  const args = [entry, "mcp", rootDir, "--data-dir", path.join(output, "cache"), ...(workbench ? ["--workbench"] : [])];
  const config = `[mcp_servers.codegraph]\ncommand = ${tomlString(process.execPath)}\nargs = [${args.map(tomlString).join(", ")}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 90\n`;
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "config.toml"), config);
  cpSync(path.join(codegraphRoot, "skills"), path.join(output, "skills"), { recursive: true });
  writeFileSync(path.join(output, "README.txt"), `CodeGraph Codex integration kit\nProject: ${rootDir}\nServer: ${entry}\n\nMerge config.toml into your Codex user or trusted project config.toml.\nCopy the two skills folders into the target project's .agents/skills directory.\nDo not overwrite an existing codegraph server or skill without reviewing it.\nRestart/reload the host and check its MCP server status.\nTry: $codegraph-understand Explain the entry point with source evidence.\nTry: $codegraph-impact Assess current changes against HEAD.\nThe cache directory can contain complete analyzed source.\nMCP returns source to the host; the host's model/data settings apply.\n`);
  return { output, rootDir, command: process.execPath, args, config };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [project, ...flags] = process.argv.slice(2);
    if (!project || flags[0] !== "--out" || !flags[1] || flags.slice(2).some((item) => item !== "--workbench") || flags.length > 3) throw Error("Usage: node scripts/setup-codex.mjs <project> --out <new-kit-directory> [--workbench]");
    const kit = createCodexKit(project, flags[1], { workbench: flags.includes("--workbench") });
    process.stdout.write(`Codex 接入包已生成：${kit.output}\n配置预览：\n${kit.config}\n未修改用户或项目的 Codex 配置。\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
