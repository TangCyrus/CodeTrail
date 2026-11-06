# CodeTrail

为 Coding Agent 提供带源码证据的项目架构、符号关系和改动影响，帮助开发者理解并核实 Agent 的判断。

当前 CLI 命令名为 `codetrail`，内部包使用 `@codetrail/*` 命名。

从旧版本升级时，命令、MCP 服务名、Skill、环境变量及忽略文件需要一起切换，见 [0.3.0 迁移说明](docs/命名迁移说明.md)。

当前为 **0.3.0 本地 Agent 接入试用版**：提供六个 MCP 工具、理解项目与改动影响两个 Skill，复用已有 TS/JS 解析器、阅读推荐与 Git 双快照。首个验收宿主为 Codex，浏览器工作台可独立使用或共享 MCP 快照。真实用户效果和模型自主调用、语义解释质量仍待验证。

Agent 接入见 [Agent 接入说明](docs/Agent接入说明.md)，独立工作台见 [MVP 安装说明](docs/MVP安装说明.md)，能力边界见 [已知限制](docs/已知限制.md)。Windows 0.3.0 预编译 ZIP 包含 MCP、Skill 和生产依赖；需本机 Node.js 24.x，Git 用于可选的改动比较，无需重新 npm 安装或构建。历史 0.1.0 ZIP 不含 Agent 接入功能。

## 接入 Agent

源码完成下方构建后，或在 0.3.0 预编译包根目录，生成接入包：

```powershell
node scripts/setup-codex.mjs "D:\你的项目" --out "D:\CodeTrail接入包"
```

按 [接入说明](docs/Agent接入说明.md) 合并生成的 Codex 配置、安装两个 Skill，再通过 `$codetrail-understand` 或 `$codetrail-impact` 使用。生成器不会修改现有用户配置。宿主直接启动 stdio 服务，日常无需手动另开 CLI；加 `--workbench` 可提供同快照的本地证据页面。

CodeTrail MCP 自身不调用模型；工具返回的源码片段会进入宿主上下文，其数据发送遵循宿主配置。

## 本地运行

前提：Node.js 24.x、npm 11+。改动比较另需本机 Git。当前验证环境为 Windows 11、Node.js 24.20.0、npm 11.19.0、Git 2.55.0.windows.5。

在项目根目录执行：

```powershell
npm ci --ignore-scripts
npm run build
npm run open -- fixtures/reference-lab
```

也可直接浏览两个代表样例，或创建全新的 Git 别名演示：

```powershell
npm run open -- examples/react-checkout
npm run open -- examples/ts-inventory
npm run demo:git
```

Git 演示命令在 `artifacts/demo-projects` 下创建自己的新仓库，输出启动目录；原始 `examples/git-alias` 是未初始化的基线模板。样例业务代码不需要执行。

分析自己的项目时，替换目录即可，带空格的路径用引号包裹：

```powershell
npm run open -- "D:\你的项目目录"
```

服务默认监听 `127.0.0.1:4317`，启动后自动打开浏览器。请使用终端输出的完整会话链接；凭证位于链接片段中，前端读取后会从地址栏移除。同一浏览器标签页刷新后仍可使用本次会话。按 Ctrl+C 停止服务。

常用启动选项：

```powershell
npm run open -- fixtures/reference-lab --port 4400 --no-browser
npm run open -- fixtures/reference-lab --port 0 --data-dir artifacts/local-cache --no-browser
```

`--port 0` 自动选择空闲端口；`--no-browser` 只输出链接；`--data-dir` 指定工具自己的缓存基目录。默认缓存位于 Windows 用户的 `%LOCALAPPDATA%/CodeTrail/cache`，按项目路径隔离，保留最近三份不同内容的快照。缓存包含所分析文件的完整源码。浏览器只能分析 CLI 已选择的目录，不能通过 API 切换到任意路径。

工作台操作：

