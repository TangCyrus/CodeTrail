# CodeTrail 0.4.1：TanStack Store 真实 monorepo 验收

日期：2026-11-06。环境：Windows 11、Node.js 24.20.0、npm 11.19.0、Git 2.55.0；CodeTrail 使用 TypeScript 5.9.3。

## 项目与范围

项目为公开的 [TanStack Store](https://github.com/TanStack/store)，固定提交 [53f30be1e43c8d7899ace08023705b34f5e533f8](https://github.com/TanStack/store/tree/53f30be1e43c8d7899ace08023705b34f5e533f8)。它具有状态核心、多种框架适配器、示例、真实测试、独立 tsconfig 和 pnpm 工作区；本次使用完整仓库根目录，不添加范围忽略文件。

纳入 213 个 `.ts/.tsx/.js/.jsx` 文件，低于默认 500 文件上限。未安装、构建或运行外部项目及其测试；外部依赖缺失、`.vue/.svelte` 等未支持源码均属于本次验收边界。目标仓库声明 TypeScript 6.0.3，本次结果由 CodeTrail 的 5.9.3 解析器生成，不宣称完整类型兼容。

通过官方 MCP 客户端实际启动 CodeTrail stdio 服务，按两个 Skill 的工作流调用六类工具；固定快照/比较 ID，检查过期和截断，读取保留源码。调用选择由验收脚本完成，模型调用数为 0；本次不评估模型自主选工具和真人理解效果。

## 实跑暴露并修复的问题

1. **Windows Git 基线读取过慢。** 原实现逐文件启动 `git cat-file`，真实仓库的 MCP 比较在 60 秒时未返回。改为一次 `git cat-file --batch`，按对象 ID、类型、精确字节数逐个解析响应；源码中的换行和伪头部不参与协议切分。继续限制 2,000 文件、64 MiB、单文件 1 MiB、Git 子进程 15 秒；不使用 filters、textconv、外部 diff 或目标脚本。单次分段测量中，587 个 Git 清单条目的检查约 189 ms，候选基线物化约 131 ms，两侧解析约 22.4/17.5 秒；不将这些本机单次数字外推为通用性能。
2. **pnpm 元数据未被识别或用于快照失效。** 现在只读解析根 `pnpm-workspace.yaml` 的 packages 字面量列表，按 pnpm 规则优先于 npm workspaces，支持常用相对 glob 和排除模式；文件内容及缺失探测进入快照输入，历史基线也保留该文件。使用锁定的 YAML 2.9.1 解析器，不扩展包列表别名、不执行配置；其他安装/构建设置不作为指令。
3. **匿名错误回调被误列为入口。** 原阅读顺序把 `examples/angular/*/src/main.ts` 中 `.catch((err) => console.error(err))` 的匿名回调放在入口首位。入口候选现在排除解析器生成的匿名回调名称，保留命名入口和真实静态跟随关系；推荐算法版本更新为 `structural-reading-2`。

批量物化修复后的复验仍出现过 60 秒取消，均未计为通过。随后在每次分析内增加按编译选项隔离的 TypeScript ModuleResolutionCache，并缓存重复的目录与缺失路径探测，减少多个编译环境反复查找同一位置的开销；不同 paths 与 import/require 条件仍各自解析，不在快照间复用缓存。根目录内的缺失探测位置进入快照输入，安装依赖声明后会过期；文件读取仍受真实位置边界与扫描范围限制。旧新证据与固定语料继续核对，没有通过调高服务时限或删除源码规避失败。

## 代码理解与证据

源码观察与协议核对的阅读主线如下；这是阅读建议，不表示运行时顺序：

- 从 `packages/store/src/index.ts` 查看核心导出面，再读 `store.ts` 的 `createStore`/`Store`。`Store` 的构造逻辑调用 `atom.ts` 的 `createAtom`，状态读写委托给 atom。
- `atom.ts` 的 `createAtom` 实现状态、订阅等逻辑，使用 `alien.ts` 的响应式基础设施。动态回调和解构别名仍有缺口，不把缺失调用补成确定路径。
- `packages/react-store/src/useCreateAtom.ts` 在 React hook 中调用核心 `createAtom`，`useSelector.ts` 对接订阅接口。此包通过自己的 tsconfig paths 指向核心源码；即使 React 声明缺失，也能核对这部分静态跨包结构。
- `packages/store/src/shallow.ts` 为比较函数；Preact 包测试通过适配器重导出使用它。验收读取了调用方 `packages/preact-store/tests/index.test.tsx:793` 的 CALLS 证据，保留原文 `shallow`、UTF-16 偏移及 SHA-256。

这些源码可在[固定提交](https://github.com/TanStack/store/tree/53f30be1e43c8d7899ace08023705b34f5e533f8/packages)核对。搜索、邻域、阅读推荐及源码读取均成功；元数据探测只追加注释，固定快照立即变为 stale，恢复原文件后恢复有效。

最终成功记录为 `acceptance-pxE4yx`，共 28 次 MCP 调用，最大单次结果 31,546 字符。概览快照 `snapshot:3ee6a9e6143d456bbe6999b1`，当前阅读首项为核心 `createStore`；概览约 14.7 秒，完整影响分析约 45.5 秒。此前一轮包含缺失探测缓存的验收也完成了约 52 秒的比较；耗时存在明显负载波动，不能保证任意机器都在同一预算内完成。

## 受控改动影响

仅在工具专用克隆里将 `shallow.ts` 的 `if (Object.is(objA, objB))` 临时替换为 `if (objA === objB)`，用来触发函数体变化。它是验收探针，不是提交给上游的修复。

改动报告应只包含一个修改文件和一个变化符号。base/current 独立追踪到跨包测试调用方；读取路径证据与变化声明，分别核对快照 ID、文件哈希、片段和旧新判断条件。旧声明 `matchesCurrentFile=false`，新声明为 true。对协议产生并保存的两侧快照，还逐条检查全部证据的源文件哈希与原文偏移。

最终比较 `comparison:e20d0190cd32118a006a1c5e` 对应 base `baseline:6e335cd48710464a17f85dc0` 和 current `snapshot:3da9a94af1b1449b405d384c`。上文 Preact 调用位置在两侧分别取证，文件哈希均为 `e7cb7d50ae15a4d2fbb695a20590d53eadb0c0d8b11e55123b256a8f88a5e23c`，不跨版本拼接步骤。

本次返回 100 条路径，涉及 13 个潜在关联测试文件，达到路径总上限并明确标记截断。分页不能解除这个上限；文件级导入路径较保守，13 不等于实际覆盖数，也未声称外部测试通过。所有受控源码及 pnpm 注释在 finally 中恢复，并核对外部 Git 工作区干净。

## 同源码结果与限制

修复前后固定的 213 文件路径及 SHA-256 完全一致：均为 3,899 符号、11,770 关系、9,525 未解析、1,042 条诊断、状态 partial，语法错误为 0。本轮没有降低同语料未解析数量，改善集中在可用性、配置失效和阅读入口。

其中仍有未安装的 React/Angular/Vitest 等声明，以及仅指向未构建 dist、缺少唯一编译输出映射的工作区入口。pnpm 包身份不能替代缺失的构建布局；不会按 src/index 惯例猜边。受控改动后报告的 9,522 未解析由删除 `Object.is` 使用产生，不能计作解析器改善。

更大项目或资源竞争仍可能超出服务 60 秒时限；保持取消与降级，不以提高时限作为本轮修复。总体准确率、团队使用效果和外部项目行为测试仍未测得。

## 工程回归

- `npm run check`：101 项测试通过、0 失败，原关系金标准全部通过。新增回归覆盖 pnpm 选择/失效/非法数据/边界、批量 Git 的 Unicode/CRLF/空文件/重复对象/二进制和编码拒绝/取消、匿名回调入口，以及安装依赖声明后的失效检测。
- `npm run test:browser`：最终实现的 20 项流程全部通过。
- `npm run validate:monorepo`：CodeTrail 自分析通过，55 文件、3,433 符号、14,122 关系、7,816 未解析、0 诊断，状态 complete 且未过期；三条真实跨包调用与全部源码证据核对通过。complete 仍不代表没有静态图缺口。
- `npm run validate:external -- --baseline artifacts/external-monorepo/before.json`：六类工具、元数据失效、阅读规则、分页、双侧取证和恢复均通过，固定源码哈希一致。

发布包的独立解压验证结果由 `npm run verify:release` 写入 `artifacts/releases/verification/release-smoke.json`；该验证另行核对 CLI、六个 MCP 工具、Git 和真实浏览器流程。

## 复验

以下命令需要在已安装开发依赖的 CodeTrail 源码目录运行；预编译包不包含验收脚本。准备专用克隆并固定提交，不能使用包含个人修改的工作区：

```powershell
git init artifacts/external-monorepo/tanstack-store
git -C artifacts/external-monorepo/tanstack-store remote add origin https://github.com/TanStack/store.git
git -C artifacts/external-monorepo/tanstack-store fetch --depth 1 origin 53f30be1e43c8d7899ace08023705b34f5e533f8
git -C artifacts/external-monorepo/tanstack-store -c core.autocrlf=false checkout --detach FETCH_HEAD
npm run validate:external
```

已有其他专用克隆可传 `--project`；脚本要求 HEAD 与上述提交相同、Git 工作区干净。可选 `--baseline` 接收同一外部源码由旧版产生的完整快照，逐项验证语料一致性。脚本不自动下载项目或安装其依赖。

原始协议记录、固定快照、两侧证据及恢复断言保存在 `artifacts/external-monorepo/acceptance-*/`，入口索引为 `latest.json`。外部仓库和原始产物被 Git 忽略，提交包含修复、缩小后的回归用例、复验脚本及本记录。
