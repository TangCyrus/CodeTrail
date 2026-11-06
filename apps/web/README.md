# CodeTrail 浏览器工作台

使用 React、React Flow 和 ELK，消费本地服务提供的模块概览、搜索、局部图、节点详情和源码窗口。浏览器不直接读取文件系统，不运行被分析项目代码。

从仓库根目录执行 `npm run build`，然后 `npm run open -- <项目目录>`。生产资源输出到本目录的 `dist/`，由 Fastify 同源提供，不需要单独启动前端开发服务器。前后端协议位于 `packages/shared/src/explorer.ts`。

`api.ts` 负责会话与 Fetch SSE；`App.tsx` 负责导航及分析状态；`GraphView.tsx` 负责布局与图交互；`Inspector.tsx` 负责节点、证据与源码核实。ELK 延迟加载，布局失败时降级为网格，列表导航仍可用。

视觉规则与响应式约定见仓库根目录 `DESIGN.md`。浏览器验证执行 `npm run test:browser`，截图输出到 `artifacts/phase-two/`。