- 点击模块或文件可查看详情，双击图谱节点或使用侧栏按钮进入下一层。
- 使用面包屑和返回按钮切换范围；Ctrl/Cmd + K 聚焦全局搜索，方向键和 Enter 选择结果。
- 图谱与列表提供等价导航；类型引用、一般引用和回调候选可分别控制。
- 点击连线或“证据”查看实际代码位置，再跳到带精确高亮的源码。
- 界面定期检查输入是否变化，过期后保留旧图谱和旧源码；点击“刷新分析”生成新快照。分析期间可取消，也能继续阅读上一份结果。
- 手机默认使用列表，目录与源码分别以单个区域展开；仍可切换只读图谱并缩放、平移。
- 打开“阅读导览”，查看入口、功能链路与公共基础候选。展开“为什么推荐”核实结构线索，点击符号在侧栏阅读，或在图谱中展开。
- “推荐顺序”沿已解析的调用与组件关系提供最多 10 步阅读建议。它不是运行时执行顺序；补充条目会明确标注。
- 从推荐条目或源码侧栏加入阅读清单，在“我的清单”标记已读。进度保存到本机，刷新和重新启动后仍可读取。
- 选择节点后打开“解释”，可切换解释代码、结构重要性、上下游三类问题，以及引导/紧凑两种阅读密度；本地事实始终可用。

## 配置按需 AI

在启动工作台的 PowerShell 中设置服务端环境变量，再启动服务：

```powershell
$env:OPENAI_API_KEY = "替换为你的 API Key"
$env:CODETRAIL_OPENAI_MODEL = "替换为支持 Responses 结构化输出的模型 ID"
npm run open -- fixtures/reference-lab
```

模型需在你的账户中可用，并支持 Responses API 的 JSON Schema 结构化输出。首版要求明确设置模型，不预选可能退役或不可用的模型。也可使用 `CODETRAIL_OPENAI_API_KEY`，其优先级高于 `OPENAI_API_KEY`。程序直接读取进程环境变量，不自动加载 `.env`。

在节点的“解释”页启用本项目的按需 AI，核对文件清单和展开的源码片段，再点击“发送以上片段并用 AI 解释”。每次服务启动默认关闭 AI；配置、启用、搜索和阅读操作本身均不会发起模型请求。密钥由本地服务读取，浏览器不输入、不保存密钥。

默认请求地址为 `https://api.openai.com/v1/responses`。发送内容包括所选节点的相对路径、签名、本地事实及选定证据片段；片段取自当前快照，截断位置可见。上下文最多 18,000 个字符、12 段证据，默认输出上限 3,200 tokens、超时 30 秒、同时最多 2 个请求。字符数是上下文 JSON 的长度，不是 token 估算，也不包含固定系统指令。

每条 AI 说明必须引用当前发送范围内的有效证据 ID。引用校验不证明解释语义正确，界面将 AI 说明、推断和本地事实分别标注。引用失效、输出不完整、服务错误、超时或取消时保留本地说明；取消也会中止上游请求，已产生的服务端用量仍由供应商计费。

AI 结果按快照、上下文、问题、阅读密度、模型、端点及提示版本缓存在本机 SQLite 中。同一上下文可复用；“有误”反馈会移除该条缓存，“清除本项目的 AI 解释缓存”可删除解释结果。缓存含源码片段和模型输出。

