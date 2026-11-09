# CodeTrail 0.10.0：Git HEAD 的依赖声明环境

日期：2026-11-09。基线为 CodeTrail `854a75abed6f52053c657101635ea1680febc0bd`，外部项目仍为 [TanStack Store 固定提交](https://github.com/TanStack/store/tree/53f30be1e43c8d7899ace08023705b34f5e533f8)，沿用此前准备的真实声明。环境为 Windows、Node.js 24.x、TypeScript 5.9.3。上一轮见 [路径聚焦验证](路径聚焦验证记录.md)。

## 来源与隔离

先捕获工作区分析，再从其实际读取的依赖声明/JSON 集合中选择可复用文件。安装包名称及版本需可确认，包身份须同时匹配 HEAD 和工作区锁文件的版本/完整性等记录；文件字节哈希须与捕获时一致。只复制普通声明和 JSON 到工具自己的 HEAD 临时目录，不复制 JS/TS 运行时实现、工作区源码或生成声明来替代历史项目源码，不运行安装、构建或目标脚本。

HEAD 项目源码及配置仍只来自 Git 普通 blob，旧新两侧独立解析、保存源码与证据。声明来自当前本地安装，**不是历史 node_modules 重建，也不是包压缩包完整性验证**。相同版本/锁身份不能证明本地安装从未被修改；这里固定的是本次实际使用的声明内容。旧版独有依赖、条件导出或未支持布局仍可能造成缺口，不按名称猜测实现，也不跨侧拼接调用链。

支持 npm lock v2/v3 和最多八个文档的 pnpm lock v9。TanStack Store 的同一锁文件包含包管理器与工作区文档，单文档原型曾拒绝复用；现在有界读取全部文档，重复包身份仍拒绝选择。锁文件缺失、身份/捕获哈希不一致、目录链接与 pnpm 链接布局等保留原因。每次最多 4,096 个文件、32 MiB，单文件及锁最多 1 MiB；先验证包子集，再暴露给基线编译器。写入失败不发布比较，取消/完成仍清理临时目录。

新增 `baselineDependencies` 记录策略、state、文件/字节/包计数、跳过原因、最多八个包样例及省略计数。available 只表示捕获集合核对通过；partial/unavailable 明确保留失败，not-captured 表示当前分析没有可捕获集合，不代表 HEAD 不需要依赖。浏览器既有“分析边界与未解析项”展示数量及来源说明，MCP 和配套 Skill 同步支持。私有验证输入保存在比较 bundle，不把大量依赖内容塞进 MCP 返回。

包锁、声明或元数据变化会使比较过期，已保存的旧新源码证据不被替换。基线身份包含捕获环境摘要，两侧诊断继续独立报告。另修正 TypeScript 自身 API 声明的捕获：项目内导入的 typescript.d.ts 属于依赖输入，编译器全局 lib.*.d.ts 仍由分析器提供。

## CodeTrail 自验

最终运行 `artifacts/head-dependencies/self-J5ljg2`，使用 C 盘独立缓存，覆盖当前 Codex 与项目位于不同磁盘的场景。正式 MCP 比较 `comparison:7c8730ce011eef275f9a7cd0`，旧侧 `baseline:44b7894b3fe49ead728de7ac`，当前受控侧 `snapshot:c5324f1ad397a4349b114377`，14 次工具调用，双快照请求 15.973 秒。

HEAD 与旧版对照的 **59 文件、4,496 符号、逐文件 SHA-256 完全一致**：

- 诊断 **581 → 0**，状态 partial → complete；语法错误仍为 0。
- 关系 **16,751 → 19,196**；未连接总数 **11,540 → 9,103**。
- 2,437 个未连接位置成为静态关系：**34 调用、2,354 引用、49 导入**；另增加八条静态引用。既有调用全部保留，无新增未连接位置。
- 正常外部引用 **3,234 → 8,485**，真实缺口 **8,306 → 618**。缺口下降中包含缺失依赖被正确识别为外部引用，不能全部称为调用修复。

复用 50 个包的 558 个声明/JSON 文件，共 6,955,693 字节，未跳过输入。旧新两侧均实际返回并取证 `MCP 处理函数 → ComparisonManager.report → calculateComparisonImpact` 两跳链；此前旧侧只能返回同文件的 compareSnapshots 调用。通过函数内临时注释区分新旧源码，finally 按原字节还原；不执行目标函数，不修改 Git。

逐文件哈希与原文切片核验了旧侧 **26,196** 份、当前受控侧 **27,184** 份证据。未改动的当前 0.10.0 源码为 **60 文件、4,682 符号**，complete、0 诊断、0 语法错误；既有三条跨包核心调用与全部证据校验通过。当前源码与旧 HEAD 版本不同，不能把两侧总体统计差异全归因于依赖环境。

## TanStack Store 复验

最终运行 `artifacts/external-monorepo/acceptance-Pznalp`：65 次正式 MCP 调用，最大返回 30,815 字符。普通快照 `snapshot:dfa9b705a0a6f4473bee8551`；比较 `comparison:725137bca9af2c76cf9edf50`，旧侧 `baseline:bff9d930f23c374f77f52dcd`、当前受控侧 `snapshot:83b164d77c7ab5af802bc9cf`。双快照 27.986 秒，维持原 60 秒期限；这不是所有仓库的性能保证。

HEAD 两次对照的 **213 文件、4,252 符号、逐文件哈希完全一致**：

- 诊断 **959 → 137**，仍为 partial；语法错误为 0。
- 关系 **13,106 → 13,148**；未连接总数 **8,548 → 8,506**。
- 补回 **5 条调用、37 条引用**，既有调用全部保留，无新增未连接位置；17,493 份证据完整核验。
- 正常外部引用 **869 → 6,380**，真实缺口 **7,679 → 2,126**。同样区分真实关系补齐与外部引用分类恢复。

复用 66 个包、717 个声明/JSON 文件，共 7,693,799 字节。14 个包共 94 个输入未通过锁身份核对，保留 lock-identity；样例包括 @babel/parser@7.29.13、@testing-library/dom@10.4.2、lit-html@3.3.3。之前的声明准备采用独立 npm 传递依赖锁，不等于上游完整 pnpm 安装；本版不因为它们已经存在就假定属于 HEAD。

正常工作区仍为 99 诊断、2,035 缺口、6,471 外部引用；其原始源码与普通解析统计不变。受控样例当前侧为 99 诊断、4,256 符号、13,158 关系，与原始快照分开统计。旧新 effectOper → effectScopeOper、嵌套别名/this 两跳链及条件重写 atom.get 的拒绝依据继续经正式聚焦接口取证。两侧都保留 partial 与影响路径截断提示，finally 确认克隆恢复干净。

## 回归和复现

143 项 Node 回归与人工标注样例校验通过，24 项浏览器回归通过。覆盖包锁/安装版本/声明哈希不一致、缺锁、链接与越界路径、复制预算、多文档锁及歧义身份、HEAD 独有依赖继续缺失、依赖变化过期、旧新源码保留、项目内缓存和取消清理。浏览器测试修正刷新后未等待页面就绪的竞态，没有延长超时或降低断言。

Codex CLI 0.167.0-alpha.3.2 app-server 隔离验收通过，发现 MCP 0.10.0、六个工具和两个 Skill，并验证依赖来源字段、聚焦与旧侧证据；不启动模型生成。记录在 `artifacts/agent-acceptance/codex-TfQZiL`。Skill 的本机 Python 检查器缺少 PyYAML，使用项目已装 YAML 解析器核对 frontmatter、命名与占位符约束。

源码安装后复现（外部项目须先按既有依赖准备文档生成专用克隆）：

```powershell
npm run check
npm run test:browser
npm run validate:baseline
npm run validate:monorepo
npm run validate:codex
npm run validate:external -- --receivers --baseline "<0.9.0 普通快照>/snapshot.json"
node scripts/validate-resolution-reduction.mjs --before "<旧 HEAD 快照>" --after "<新 HEAD 快照>" --sources "<保存的 base-sources.json>" --allow-unchanged --out artifacts/head-dependencies/recovery.json
npm run release
npm run verify:release
```

旧基线及产物不随源码提交。HEAD 对照应使用保存的旧侧源码核验，不读取已修改工作区冒充旧原文。available/complete 都不是运行时正确性、测试覆盖率或完整图谱的证明；仍需固定 comparisonId/side 并检查过期、诊断及截断。
