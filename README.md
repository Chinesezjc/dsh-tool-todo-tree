# dsh-tool-todo-tree

嵌套（树形）`todo_write` 工具插件，用于 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) (DSH)。
它是主仓 `@deepseek-ai/dsh-tool-todo`（扁平列表）的**互斥替代品**：两者注册同一个工具名 `todo_write`，一个部署只能挂载其中一个。

## 包含什么

**`@deepseek-ai/dsh-tool-todo-tree`**（`package/`）—— 模型可见工具与 host 侧状态：

- `todo_write`：整棵任务树的全量替换写入，节点通过 `children` 嵌套
- 每次调用向所属 agent 的 session 追加一条 `todo/tree` 事件快照，回放为 last-write-wins
- `todoTree` projection：组合了 session-projection 接缝时发布当前整树，供 UI 读取（由下一个 `turn/start` 清空）
- 全树范围内最多一个节点 `in_progress`；父节点只有在全部子节点 `completed` 时才可为 `completed`
- 同层兄弟节点 `content` 去重；空 `children` 归一化为省略该字段
- `maxDepth`（默认 3）收窄接受的嵌套深度，上限为协议常量 `SCHEMA_DEPTH`

**Web 渲染**（`patches/web-*.patch`）—— 改的是 DSH 自己的 client 包，不在本插件内（见[结构限制](#结构限制)）：

- `TodoRow` 单行摘要用显式栈统计 `children`，汇总每一层的节点数
- `TodoPanel` 计划条读取 projection，按深度缩进渲染整棵树

## 结构限制

interconnect 那类插件是纯 host 插件，可以整包独立存在。本插件做不到同一件事，原因是实测确认的两点：

1. **Web 渲染归 DSH 的 client 包所有。** 计划条组件 `TodoPanel` 是 `@deepseek-ai/dsh-client-ui-conversation` 的内部组件，未在该包 `exports` 中导出；按 `packages/client/AGENTS.md` 的规定，跨包引用另一个插件的内部符号是禁止的。因此树形渲染只能以 patch 形式改动那两个 client 包，不能放进本仓的 `package/`。
2. **插件本身依赖主仓内部包**（`core/tools`、`core/scope`、`core/session`、`session-projection`），无法脱离主仓独立构建。

所以本仓的形态是：`package/`（可整体放入主仓的插件包）+ `patches/`（主仓侧接线与 Web 渲染改动）+ `cordis.patch.yml`（bundle 挂载层）。

## 装配到主仓

1. 把 `package/` 放进主仓的 `packages/todo/tool-todo-tree/`：

   ```sh
   mkdir -p <dsh>/packages/todo/tool-todo-tree
   cp -R package/. <dsh>/packages/todo/tool-todo-tree/
   ```

2. 在主仓根目录应用接线补丁：

   ```sh
   git apply patches/tsconfig.host.patch              # host project reference
   git apply patches/tsconfig.base.patch              # ./types 与 ./client 子路径 paths
   git apply patches/root-package-json.patch          # 根 devDependency，供 gen-tool-catalog 导入
   git apply patches/gen-tool-catalog.patch           # 加入工具目录生成器的 boot manifest
   git apply patches/gen-tool-catalog-spec.patch      # 该测试：todo_write 现有两个注册者
   git apply patches/tool-todo-reciprocal-guard.patch # 扁平工具的对向 append 期拒绝
   git apply patches/web-tool-row-tree-counts.patch   # TodoRow 逐层统计
   git apply patches/web-todo-panel-tree.patch        # TodoPanel 缩进渲染 + 读 todoTree projection
   git apply patches/pnpm-lock.patch                  # 锁文件条目（必须在 install 之前）
   ```

3. 安装、构建，然后重新生成受影响的产物：

   ```sh
   pnpm install
   pnpm run build:lib:host            # 必须在 gen-tool-catalog 之前
   pnpm run gen-persistence-catalog   # 把 todo/tree 注册进 KNOWN_SESSION_EVENT_TYPES
   pnpm run gen-tool-catalog
   pnpm run gen-config-catalog
   pnpm run gen-doc-graphs
   ```

   `build:lib:host` 不能跳过：根 `package.json` 把本包声明为 devDependency（`gen-tool-catalog` 需要 import 它），pnpm 因此在 `node_modules/@deepseek-ai/` 下建立软链，该链按包的 `exports` 解析到 `lib/` 而不是走 tsconfig `paths` 到 `src/`；未构建时生成器以 `ERR_MODULE_NOT_FOUND` 失败。

   `gen-persistence-catalog` 是正确性步骤，不是文档步骤：持久化读路径拒绝解释携带未注册事件类型的日志（`SessionFormatUnsupportedError`），不跑它会导致任何写入过 `todo/tree` 的会话无法加载。

   `pnpm install` 会按自己的解析结果重写 `pnpm-lock.yaml`，所以 `pnpm-lock.patch` 只在安装之前应用有效。

4. 挂载。`cordis.patch.yml` 可直接作为 profile 的 patch 层，或把内容并入你自己的层：

   ```yaml
   - id: tool-todo
     disabled: true

   - insert:
       - id: tool-todo-tree
         name: '@deepseek-ai/dsh-tool-todo-tree'
         config:
           maxDepth: 3
   ```

   必须显式禁用扁平工具：两者注册同名工具，注册表拒绝第二个注册者，其 entry 的 fiber settle 为 `FAILED`，而 `assertEntriesActivated` 审计该状态并让启动失败。选择形态要在组合层做，不能依赖挂载顺序。

## 验证

以下结果均为实跑，基线是公开镜像 `deepseek-ai/deepseek-harness@47f9438`（与私有仓 master `2b9bd83960` 同期）。

- **CI 在 GitHub runner 上全绿**：workflow 在一份 DSH 公开镜像的 fresh clone 里装配本插件，然后跑 install、`build:lib:host`、四个生成器、typecheck、lint、测试、覆盖率门禁，最后用四道 `verify-*` 门禁确认生成产物新鲜且生成是确定性的。

- 把本仓按上面步骤 1–3 装配进一份**干净 clone**：9 个补丁全部 `git apply` 成功，`pnpm install`、`build:lib:host`、四个生成器均成功；`pnpm run typecheck` 与 `pnpm run lint` 退出 0；`packages/todo` + `packages/client/ui-tool` + `packages/client/ui-conversation` + `gen-tool-catalog.spec.ts` 共 **781/781** 通过；四道 `verify-*` catalog 门禁全部通过。
- 插件包自身 5 个测试文件、81 个用例：注册表／不变式单测、真实 agent-loop 集成、`todoTree` projection、以及经真实 Loader 引导 cordis.yml 的 `loader-composition`（证明 `maxDepth` 是真配置项而非常量）。
- 本包 `src/**` 在主仓的 per-file 100% 覆盖率门禁下达标：语句 154/154、分支 104/104、函数 27/27、行 131/131。
- 在完整工作副本上另外跑过：`pnpm run test:gui` 272 文件 / 3765 用例全通过；`pnpm run doc-sync` 28 道门禁全绿；`pnpm run build` 退出 0。
- 全量 `pnpm run test`：13487 通过。剩余 6 文件 / 35 用例的失败在**未改动的干净 master 上完全相同**（`posix_spawnp failed`，宿主沙箱限制进程 spawn），与本插件无关。
- `DSH_SNAPSHOT=replay pnpm run test:web` 在本机为 11 文件 / 15 用例失败，但**干净 master 上是同样的 11 / 15**（失败原因是 `sandbox-exec: sandbox_apply: Operation not permitted`——本机没有可用的产品沙箱后端，凡执行 bash 的场景都失败），且失败场景里没有任何 todo／plan 相关项。该门禁需在具备沙箱的机器上复跑才有意义。
- `cordis.patch.yml` 的语义用主仓自己的 `applyEntryPatches` 实测：叠加 base bundle 层后，`tool-todo` 为 `disabled=true`、`tool-todo-tree` 为 `disabled=false`，即恰好一个 `todo_write` 提供者。
- 负例验证（断言能失败才算验证）：
  - 移除 `tool-todo-reciprocal-guard.patch` 的守卫 → 「scoped 扁平工具不能覆写树」用例转红。
  - 把 `TodoRow` 的显式栈换回递归遍历 → 20 万层嵌套用例以 `RangeError: Maximum call stack size exceeded` 转红。
  - 把 `maxDepth` 的深度检查短路掉 → `loader-composition` 中「maxDepth: 1 拒绝嵌套写入」用例转红。
  - 删掉 projection 的 `turn/start` 清空分支 → 只有「下一个 turn/start 清空」用例转红（1 红 / 6 绿）。
  - 整段删掉 `ctx.inject(['sessionProjections'], …)` 注册 → 7 个用例中 6 个转红；断言「未组合时没有该键」的那个仍绿，符合其语义。
  - 删掉 fold 里的 `todo/tree` 分支 → 3 个依赖 last-wins 的用例转红。
  - 把 `withTreeTool=false` 的 harness 改成始终挂载 → 「未组合时无该键」与 HMR 卸载两个用例转红。
  - 把 `TodoDock` 的 `todos ?? todoTree` 翻成 `todoTree ?? todos` → 只有新增的「优先扁平计划」用例转红（1 红 / 13 绿）。
- 覆盖率的双向对照：移除 `tests/projection.spec.ts` 后，`src/index.ts` 掉到语句 87.67% / 分支 89.74% / 函数 64.28% / 行 90.76%，未覆盖行恰为 projection 注册块 `268-277`，四项均触发主仓 per-file 100% 门禁报错；加回后回到 100%。即该 spec 缺失会让 `test:coverage` 直接失败。
- 生成产物的双向对照：在已装配的树上把四份 catalog 全部 `git checkout` 回提交态（等于 CI 的 fresh clone），`verify-tool-catalog`、`verify-persistence-catalog`、`verify-config-catalog`、`verify-doc-graphs` **四道全部报 stale**；依次跑四个生成器后四道全过，且再跑一遍生成器输出 byte-identical（确定性）。本插件让后两者变脏的原因是它向 `docs/config-catalog.*` 增加 `Config.maxDepth` 一节、并因 emit `todo/tree` 与监听 `internal/dispatch` 而进入事件生产/消费图。

## 从原 PR 移植时修掉的问题

源自 PR [#668](https://github.com/deepseek-harness/deepseek-harness/pull/668)（分支 `feat/todo-tree-tool`，落后 master 约 3300 个 commit）。修正项：

- `cordis` / `schemastery` / `@cordisjs/plugin-loader` → 主仓已 rescope 的 `@deepseek-ai/*` 名称
- tsconfig reference `support/invariants` → `runtime-diagnostics/invariants`
- `agent/status` 监听签名 → 单一 payload 对象 `{ agent, status }`
- `turn/start` 负载去掉已删除的 `trigger` 字段
- `new Session(...)` → `Session.create(...)`（构造函数已私有化）
- `ctx.plugin(ToolTodo)` 补上现为必填的 `allowParallelInProgress`
- `declare module '@deepseek-ai/dsh-session'` → `'@deepseek-ai/dsh-session/types'`，否则 `gen-persistence-catalog` 扫不到该事件，`todo/tree` 进不了 `KNOWN_SESSION_EVENT_TYPES`，写过该事件的会话将无法加载
- Web 渲染：原 PR 改的 `todo-row.tsx` / `tool-call-model.ts` 已迁到 `packages/client/ui-tool/`，改动按新结构重写为 `planSummary` 的逐层统计；`TodoPanel` 新增 projection 读取与深度缩进
- TUI：原 PR 改的 `packages/ui/tui` 已被主仓在 `ed30088adb`（`cleanup: remove TUI package and legacy dsh entrypoints`）整包删除，该改动无处可移植，已丢弃
- package.json 的 version / license 与主仓对齐

## 已知缺口

- **计划条只缩进、不可折叠**：按深度缩进各行，但没有按节点折叠，较宽的树依赖计划条自身滚动。
- **非浏览器界面不渲染**：已交付消费方是 `todoTree` projection 与浏览器端的行／计划条；其他 host 需自行订阅 `todo/tree`。
- **Web 快照门禁看不到本插件的 client 改动**（不只是"未验证"，是结构性无效）：主仓唯一的装配级 todo 快照 `apps/web/tests/todo-row.snapshot.ts` 走的 fixture（`packages/client/connection/src/client/fixture.ts:493-500,597`）只写 **`todo/write`** 这一个扁平事件、且 projection 只把它折进 `todos` 键，因此 `todoTree` 在该 harness 里从不存在，嵌套渲染路径一行都不执行。实测双向对照：把两个 client 包的 `lib/client.js` 分别构建成**打了补丁**与**未打补丁**两个版本，`DSH_SNAPSHOT=replay` 跑该快照**两次都通过、输出完全相同**——即它无法区分本插件是否装配。要真正覆盖需要给 fixture 增加一条 `todo/tree` 事件（连带 projection 折叠），本仓未做。
  - 附带教训：跑该快照前必须先 `pnpm --filter <client 包> bundle`。它加载的是 `lib/client.js` 而非源码，源码打了补丁但 bundle 是旧的时会得到**假绿**（本机实测遇到过：源码 mtime 比 bundle 新且 bundle 里搜不到 `dsw-todo-depth`/`todoTree`）。
  - 补偿措施：`TodoDock` 的两键优先级（`todos ?? todoTree`）改由包级 spec 的「优先扁平计划」用例覆盖——它是装配级快照照不到、而 `ui-conversation/src/client/*` 又整目录免除覆盖率门禁的那段行为。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