可选的 `CODETRAIL_OPENAI_REASONING_EFFORT` 支持 `minimal/low/medium/high`，仅在所选模型支持对应值时设置。`CODETRAIL_OPENAI_BASE_URL` 可覆盖服务端地址，必须使用 HTTPS；环回 HTTP 仅用于受控本地测试。接口格式依据 [OpenAI Structured Outputs 官方指南](https://developers.openai.com/api/docs/guides/structured-outputs)。

## Git 改动影响

启动一个已有 Git 仓库或其子目录：

```powershell
npm run open -- "D:\你的 Git 项目目录"
```

打开“改动影响”，点击“比较当前改动”。比较口径固定为 **当前 HEAD 提交与工作区实际文件内容**，包含已暂存和未暂存修改，范围内的未跟踪源码另标“未跟踪”。选择子目录时只比较该目录，不扩大源码范围到仓库其他位置。工具不会为目标项目初始化 Git、提交、切换分支或安装依赖。

- “变更清单”显示新增、修改、删除、重命名候选及解析范围变化。展开条目可查看改动行范围、签名/导出/实现变化，以及旧新版声明。
- “关联路径”分别遍历两个版本的调用、组件使用、符号引用和文件导入，默认最多两跳、共 100 条路径；达到限制会提示截断。路径保留真实引用方向，每一步均可点击源码依据。
- 删除或断开的关系使用旧版，新增关系使用新版，不拼接跨版本的调用链。宽屏默认在侧栏打开首个变化文件，手机通过“旧版源码”“新版源码”或路径依据进入。
- “包含纯类型依赖”单独开启类型传播。文件级导入是保守关联，不表示导入者使用了变化的具体符号。
- “相关测试”要求存在静态关联路径，按 `tests/`、`__tests__/`、`.test/.spec` 等路径识别测试文件；不运行测试，也不表示覆盖率或执行成功。

符号在已配对文件中按完整名称和种类唯一映射，行号或节点 ID 变化不会直接视为新增/删除。符号改名和歧义不强行合并。文件重命名提示来自暂存区 Git 相似度或唯一原文内容匹配；未暂存且内容变化的移动可能显示为删除和新增。仅换行编码变化不计为代码变化，保留源码和位置仍对应各自的原文。

结果使用独立 Worker 生成，可以取消并重试，取消时保留上一份结果。界面每 8 秒检查工作区与 HEAD；变化后保留旧结果和两侧源码，点击“重新比较”才更新。SQLite 按项目保存最近 3 份比较，包含两个版本的完整纳入源码，与普通分析快照分别保留。

无 Git、Git 不可用或仓库尚无提交时，显示缺少基线的原因；仍能列出当前源码，但不生成完整历史影响。部分解析、忽略规则变化、大小限制和配置差异会在“分析边界与未解析项”中说明。潜在关联不能证明实际故障，也不能证明未列出的代码不受影响。

HEAD 通过只读对象命令读取，历史文件写入工具自己的临时目录进行解析。不会检出目标项目，也不执行 Git clean/smudge、textconv、外部 diff 或 fsmonitor 配置。重命名提示仅比较 HEAD 与暂存区对象；工作区实际内容始终由解析器读取。具体依据见 [第四阶段验证记录](docs/第四阶段验证记录.md)。

## 导出 JSON

直接运行编译后的 CLI，可获得纯 JSON 标准输出；摘要写入标准错误：

```powershell
node apps/local/dist/cli.js analyze fixtures/reference-lab
npm run analyze -- fixtures/reference-lab --out artifacts/reference-lab.json
node apps/local/dist/cli.js --help
```

参数支持 `--out <文件路径>`、`--max-files <正整数>`。默认分析最多 500 个源码文件，单文件最多 1 MiB；超过限制会返回部分结果和跳过原因。自定义单文件大小可通过分析器 API 的 `maxFileBytes` 设置。

CLI 成功输出结果时退出码为 0，即使结果状态为 `partial`；调用失败或参数错误为 1。自动化消费者应同时检查 `status`、`diagnostics` 和 `unresolved`。

## 验证

```powershell
npm run check
npm run test:browser
npm run benchmark
npm run release
npm run verify:release
```

`npm run check` 编译前后端、运行 70 项 Node 测试，并验证人工标注样例。`npm run test:browser` 使用已安装的 Google Chrome 运行 20 条流程，覆盖架构、阅读、AI/Git、三个代表项目、100 节点交互、布局超时/失败与源码重试；执行前先完成构建。也可分别执行 `npm test`、`npm run validate:fixtures`、`npm run validate:acceptance`。

`npm run benchmark` 在新进程中重复测量三个样例、100/500 文件合成项目和工具自身，另测 Git 双图比较；不执行目标代码，不清空操作系统文件缓存。原始样本、硬件、输入快照和预算结论保存到 `artifacts/phase-five/performance.json`。本机 500 文件/12,977 行的三次首次解析约 1.97–2.09 秒，缓存搜索/两跳查询 p95 约 16 毫秒；完整 Git 比较约 19.6–25.2 秒，不能把这些数值当作所有 500 文件项目的保证。

`npm run release` 根据锁文件在独立 staging 中离线安装生产依赖、物化工作区链接，生成 UTF-8 ZIP 和逐文件 SHA-256 清单；本地 npm 缓存不全时使用 `npm run release -- --online`。`npm run verify:release` 将 ZIP 解压到工程之外的中文空格目录，不安装或构建，验证 CLI、Windows 启动器、Git 比较和真实浏览器源码流程。最新包路径与校验值在 `artifacts/releases/latest.json`。

AI 自动测试使用环回地址上的模拟 Responses 服务和虚拟密钥，不访问真实 OpenAI，即使运行环境已有模型凭证。当前未进行真实模型调用或解释语义质量评测。

浏览器测试配置位于 `playwright.config.mjs`，可用 `CODETRAIL_BROWSER_CHANNEL` 切换已安装的浏览器渠道，例如 `msedge`。测试不会自动下载浏览器。

验证产物保存在 `artifacts/`，默认不纳入版本控制：

- `phase-one-validation.json`：逐类关系的 TP、FP、FN、样例诊断与分析耗时。
- `reference-lab.json`：正常项目的完整关系快照。
- `degraded-lab.json`：语法错误、缺失模块及被排除文件的降级快照。
- `phase-two/`：桌面、平板、手机工作台截图；浏览器失败诊断另存 `browser-test-results/`。
- `phase-three/`：推荐、顺序、清单、AI 结果/回退及三种宽度的截图；`design-check/report.json` 为九个页面状态的设计检查。
- `phase-four/`：Git 变化清单、路径、类型传播及旧版源码截图；设计检查位于 `design-check/`。Git 测试只在工具创建的临时仓库中初始化和提交样例。
- `phase-five/`：代表项目验收、性能重复样本、100 节点交互及独立安装包冒烟报告与截图。`releases/` 保存本地候选包，均默认不纳入版本控制。

固定样例与标注位于 `fixtures/`。其中 `IMPORTS`、`CALLS`、`RENDERS`、`REGISTERS_CALLBACK` 按样例的完整出现位置清单核对，`REFERENCES` 只核对 8 个明确标注的引用位置。指标表示这批样例与标注的一致性，不能当作真实项目的总体准确率。回调候选匹配也不表示回调已经执行。

## 工程组织

```text
apps/
  local/src/cli.ts          本地工作台启动与 JSON 导出命令
  local/src/server.ts       Fastify API、会话校验与静态资源
  local/src/analysis-*      Worker 与分析任务调度
  local/src/store.ts        SQLite 快照、源码保存与版本保留
  local/src/ai.ts           Responses 协议、引用校验、缓存与取消
  local/src/explanation-context.ts  有预算且可预览的证据上下文
  local/src/git.ts          只读 Git 元数据、对象读取与受限历史目录
  local/src/comparison-*   比较 Worker、任务、取消与过期检测
  web/src/                 React 工作台、React Flow 图谱与源码侧栏
packages/
  shared/src/index.ts      快照、文件、符号、关系、证据契约及完整性检查
  analyzer/src/index.ts    Compiler API 分析适配器与关系提取
  analyzer/src/compiler.ts 有边界的配置、声明和编译上下文读取
  analyzer/src/scan.ts     文件扫描、忽略规则、大小限制与哈希
  graph/src/index.ts       带路径证据的反向依赖遍历
  graph/src/explorer.ts    模块聚合、搜索、局部图及详情投影
  graph/src/reading.ts     可解释的结构推荐与受限阅读路径
  graph/src/comparison.ts  改动范围、旧新符号映射与分版本影响路径
fixtures/                  正常与降级样例、人工标注
examples/                  TSX、TS 模块、Git 别名三个代表样例
tests/                     分析器、图查询、CLI、API 和 SQLite 验证
tests/browser/             真实浏览器交互与响应式回归
scripts/                   标注比对与验证报告生成
docs/                      MVP 方案与阶段记录
```

## 当前解析能力

- 识别常规函数、箭头函数、方法、类、接口、类型、变量与参数，保留作用域和编译器生成的签名预览。
- 使用 TypeScript 符号身份解析导入别名、TS `paths`、转导出、同名与嵌套作用域、重载实现、常规方法和类箭头函数字段。
- 分开记录 `CONTAINS`、`IMPORTS`、`CALLS`、`REFERENCES`、`RENDERS` 和规则候选 `REGISTERS_CALLBACK`。
- 区分纯类型、值和混合导入，以及类型引用与值引用。类的 `extends` 作为值引用，`implements` 作为类型引用；这不是打包后的执行语义分析。
- 回调参数、`any`、联合类型歧义和无法解析的目标保留在 `unresolved`，并提供原因与可用候选。
- 每条关系包含文件哈希、代码片段、行列及偏移证据。行列从 1 开始，偏移和列使用 UTF-16，范围终点不包含在片段内。
- 输入内容决定快照标识；源码、读取的项目配置和依赖声明变化都会影响快照。分析结束前重新扫描文件清单并核对输入，检测到变化时标记 `stale`。

第三方声明只用于类型解析，不作为项目源码节点。外部引用仍记录为 `external`，因此 `complete` 表示本次分析过程没有错误或警告，不能理解为“没有未解析关系”或“调用图完整”。

## 分析边界

- 只扫描选定目录中有效 UTF-8 的 `.ts`、`.tsx`、`.js`、`.jsx`，保留 BOM；非法编码明确跳过。tsconfig 或 jsconfig 提供编译选项；其 `files/include/exclude` 不扩大或缩小原型扫描范围。使用 `.codetrailignore` 指定实际范围。
- 读取选定根目录及其子目录内的 `.gitignore`，另合并根目录 `.codetrailignore`。不继承选定目录之外的忽略配置。
- 强制排除依赖、构建目录和密钥环境文件；源码目录链接不参与扫描。允许读取所选根目录内的依赖声明，包括链接目标仍在根目录内的依赖；工具自身 TypeScript 标准库也可用于类型分析。
- 所选根目录之外的配置继承和依赖声明不读取，缺失内容会返回诊断。分析子项目时，不会隐式扩大到父目录或整个仓库。
- 原型使用一个编译上下文，不遍历 TypeScript 项目引用，不执行 Vite 配置，也不保证复杂 monorepo 的完整关系。普通静态调用不代表运行时必然执行，虚方法解析也不能替代运行时分发分析。
- CommonJS、动态 import 的模块关系、复杂解构绑定、构造器的独立调用节点、ECMAScript 私有方法和完整数据流不在本阶段支持范围。
- 匿名回调有独立的词法所有者；只把回调作为参数传入时，记录规则候选，不创建外层函数到回调的直接调用边。
- `traceDependents` 保留为单快照反向遍历；Git 比较由 `compareSnapshots` 及独立的分版本遍历完成。所有结果均表示静态潜在关联。

## 数据与代码处理

静态分析只读取目标项目，不安装其依赖，不运行其代码、配置或插件，不调用 AI 或外部网络服务。`analyze` 只在指定 `--out` 后写入该输出位置；`open` 在工具缓存目录保存图谱、完整源码、阅读进度及按需生成的解释。只有在解释页面启用并明确发起 AI 请求后，所预览的上下文才会发送至配置的服务地址，请求设置 `store: false`。浏览器字体和布局资源均随构建产物提供。输出与缓存应按本地源码同样的方式保存和分享。

依赖固定为 TypeScript 5.9.3、ignore 7.0.5、Node 类型 24.10.0，并保留 npm 锁文件。Compiler API 被封装在 `AnalyzerAdapter` 后，升级时先执行样例与边界验证。[TypeScript Compiler API 官方说明](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)。

工作台使用 Fastify、React、React Flow 和 ELK，版本固定在 package.json 与锁文件中。Node 自带 SQLite 用于本地持久化，无需安装数据库服务。

项目需求见 [MVP 需求与技术方案](docs/MVP需求与技术方案.md)，阶段结果见 [第一阶段](docs/第一阶段验证记录.md)、[第二阶段](docs/第二阶段验证记录.md)、[第三阶段](docs/第三阶段验证记录.md)、[第四阶段](docs/第四阶段验证记录.md)、[第五阶段](docs/第五阶段验证记录.md)，界面约定见 [设计说明](DESIGN.md)。真人试用任务、CSV 记录模板及固定 AI 评测问题已准备，当前没有填入用户反馈或真实模型评分。
