# dsh-tool-todo-tree

嵌套（树形）`todo_write` 工具，用于 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) (DSH)。
它是主仓 `@deepseek-ai/dsh-tool-todo`（扁平列表）的**互斥替代品**：两者注册同一个工具名 `todo_write`，一个部署只能挂载其中一个。

## 这个包做什么

**`@deepseek-ai/dsh-tool-todo-tree`** —— 模型可见工具：

- `todo_write`：整棵任务树的全量替换写入，节点通过 `children` 嵌套
- 每次调用向所属 agent 的 session 追加一条 `todo/tree` 事件快照，回放为 last-write-wins
- 全树范围内最多一个节点处于 `in_progress`；父节点只有在全部子节点 `completed` 时才可为 `completed`
- 同层级兄弟节点 `content` 去重；空 `children` 归一化为省略该字段
- `maxDepth` 配置（默认 3）收窄接受的嵌套深度，上限为协议常量 `SCHEMA_DEPTH`

与扁平工具的区别：扁平工具写 `todo/write` 事件、只有一层列表；本包写 `todo/tree` 事件、支持三层嵌套。两种事件类型不同，因此消费方始终能分辨某条日志条目属于哪种形态。

## 装配到主仓

本包依赖 DSH 主仓的 `core/tools`、`core/scope`、`core/session`、`core/agent` 等内部包，**无法脱离主仓独立构建**。装配步骤：

1. 把 `package/` 放进主仓的 `packages/todo/tool-todo-tree/`：

   ```sh
   mkdir -p <dsh>/packages/todo/tool-todo-tree
   cp -R package/. <dsh>/packages/todo/tool-todo-tree/
   ```

2. 应用 `patches/` 下的接线补丁（在主仓根目录）：

   ```sh
   git apply patches/tsconfig.host.patch                  # 注册 project reference
   git apply patches/root-package-json.patch              # 根 devDependency，供 gen-tool-catalog 导入
   git apply patches/gen-tool-catalog.patch               # 加入工具目录生成器的 boot manifest
   git apply patches/gen-tool-catalog-spec.patch          # 目录生成器测试：todo_write 现有两个注册者
   git apply patches/tool-todo-reciprocal-guard.patch     # 扁平工具的对向 append 期拒绝
   git apply patches/pnpm-lock.patch                      # 锁文件条目
   ```

   `tsconfig.base.json` 不需要改：其 `paths` 与 `include` 已有 `./packages/todo/*/src` 通配，覆盖本包。

3. 安装、构建，然后重新生成受影响的产物：

   ```sh
   pnpm install
   pnpm run build:lib:host            # 必须在 gen-tool-catalog 之前
   pnpm run gen-persistence-catalog   # 把 todo/tree 注册进 KNOWN_SESSION_EVENT_TYPES
   pnpm run gen-tool-catalog
   pnpm run gen-config-catalog
   pnpm run gen-doc-graphs
   ```

   `build:lib:host` 不能跳过：根 `package.json` 把本包声明为 devDependency（`gen-tool-catalog` 需要 import 它），因此 pnpm 会在 `node_modules/@deepseek-ai/` 下建立软链，该链按包的 `exports` 解析到 `lib/`，而不是走 tsconfig `paths` 到 `src/`。未构建时 `gen-tool-catalog` 会以 `ERR_MODULE_NOT_FOUND` 失败。

   `gen-persistence-catalog` 同样是必需的，不是可选的文档步骤：持久化读路径拒绝解释携带未注册事件类型的日志（`SessionFormatUnsupportedError`），所以不跑它会导致任何写入过 `todo/tree` 的会话无法加载。

   注意 `pnpm install` 会按自己的解析结果重写 `pnpm-lock.yaml`，因此 `pnpm-lock.patch` 只在**安装之前**应用有效；已经装过一次之后不要再尝试应用它。

4. 在 host 的 `cordis.patch.yml` 里挂载，并**同时禁用扁平工具**：

   ```yaml
   - insert:
       - id: tool-todo-tree
         name: '@deepseek-ai/dsh-tool-todo-tree'
         config:
           maxDepth: 3
   ```

   两者注册同名工具，注册表会拒绝第二个注册者，其 entry 的 fiber settle 为 `FAILED`，`assertEntriesActivated` 审计该状态并让启动失败。选择形态的方式是在组合根处禁用不需要的那个 entry，不要依赖挂载顺序。

## 已知缺口

`patches/` 只覆盖 host 侧接线。以下**未包含**，需要另行实现：

- **Web / TUI 渲染**：原 PR 修改的 `todo-row.tsx`、`transcript.ts`、`tool-call-model.ts` 在当前主仓已重构迁移（Web 侧现位于 `packages/client/ui-tool/`），这些改动未移植。当前 Web `todo_write` 行按扁平列表解析 args，不会渲染 `children` 层级。
- **`todos` projection**：主仓扁平工具注册了 `todos` projection provider（GUI 的 TodoPanel 数据源），本包没有对应实现，因此 TodoPanel 不会显示树形状态。
- **`loader-composition` / `projection` 测试**：扁平工具有这两个测试文件，本包没有；主仓对「产品可见插件需要真实 Loader 组合测试」的要求尚未满足。

## 验证

以下均在 DSH master `2b9bd83960` 上实测通过：

- 把本仓内容装配进一份**干净 clone**（严格按上面步骤 1–3 执行），`pnpm install`、`pnpm run build:lib:host` 与四个生成器全部成功；`packages/todo` + `packages/core/session` + `gen-tool-catalog.spec.ts` 共 **403/403** 单测通过，`pnpm run typecheck` 退出 0。
- 在完整工作副本上：`packages/todo` 111/111、`packages/core/session` 一并 393/393 通过；`pnpm run lint`、`pnpm run build`、`pnpm run doc-sync`（28 道门禁）全绿。
- 全量 `pnpm run test`：13487 通过，剩余 6 个文件 / 35 个用例的失败在**未改动的干净 master 上完全相同**（`posix_spawnp failed`，宿主沙箱限制进程 spawn），与本包无关。
- 负例验证：移除 `tool-todo-reciprocal-guard.patch` 引入的守卫后，`integration.spec.ts` 中「scoped 扁平工具不能覆写树」用例转红，确认该断言真的能失败。

## 从 master 移植时修掉的问题

本包源自 PR [#668](https://github.com/deepseek-harness/deepseek-harness/pull/668)（分支 `feat/todo-tree-tool`，落后 master 约 3300 个 commit）。移植中修正：

- `cordis` / `schemastery` / `@cordisjs/plugin-loader` 改为主仓已 rescope 的 `@deepseek-ai/*` 名称
- tsconfig reference `support/invariants` → `runtime-diagnostics/invariants`
- `agent/status` 监听签名改为单一 payload 对象 `{ agent, status }`
- `turn/start` 事件负载去掉已删除的 `trigger` 字段
- `new Session(...)` → `Session.create(...)`（构造函数已私有化）
- `ctx.plugin(ToolTodo)` 补上现为必填的 `allowParallelInProgress`
- `declare module '@deepseek-ai/dsh-session'` → `'@deepseek-ai/dsh-session/types'`，否则 `gen-persistence-catalog` 扫不到该事件，`todo/tree` 不会进入 `KNOWN_SESSION_EVENT_TYPES`，写过该事件的会话将无法加载
- package.json 的 version / license 与主仓对齐

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
