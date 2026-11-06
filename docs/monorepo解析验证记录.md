# CodeTrail 0.4.0：monorepo 与跨包引用验证

日期：2026-11-06。环境：Windows 11、Node.js 24.20.0、npm 11.19.0、TypeScript 5.9.3、Codex CLI 0.166.0-alpha.6。

## 本次修复

原解析器把仓库放入根配置的单个编译程序，未展开 project references，也未正确接续工作区构建声明中的重导出。CodeTrail 自身因此出现项目引用不支持、跨包导出丢失等诊断。

现在读取选定根目录内的项目配置和引用，按就近目录及 files/include/exclude 的唯一归属选择编译选项；兼容选项的文件共享程序，不同选项保留独立类型检查器。扫描范围仍由扫描器控制，配置不能扩大根目录、文件上限或解除忽略规则。

工作区包通过 npm workspaces 或引用项目的 manifest 建立身份。TypeScript 负责 exports、types、子路径、通配符、import/require 条件与路径别名的解析；只有唯一的 rootDir/outDir/declarationDir 输出路径才能回到已扫描源码。第三方声明仍为 external，不安装依赖、不执行目标代码或构建。

跨程序的 Symbol 和 Node 对象不同，现通过文件绝对路径、声明起止偏移与节点种类匹配同一声明，不按名称猜测。源码证据仍来自原始调用位置，哈希、行列和旧新版本身份保持独立。

配置输入现包含嵌套配置、extends、工作区 manifest、依赖声明和缺失配置的探测位置。增加配置、修改包导出或更新声明都会使快照过期。Windows 引用路径大小写被归一，避免同一配置重复加载。

## 同一源码的修复前后对照

固定基线为提交 `49089e28cd12547545f0eee6ba5e933ab8f61957` 的源码，解压到独立目录并安装锁定依赖，目标目录不构建。分别用修复前和修复后的解析器读取同一目录。验证器逐项比较所有纳入扫描文件的路径和 SHA-256，保证不是因源码减少或扫描范围变化而改善。

- 纳入源码均为 **54 文件、3,215 符号**。
- 未解析项：**9,348 → 7,183**，减少 **2,165（23.16%）**。
- reason 为 unresolved 的记录：**2,663 → 97**；dynamic：319 → 18；ambiguous 保持 3。
- external：4,893 → 5,540，unsupported：1,470 → 1,525。部分原先缺少类型的信息现在被准确归类，外部与不支持项没有被隐藏。
- 诊断：**326 → 0**，状态由 partial 变为 complete。complete 仍不表示图完整或无未解析项。
- IMPORTS：52 → 111；CALLS：600 → 635；RENDERS：110 → 112；REFERENCES：6,474 → 8,551。

原先的 2,165 个未解析位置均能在新版找到相同 kind、来源节点和 evidenceId 的实际关系；没有通过删除记录或过滤外部依赖来降低数字。验证器还逐一核对新版全部证据与保留原文、偏移和文件哈希一致。

最后一次冻结样例分析约 3,574 → 8,144 ms。多编译环境增加了成本；这是本机单次测量，不是所有 monorepo 的性能保证，也不代表总体准确率。

数据位于 artifacts/monorepo/frozen-before.json、frozen-validation.json 及其 snapshot 文件。复验时用旧版解析器生成同一冻结目录的 baseline，再运行：

```powershell
npm run validate:monorepo -- --project "冻结的 CodeTrail 源码目录" --baseline "旧版快照.json" --out "对照结果.json"
```

不带参数的 `npm run validate:monorepo` 验证当前 CodeTrail 仓库；此脚本的具体跨包断言针对 CodeTrail 自身，不是通用项目入口。

## 源码关系与 Git 影响用例

新增 tests/monorepo.test.mjs 覆盖未构建工作区、重导出和纯类型、通配子路径、不同项目的同名路径别名、同目录多配置文件归属、NodeNext 的 import/require 条件、嵌套配置与 manifest 失效、引用循环、跨根阻断、第三方声明重导出、忽略边界、重名包、非法 manifest 及 Windows 引用路径大小写。

Git 用例只修改工作区包中的函数，确认 base 和 current 两侧都能找到另一包的调用方，逐条读取该侧源文核实路径证据；不会跨版本拼边。

自验确认以下真实调用及源码位置：

- apps/local/src/analysis-worker.ts → packages/analyzer/src/index.ts 的 analyzeProject。
- apps/local/src/comparison-worker.ts → packages/graph/src/comparison.ts 的 compareSnapshots。
- apps/local/src/explanation-context.ts → packages/graph/src/reading.ts 的 recommendReading。

通过用户当前配置的 Codex MCP 对修改后的仓库实际执行概览、搜索、上下游、阅读推荐、源码及改动分析，完成 33 次调用。修复前后自分析代码本身有变化，因此当前源码的符号、关系与未解析总数单独记录，不混作上面的固定源码对照。

最终当前源码自验：54 文件、3,400 符号、13,949 关系、7,669 未解析、0 诊断；快照 `snapshot:7a59dd98fde3fc9170de8c5e` 为 complete 且未过期。直接自验脚本与 Codex MCP 得到同一快照 ID。宿主识别 MCP 版本 0.4.0，两个已安装 Skill 均启用。

实际改动报告以 HEAD `49089e2` 为基线，涉及四个纳入分析的源码文件，返回 100 条路径并明确标记截断。HEAD 侧因历史依赖声明没有复用工作区内容，仍可为 partial；当前侧为 complete。另通过 MCP 读取该报告的 base/current 源码，确认快照 ID、文件哈希和证据身份对应正确版本。100 条路径不等于全部影响或测试覆盖。

宿主原始记录位于 artifacts/current-codex/latest.json 及其 run 目录；旧新证据检查位于 artifacts/monorepo/live-impact-evidence.json。只用本地协议调用验证功能，没有启动额外模型生成。

## 回归和边界

- `npm run check`：94 项通过、0 失败；包括新增的 12 项 monorepo 回归。
- 原关系金标准全部通过：IMPORTS 13、CALLS 18、RENDERS 1、REGISTERS_CALLBACK 2、已标注 REFERENCES 8、UNRESOLVED 6；这批标注内 FP/FN 均为 0。
- `npm run test:browser`：20 项通过，覆盖阅读、图谱、源码、Git 影响与响应式核心流程。
- `npm run validate:monorepo`、固定源码对照及当前 Codex MCP 自验均通过，旧新路径的源码版本与哈希核对通过。
- `npm run release` 和 `npm run verify:release` 通过：0.4.0 包解压到工程之外的中文空格目录，清除 NODE_PATH/NODE_OPTIONS 后验证 5,693 个文件校验值、CLI、Windows 启动器、六个 MCP 工具、接入包生成、Git 影响及真实浏览器旧版源码流程；页面外部请求为 0。未在解压目录安装依赖或构建。

本地候选包：`artifacts/releases/build-uFuO4a/codetrail-mvp-0.4.0-win32-x64.zip`，23,592,507 字节，SHA-256 `bfff3a4748365b401dc17ffde878dd88004cb609b59b1cc5b781f2a2ec4b5c78`。包与原始验收产物被 Git 忽略，提交包含源码、回归与记录；未创建 GitHub Release。

现有已知限制保留：最多 64 个配置、仅根目录内扫描；重复包名、输出冲突和无法唯一归属的配置给出诊断；不支持 pnpm/Yarn 专有解析和自定义打包映射。动态调用、任意数据流、外部实现与跨根代码仍有缺口。
