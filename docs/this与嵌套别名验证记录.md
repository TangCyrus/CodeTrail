# CodeTrail 0.8.0：this 绑定与嵌套对象别名

日期：2026-11-09。沿用 [TanStack Store 固定提交](https://github.com/TanStack/store/tree/53f30be1e43c8d7899ace08023705b34f5e533f8)、Windows 11、Node.js 24.20.0、TypeScript 5.9.3 和上一轮锁定的真实依赖声明。目标源码与上游脚本不执行，依赖版本和扫描范围不调整。基线为 [0.7.0 对象分发验证](对象分发验证记录.md)。

## 支持范围和拒绝条件

封闭的 const 对象字面量树可沿内联子对象、父对象别名、子对象别名和简单对象解构追踪实际方法；对象自有方法及普通函数属性内的 this 可关联到所属对象，箭头函数继承词法 this，支持方法内 `const self = this`。逐父子路径检查写入和暴露，不以同名接口实现推测目标。

成员或父路径写入保留 `member-written`；未知传参、返回和存储保留 `receiver-escaped/nested-escaped`；方法提取或未支持的重绑定保留 `method-detached`。共享子对象、动态属性、getter/展开、默认值/rest、共享普通函数的动态 this、原型改写、参数和类接收者继续保留缺口。不同工厂调用不共享一个全局 this；能确认某次返回对象的方法，并不意味着能为方法体跨实例固定接收者。

标准库 bind 追踪唯一、私有且未观察到写入/未知暴露的源码函数，支持绑定结果的 const 别名及唯一同步直接返回的绑定工厂。只在绑定结果被调用时补函数体调用，创建绑定不算执行。call/apply 可补充到原函数体的调用，但原有标准库外部引用仍保留。绑定箭头函数不替换词法 this，也不根据绑定参数给普通函数体全局补 this 目标。

观察到内建绑定方法改写、Function/prototype 未知暴露、可变绑定或不明确来源时拒绝补边。构造调用、Proxy/eval、原型反射和扫描范围外的内建方法改写未建模。调用关系是有界静态结构，不能证明运行时行为、上游测试执行或覆盖率。

调用边保留 `resolution: value-origin` 和 `supportingEvidenceIds`；拒绝原因沿用 `reasonDetail` 及源码证据。上限为 12 层来源/路径、128 个对象/别名和 1,024 个引用，缓存只在单次分析内有效。嵌套方法显示名称可能省略非函数属性层级，以节点 ID、准确声明位置和证据区分同名方法。

## 实跑与验收方法

通过固定根目录的本地 stdio MCP，先在未改动的真实源码上刷新快照，再完成架构搜索、阅读顺序、缺口原因取证、元数据过期检查和 Git 双快照分析。临时把 `effectScopeOper` 的清理语句改写为内联 `cleanup.state`、子对象 const 别名和 `reset → this.clearFlags()`，验证同侧两跳调用路径；finally 按原字节恢复源码及工作区元数据，并检查 Git 工作区干净。

临时样例用于验证新能力，不计入原始源码的缺口减少。HEAD 不复用工作区未提交依赖；两侧诊断和环境差异继续保留。来源、调用点和旧新源码按 snapshotId、comparisonId/side、文件 SHA-256 及原文切片核验。

首次实跑暴露私有函数 `.name/.length` 的标量读取被误判为函数暴露，已修正；另一次比较触及原有 60 秒期限，失败不计通过。CPU 采样定位到编译器重复工作区路径转换，改为分析内缓存不变的路径映射和预计算虚拟父目录，保留文件读取及范围检查，不延长期限。

## 同源码结果

213 个文件的路径和 SHA-256 与 0.7.0 完全一致，符号仍为 4,252 个。关系 13,146 → **13,148**；兼容未连接总数仍为 8,506，其中正常外部引用 **6,471**、真实缺口 **2,035**。dynamic 667、unsupported 931、unresolved 434、ambiguous 3 均未改变。诊断仍为 99、语法错误为 0，状态仍为 partial。

新增的两条 CALLS 均来自 `packages/store/src/signal.ts`：74 行 `unwatched → effectScopeOper`、348 行 `effectOper → effectScopeOper`，由原生 `.call` 到唯一私有源码函数体的来源确认。对应标准库调用仍是正常外部引用，**没有将任何原始缺口计作已消除**。全部既有调用保留，无新增缺口位置；17,493 份证据通过完整文件哈希和原文切片核验。

`atom.ts:182` 的 atom.get 保留 `member-written`，MCP 实际读取的依据仍指向条件重写 `atom.get = function`；195 行的 e.stop 从笼统的 object-this 更新为 `receiver-escaped`，因为所属对象存在未验证暴露。参数和类接收者也仍保留缺口，不能因为新增 this 规则就固定到某个实例。

## MCP 和性能实证

最终通过目录为 `artifacts/external-monorepo/acceptance-RxWIck`：59 次工具调用，最大返回 30,621 字符；普通快照 `snapshot:74e47171bef53646e5accf1e`，比较 `comparison:9eb70f2e924b94676b354b5c`。HEAD 侧 `baseline:9aa09e2b30774a9bb4f7ff64`，当前受控样例侧 `snapshot:60a3b210191c9a92c88c773b`，旧新状态均为 partial。

旧新 `effectOper → effectScopeOper` 路径均经 MCP 返回并逐证据读取。受控样例 `effectScopeOper → cleanup.reset → cleanup.clearFlags` 的两步调用在保存的 current 图中确认，再通过同一 comparisonId/current 读取全部调用与来源证据。主影响列表 `truncated: true`、100 路径，没有返回此受控链路；分页不能解除总上限，不能宣称这条链路已出现在影响列表中。

signal.ts 原文 SHA-256 为 `6d930397e6287d466aa070851d4dbcd30de1fcce63658c75ca81adffe8f7f07d`，受控样例为 `788a22c844b8117fc92e90dec5a3b41567f6ddfc14ab1eb4cb20d97bc7c8c433`；最终 Git 检查确认克隆恢复干净。

最终普通刷新墙钟 18.274 秒（分析器统计 14.667 秒），双快照请求 25.287 秒；此前优化后复验的双快照为 38.818 秒，均小于原 60 秒期限。计时包含本机环境与其他本地检查的影响，不是稳定性能保证。独立对照确认优化前后 files、symbols、relations、unresolved、diagnostics、evidence、configuration、status 逐项完全一致：对应分析时间 45.352 → 18.138 秒；没有降低诊断、范围或关系数量。

## 回归与自验

`npm run check` 的 132 项 Node 测试和人工标注样例校验通过；浏览器 23 项通过，包含新增 this 调用来源、方法提取缺口及原因源码导航。负例覆盖父/子路径和解构写入、未知暴露、普通回调 this、原型改写、共享方法、工厂实例隔离、绑定方法覆盖及箭头词法 this。

CodeTrail 自身 59 个源码文件、4,372 个符号，状态 complete、0 诊断、0 语法错误；三条既有跨包核心调用和全部证据校验通过。当前宿主 MCP 也实际刷新，固定 `snapshot:13cba7ae3521a3550c30da7d`，再以 `comparison:95244be52e823a012c358fa6` 比较 HEAD/工作区并读取同侧证据；当前 complete，HEAD partial，影响列表到达 100 路径上限，不能宣称完整影响覆盖。

隔离配置下 Codex CLI 0.167.0-alpha.3.2 app-server 复验了六个工具、两个 Skill、理解/取证/阅读流程、HEAD 旧侧证据及编辑过期/刷新流程，结果通过；无模型生成。日志在 `artifacts/receiver-aliases`，宿主结果在 `artifacts/agent-acceptance/codex-inYy2i`。这不是模型语义解释效果或真人理解效率评测。

复现（需先按依赖准备文档生成专用克隆及声明）：

```powershell
npm run check
npm run test:browser
npm run validate:monorepo -- --out artifacts/receiver-aliases/self.json
npm run validate:external -- --receivers --baseline artifacts/receiver-aliases/before.json
node scripts/validate-resolution-reduction.mjs --before artifacts/receiver-aliases/before.json --after "<本次验收目录>/snapshot.json" --expect-external-unchanged --allow-unchanged --out artifacts/receiver-aliases/reduction.json
npm run release
npm run verify:release
```

`before.json` 是本地留存的 0.7.0 已准备声明快照，不是仓库自带文件；重新生成时必须使用相同上游提交、声明、范围与旧版分析器。产物默认忽略，不随源码提交；本记录保存验收口径与结论。
