# CodeTrail MVP 安装与使用

当前为本地试用版 0.9.0，验证平台为 Windows 11。需要 Node.js 24.x；源码安装另需 npm 11+，改动影响另需 Git。项目没有账号、云端服务或外部数据库要求。Agent 集成入口见 [Agent 接入说明](Agent接入说明.md)，本页主要介绍独立工作台。

从旧版本升级须同步更新名称与配置，见 [0.3.0 迁移说明](命名迁移说明.md)。

## 使用预编译包

0.9.0 在“改动影响 → 关联路径”增加符号名称/路径搜索和旧新版本选择。选中符号后从保存图独立追踪其关联，再点击路径中的源码依据核实；“返回概览路径”恢复整体结果。聚焦仍可能达到两跳或 100 路径等预算，界面会分别说明，不能把未列出理解为没有影响。升级已启动的 MCP 还需在宿主重载服务及配套 Skill。

将 `codetrail-mvp-0.9.0-win32-x64.zip` 完整解压到一个可写目录，保留 `apps`、`packages`、`node_modules`、`skills` 等目录结构。预编译包已包含所需生产依赖，不需要 npm 安装或构建。Node.js 和 Git 由本机提供。旧版 0.1.0 仍可独立浏览，但不提供 MCP。

在解压目录打开 PowerShell：

```powershell
node --version
.\codetrail.cmd open "D:\你的项目目录"
```

默认监听 `127.0.0.1:4317` 并打开浏览器。也可以使用等价的 Node 命令：

```powershell
node apps/local/dist/cli.js open "D:\你的项目目录" --port 0 --no-browser
```

`--port 0` 自动选择空闲端口，`--no-browser` 只输出链接。请打开终端中的完整会话链接；新服务生成的新链接会替换旧凭证。按 Ctrl+C 停止服务。不要覆盖解压包中的依赖；升级时解压新版本到新的目录。

## 从源码安装

在源码根目录运行：

```powershell
npm ci --ignore-scripts
npm run build
npm run open -- "D:\你的项目目录"
```

首次安装需要访问 npm registry；包版本和完整性由锁文件固定。不要在被分析项目中执行这些安装命令。分析器不会为目标项目安装依赖、执行脚本或修改代码。

## 三个代表项目

以下样例用于阅读和工具验收，不要求运行其业务代码：

```powershell
node apps/local/dist/cli.js open examples/react-checkout
node apps/local/dist/cli.js open examples/ts-inventory
node scripts/prepare-demo.mjs
```

前两个分别展示 TSX 组件使用与结账调用、TS 库存预留及转导出。React 样例附带最小 JSX 类型声明，服务于静态阅读；它不是已经部署的商城。

第三条命令在工具自己的 `artifacts/demo-projects` 下创建一个全新的 Git 别名演示，提交固定基线后制造暂存、未暂存、删除、重命名候选与未跟踪源码。命令会输出新目录及启动方式，不初始化用户已有项目。原始 `examples/git-alias` 只是基线模板，直接浏览它不会自动产生 Git 改动。

## 核心操作

1. 在架构概览选择目录模块，或搜索文件、完整符号名和路径。
2. 选择节点查看源码；展开局部图，点击关系依据核实位置。
3. 在阅读导览检查推荐原因和阅读顺序；加入清单并标记已读。
4. 节点“解释”默认提供本地事实。配置模型、启用 AI 并核对发送范围后，才会发起模型请求。
5. Git 项目进入改动影响，点击比较；逐项核实旧、新版源码和静态关联路径。
6. 输入变化后保留旧结果；手动刷新分析或重新比较后切换到新快照。

手机默认以列表浏览，目录和源码按单区域打开。全局搜索支持 Ctrl/Cmd + K。

## 可选 AI

在启动服务的终端中设置：

```powershell
$env:OPENAI_API_KEY = "你的 API Key"
$env:CODETRAIL_OPENAI_MODEL = "支持 Responses 结构化输出的可用模型 ID"
.\codetrail.cmd open "D:\你的项目目录"
```

密钥仅由本地服务读取，程序不自动加载 `.env`，浏览器不保存密钥。服务每次启动默认关闭 AI；在节点解释中启用并明确点击发送后，所预览的相对路径、签名、事实和片段才发送至配置端点。未配置时可直接使用所有本地阅读和 Git 能力。

当前仅验证了本地模拟 Responses 协议及失败回退，真实账户模型兼容、解释语义质量、延迟与费用仍需实际验证。更完整的配置和预算见源码 README。

## 数据、升级与卸载

默认缓存为 `%LOCALAPPDATA%\CodeTrail\cache`，按项目路径隔离。普通快照和 Git 比较分别保留最近三份，包含完整纳入源码；阅读进度、AI 解释及反馈也保存在本机。可以从启动参数指定独立缓存：

```powershell
.\codetrail.cmd open "D:\你的项目目录" --data-dir "D:\CodeTrail缓存"
```

升级时先停止旧服务，在新目录启动新版，再使用新会话链接。首次试用也可指定新的缓存目录。出现缓存损坏时使用 `--data-dir` 指向新的可写目录，保留旧目录以便排查；程序不会自动删除损坏缓存。

卸载时停止服务，删除工具解压目录。需要同时清理本地源码副本和进度时，再删除自己选择的 CodeTrail 缓存目录；清理缓存会丢失阅读清单、解释和历史证据。不要删除被分析的项目目录。

## 常见问题

- 无法启动：确认 Node 主版本为 24，完整解压了依赖与前端资源。
- 端口占用：用 `--port 0` 或指定其他端口。
- 会话失效：使用当前终端新输出的完整链接；旧标签页的凭证不适用于新服务。
- 没有完整图谱：查看分析诊断、未解析项和 `.codetrailignore`；不要把“完成”理解为关系完整。
- 非 UTF-8 或超过 1 MiB 的源码：明确跳过并保留其他健康文件；可在目标项目中自行调整编码或缩小范围。
- Git 不可用、无提交：继续本地阅读；完整历史影响需要可读的 HEAD 基线。
- AI 断网/超时/无效引用：保留本地说明，可以取消或稍后重试。
- Windows 以外的平台、浏览器未安装、复杂 monorepo：参阅 [已知限制](已知限制.md)。

## 开发者复验与打包

以下命令在源码根目录执行，不适用于预编译目录。

```powershell
npm run check
npm run test:browser
npm run benchmark
npm run release
npm run verify:release
```

浏览器测试使用本机安装的 Chrome，也可通过 `CODETRAIL_BROWSER_CHANNEL=msedge` 选择 Edge；不会自动下载浏览器。打包默认使用本地 npm 缓存离线安装锁定的生产依赖，缓存不全时可显式执行 `npm run release -- --online`。构建和 ZIP 校验产物保存在 `artifacts/`，不上传外部平台。
