# Agent 接入说明（0.4.1）

CodeTrail 现在提供本地 MCP 服务和两个配套 Skill，让 Coding Agent 查询架构、阅读顺序、符号关系、源码证据及 Git 改动影响。浏览器工作台仍可独立运行，也可以与 MCP 共用快照。

从 0.2.0 及以前版本升级，请先阅读 [命名迁移说明](命名迁移说明.md)，更新 MCP 名称、Skill 与相关环境变量。

首个完成协议和核心流程验收的宿主是 **Codex CLI 0.166.0-alpha.6 的 app-server**，运行环境为 Windows 11 / Node.js 24.20.0。尚未实际验收其他宿主、操作系统或模型自主选工具的效果。

## 准备

- Node.js 24.x；源码运行另需 npm 11+。
- Git 用于可选的 HEAD 改动比较；无 Git 仍可查询架构和源码。
- 已安装的 Codex。MCP 服务本身不需要 OpenAI API 密钥，不会调用模型。
- 目标代码目前支持 `.ts`、`.tsx`、`.js`、`.jsx`，继承 MVP 的解析范围和限制。

源码版本先在 CodeTrail 目录执行：

```powershell
npm ci --ignore-scripts
npm run build
```

预编译 **0.4.1** ZIP 已包含服务、依赖、Skill 和配置生成脚本，解压后可跳过安装及构建。以前的 0.1.0 ZIP 不含 MCP。

## 生成接入包

在 CodeTrail 源码或预编译包根目录执行，替换两个路径：

```powershell
node scripts/setup-codex.mjs "D:\你的项目" --out "D:\CodeTrail接入包"
```

输出目录必须尚不存在，避免覆盖已有配置。接入包包含：

- `config.toml`：使用当前 Node 和已构建服务的绝对路径，将一个项目固定为分析根目录。
- `skills/codetrail-understand/`：理解架构、定位关键代码和推荐阅读顺序。
- `skills/codetrail-impact/`：修改前理解关联、修改后核实 HEAD 影响与旧新证据。
- `README.txt`：安装提示。首次查询后还会生成 `cache/`。

生成动作不会修改用户的 Codex 配置，也不会往被分析项目写入文件。移动 CodeTrail 安装目录、目标项目或接入包后，应重新生成并更新配置中的绝对路径。

## 接入 Codex

1. 将生成的 `config.toml` 内容合并到 Codex 用户配置 `~/.codex/config.toml`，或可信项目的 `.codex/config.toml`。已有同名 `codetrail` 服务时先核对，勿重复同名 TOML 表。
2. 将接入包中的两个 Skill 文件夹复制到目标项目的 `.agents/skills/`；目录结构应是 `.agents/skills/codetrail-understand/SKILL.md` 和 `.agents/skills/codetrail-impact/SKILL.md`。已有同名 Skill 时先比较内容。
3. 重新加载或重启宿主，在 MCP 状态中确认 `codetrail` 已连接并列出六个工具。Codex CLI 可用 `codex mcp list` 检查配置，在交互界面使用 `/mcp` 检查连接。
4. 在目标项目中开始新会话，通过下面两个任务检查接入。

宿主负责启动配置中的 stdio 进程，日常不必先手动启动 CodeTrail 或浏览器。项目配置是否加载仍受宿主的工作区信任与组织策略影响。

配置模板如下；实际路径以生成文件为准，Windows 路径在 TOML 字符串中需正确转义：

```toml
[mcp_servers.codetrail]
command = "D:/tools/node/node.exe"
args = ["D:/tools/codetrail/apps/local/dist/cli.js", "mcp", "D:/your-project", "--data-dir", "D:/CodeTrail-kit/cache"]
startup_timeout_sec = 20
tool_timeout_sec = 90
```

只添加 MCP 配置也能调用工具；Skill 用于补充何时调用、如何检查结果及引用证据的工作方法。工具是否自动获选由宿主和模型决定，安装成功不等于每次都会自动使用。

