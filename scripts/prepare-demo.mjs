import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { root, prepareGitDemo } from "./acceptance-projects.mjs";
const parent = path.join(root, "artifacts/demo-projects"); mkdirSync(parent, { recursive: true });
const directory = prepareGitDemo(path.join(mkdtempSync(path.join(parent, "alias-")), "git-alias-demo"));
if (process.argv.includes("--json")) console.log(JSON.stringify({ directory }));
else console.log(`已创建独立 Git 演示项目：${directory}\n启动：npm run open -- "${directory}"\n演示包含暂存/未暂存、别名、删除、重命名候选和未跟踪源码。`);