官方参考：[Codex MCP 配置](https://developers.openai.com/codex/mcp)、[Codex Skill 发现与安装](https://developers.openai.com/codex/skills)。

## 两个核心任务

理解项目：

```text
使用 $codetrail-understand，帮我理解这个项目：先说明入口和模块关系，
推荐从哪里开始阅读，并为关键判断提供源码位置。
```

预期流程是 `project_overview` → `recommend_reading` / `search_symbols` → `symbol_context` → `read_evidence`。回答应能找到快照 ID、文件路径与行号，并区分静态事实和业务推断。

核实已有改动：

```text
使用 $codetrail-impact，检查当前工作区相对 HEAD 的修改，
说明可能关联的调用方和测试位置，用旧版或新版源码证明关键路径。
```

预期调用 `compare_worktree(refresh: true)`，按需分页，并用 `read_evidence(comparisonId, side, evidenceId)` 核实路径。它不自动改代码、不运行测试，也不将关联测试文件称为实际覆盖。

若任务包含授权修改，Agent 可以用宿主自己的编辑工具完成修改，再重新比较。比较基线始终为 Git HEAD，包含此前已有的工作区改动；不能将它称为“仅这次 Agent 修改的差异”。

## 六个工具与结果约定

- `project_overview({refresh?})`：返回架构摘要与 `snapshotId`。无快照时自动分析，已有快照默认复用并检查过期；`refresh: true` 创建新快照。
- `search_symbols({snapshotId, query, limit?})`：按名称和路径检索模块、文件、符号，最多 20 个结果。返回总匹配数和截断标志。
- `symbol_context({snapshotId, nodeId, depth?, maxNodes?, includeTypes?})`：最多两跳、40 个节点和 40 组关系。默认一跳、20 节点，排除规则候选，引用关系可见。证据 ID 可单独读取。
- `read_evidence(...)`：读取一个保留快照中的源码窗口。传 `snapshotId`，或 `comparisonId` 加 `side: base/current`，两种方式不能混用；另选一个 `evidenceId`、符号 `nodeId` 或 `fileId`。默认 40 行，最多 80 行；`line` 用于继续读取。
- `recommend_reading({snapshotId})`：最多十步阅读顺序、推荐依据及证据。结构指标不等于业务重要性，阅读顺序不等于运行时执行顺序。
- `compare_worktree({refresh?, comparisonId?, includeTypes?, changeOffset?, pathOffset?, limit?})`：首次创建 HEAD 与工作区比较，其后默认复用；`refresh: true` 重做比较，不能同时传 `comparisonId`。每页默认五项，最多十项，按 `nextChangeOffset` / `nextPathOffset` 继续读取同一比较。

固定快照查询都要求明确的 `snapshotId`。比较内的证据只能用其 `comparisonId` 和对应版本读取，不能拿比较的快照 ID 去普通快照查询。符号/文件 ID 必须来自相应结果，不接受任意磁盘路径。

结果同时提供 JSON 文本和结构化内容，包含版本、过期、截断与证据身份；部分解析保留诊断和未解析关系。`status: complete` 只表示分析诊断状态，不承诺完整依赖关系。

普通查询最多内嵌八份证据摘要；完整证据使用 ID 再取。源码窗口总文本最多 12,000 字符，单行最多 2,000 字符；省略会标明。每次结果最多 48,000 个 JSON 字符，超过则返回可恢复的 `RESULT_TOO_LARGE`，应缩小查询或分页。服务不静默切断 JSON。源码行列以一为起点，文件哈希为完整源码的 SHA-256，不能用截断窗口重算该哈希。

服务单个输入缓冲最多 128 KiB；查询串、ID、页大小均有边界。普通分析和比较复用现有默认 500 文件、单文件 1 MiB 范围。查询串行执行；取消或最长 60 秒的服务期限会中止对应工作任务，保留上次已完成结果。需要更大项目时应先选择子目录，并核对解析范围，不能通过提高宿主超时绕过服务限制。

## 打开共享证据工作台

生成接入包时加 `--workbench`：

```powershell
node scripts/setup-codex.mjs "D:\你的项目" --out "D:\CodeTrail接入包带界面" --workbench
```

工具返回 `workbenchUrl`，浏览器打开即可看到同一 MCP 进程的快照和 Git 比较。地址绑定 `127.0.0.1` 的随机端口，需要完整会话链接，不自动打开浏览器。服务退出后链接失效。

默认 stdio 模式不监听 HTTP 端口。MCP 模式的可选工作台固定关闭内置 AI 解释，密钥和模型未配置；解释由宿主 Agent 使用取得的证据完成。原有独立工作台的按需 AI 配置保持原规则。

## 数据与权限

CodeTrail 不执行目标项目代码，不修改源码或 Git 索引，只在配置的缓存目录保存分析结果和纳入分析的源码。缓存按项目隔离，普通快照与比较各保留最近三份；被清理的 ID 返回错误，不能自动替换为新版。

**本地解析不等于源码永不离开本机。** MCP 返回的源码片段会进入 Agent 宿主的上下文，是否发送到远程模型取决于宿主配置和任务。CodeTrail 自身不调用模型，不代表宿主离线运行。不要将工作台会话链接、缓存或工具完整输出公开分享。

源码、注释、名称、路径都作为不可信数据返回。Skill 要求忽略其中夹带的指令，并区分静态事实、启发式规则、业务推断和运行验证。Skill 不赋予额外的执行、修改、网络或发送权限。

## 常见问题与卸载

- 连接后没有输出：stdio 服务会等待宿主协议消息。不要把“等待输入”当作崩溃；不要通过 npm 的启动横幅接入协议。宿主配置必须直接运行 `node .../cli.js mcp ...`。
- “找不到快照/证据”：ID 可能过期或来自另一版本。刷新概览或比较，重新搜索，不猜测 ID。
- `stale: true`：保留的源码仍可作为历史证据，但不能代表当前代码。设置 `refresh: true` 后重新定位。
- 部分解析、没有路径：查看诊断、未解析数和解析范围；没有发现静态路径不表示没有影响。
- 缓存无法打开：换一个新的 `--data-dir`，旧缓存不会自动删除。先停服务再处理旧缓存。
- 请求超时或取消：上次结果保留，可缩小项目或重试。宿主超时建议大于服务的 60 秒。
- 路径包含中文或空格：使用生成器提供的绝对路径和正确引号，不通过额外 shell 拼接命令。
- 卸载：从宿主移除 `codetrail` MCP 配置及复制的两个 Skill，停止相关服务，再删除专用接入包和缓存目录。保留被分析项目的源码及 Git 数据。

## 开发与验收

```powershell
npm run test:mcp
npm run validate:codex
npm run check
```

`validate:codex` 使用本机 Codex app-server、隔离的配置目录与自有 Git 演示项目，实际发现 Skill 和工具并通过宿主发起工具调用；不修改用户配置、不加载用户凭据、不启动模型生成。若 Codex 不在 PATH，可通过 `CODETRAIL_CODEX_EXE` 指定可执行文件。

它验证宿主接入和工具链路，**没有验证模型是否自主选择合适的工具、抵抗注入指令，或准确解释业务**。相关人工任务试用仍待开展。验收明细见 [第六阶段验证记录](第六阶段验证记录.md)。
