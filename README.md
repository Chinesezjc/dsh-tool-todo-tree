# dsh-tool-todo-tree

嵌套（树形）`todo_write` 工具插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)。
它是 `@deepseek-ai/dsh-tool-todo`（扁平列表）的**互斥替代品**：两者注册同一个工具名 `todo_write`，一个部署只能挂载其中一个。

## 安装

本包是可独立构建的 DSH bundle，依赖全部取自已发布的 `@deepseek-ai/*` npm 包，**不需要 DSH 源码树**。

```sh
# 从 tarball（无需构建权限）
pnpm pack
dsh plugin --profile <名字> add ./dsh-tool-todo-tree-0.1.0.tgz

# 或直接从 git（pnpm 会跑 prepare 构建，需在 profile 的 pnpm-workspace.yaml 放行）
dsh plugin --profile <名字> add github:Chinesezjc/dsh-tool-todo-tree#<sha>
```

`dsh plugin add` 会把包写进 profile 依赖，并把 `cordis.patch.yml` 注册为一层 bundle。该层挂载树形工具并禁用扁平工具：

```yaml
- id: tool-todo
  disabled: true

- insert:
    - id: tool-todo-tree
      name: dsh-tool-todo-tree
      config:
        maxDepth: 3
```

必须显式禁用扁平工具。两者注册同名工具，注册表拒绝第二个注册者，其 entry 的 fiber settle 为 `FAILED`，而 `assertEntriesActivated` 审计该状态并让启动失败——选择形态要在组合层做，不能依赖挂载顺序。

## 这个包做什么

- `todo_write`：整棵任务树的全量替换写入，节点通过 `children` 嵌套
- 每次调用向所属 agent 的 session 追加一条 `todo/tree` 事件快照，回放为 last-write-wins
- `todoTree` projection：组合了 session-projection 接缝时发布当前整树，供 UI 读取（由下一个 `turn/start` 清空）
- 全树范围内最多一个节点 `in_progress`；父节点只有在全部子节点 `completed` 时才可为 `completed`
- 同层兄弟节点 `content` 去重；空 `children` 归一化为省略该字段
- `maxDepth`（默认 3）收窄接受的嵌套深度，上限为协议常量 `SCHEMA_DEPTH`

## Web 树形渲染需要打补丁

**npm 安装只提供 host 侧的工具与 projection。** 浏览器端把树画出来需要把本仓装配进 DSH 源码树并打补丁，原因是结构性的：计划条组件 `TodoPanel` 是 `@deepseek-ai/dsh-client-ui-conversation` 的内部组件、未在该包 `exports` 中导出，而 `packages/client/AGENTS.md` 禁止跨包引用另一个插件的内部符号。

```sh
node scripts/assemble-into-harness.mjs <dsh 源码树>
cd <dsh 源码树> && git apply <本仓>/patches/*.patch
pnpm install && pnpm run build:lib:host
pnpm run gen-persistence-catalog   # 必需：否则 todo/tree 进不了 KNOWN_SESSION_EVENT_TYPES
pnpm run gen-tool-catalog && pnpm run gen-config-catalog && pnpm run gen-doc-graphs
```

装配脚本不是可选步骤：补丁会 `import '@deepseek-ai/dsh-tool-todo-tree/client'` 并给它加 tsconfig project reference，所以包必须先以**scoped 身份**存在于树内。同一份源码在两处身份不同——发布版是不带 scope 的 `dsh-tool-todo-tree`、peer 走 registry、tsdown 产出 `lib/*.js`；树内版是 `@deepseek-ai/dsh-tool-todo-tree`、peer 走 `workspace:^`、由 harness 的 `tsc -b` 产出 `lib/types/`。脚本负责写出后者。

| 补丁 | 作用 |
|---|---|
| `web-tool-row-tree-counts.patch` | `TodoRow` 单行摘要逐层统计 `children` |
| `web-todo-panel-tree.patch` | `TodoPanel` 按深度缩进渲染，并读 `todoTree` projection |
| `tool-todo-reciprocal-guard.patch` | 扁平工具的对向 append 期拒绝（防止一条日志混两种形态） |
| `gen-tool-catalog.patch` | 把新工具包加进目录生成器的 boot manifest（该门禁强制要求） |
| `gen-tool-catalog-spec.patch` | 该生成器测试：`todo_write` 现有两个注册者 |
| `root-package-json.patch` | 根 devDependency，供生成器 import 本包 |

不做这些时，工具本身与 projection 正常工作，只是 Web 计划条不显示层级。

## 验证

以下均为实跑结果。

**独立路径（无 monorepo）**：`pnpm install` 只从 npm 取依赖；`pnpm run typecheck` 退出 0；`pnpm run test` **81/81 通过**；`pnpm run build` 成功（8 个产物，含 `lib/*.js` 与 `.d.ts`）。

**真实安装链路**：`pnpm pack` → `dsh plugin --profile ttdemo add ./*.tgz` 成功；profile 的 `dsh.profile.bundles` 出现 `dsh-tool-todo-tree`；随后从 profile 解析插件、从 profile 的 healed mirror 解析 harness 包，挂到真实 `ToolRuntime` 上读回工具：`todo_write` 已注册，节点字段为 `content,status,children`，且第二层仍公布 `children`（嵌套形状真实可见）。

**补丁路径**：在公开镜像的干净 clone 上，`scripts/assemble-into-harness.mjs` + 6 个补丁全部成功；四个生成器与三个 `verify-*` 全绿；`typecheck`、`lint` 退出 0；`packages/todo` + `ui-tool` + `ui-conversation` + `gen-tool-catalog.spec.ts` 共 **781/781** 通过。本包在主仓 per-file 100% 覆盖率门禁下达标（语句 154/154、分支 104/104、函数 27/27、行 131/131）。

**负例验证**（断言能失败才算验证）：
- 短路 `maxDepth` 深度检查 → `loader-composition` 的「maxDepth: 1 拒绝嵌套写入」转红。
- 删掉 projection 的 fold 分支 → 3 个 last-wins 用例转红；整段删掉 `ctx.inject(['sessionProjections'], …)` → 7 个中 6 个转红。
- 移除 `tests/projection.spec.ts` → `src/index.ts` 掉到 90.76% 行覆盖，未覆盖行正是 projection 注册块，覆盖率门禁 `exit=1`。
- 把 `TodoRow` 的显式栈换回递归 → 20 万层嵌套用例以 `RangeError` 转红。

## 版本对齐的坑

npm 上 `@deepseek-ai/dsh-*` 的 `dist-tags.latest` 多数仍指向旧的 `0.0.1-rc.1`，而与 `@deepseek-ai/dsh@0.1.0-rc.6` 配套的是 `next` 标签下的 `0.1.0-rc.6`。混用会在运行期炸出缺失导出（例如 `dsh-agent-loop` 需要 `dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER`，旧版没有）。本包的 peer 范围统一钉在 `^0.1.0-rc.6`。

`@deepseek-ai/dsh-session` 声明了未发布的 peer `@deepseek-ai/dsh-type-meta`，因此 `autoInstallPeers` 开启时安装会失败。本包关掉它并显式声明所需 peer；`dsh plugin add` 走 profile 的 healed mirror，不受影响。

## 已知缺口

- **计划条只缩进、不可折叠**：按深度缩进各行，没有按节点折叠，较宽的树依赖计划条自身滚动。
- **`integration.spec.ts` 的对向守卫断言被收窄**：那条拒绝在扁平工具的 `execute` 里，属上游代码，已发布版本不含该守卫。独立套件只断言「树快照仍是日志上唯一的 todo 形态」，并探测所装上游是否带守卫。
- **Web 快照门禁未在有沙箱的机器上验证**：本机 `DSH_SNAPSHOT=replay pnpm run test:web` 的失败与干净 master 完全一致（缺沙箱后端，11 文件 / 15 用例），只能证明未引入新失败。
- **`mock-adapter.ts` 是复制来的**：harness 把它放在 `packages/core/agent-loop/tests/`，已发布包只含 `lib/`，任何发布产物都不暴露它，因此独立套件自带一份精简版。

## 从原 PR 移植时修掉的问题

源自 PR [#668](https://github.com/deepseek-harness/deepseek-harness/pull/668)（分支 `feat/todo-tree-tool`，落后 master 约 3300 个 commit）：

- `cordis` / `schemastery` / `@cordisjs/plugin-loader` → 已 rescope 的 `@deepseek-ai/*` 名称
- tsconfig reference `support/invariants` → `runtime-diagnostics/invariants`
- `agent/status` 监听签名 → 单一 payload 对象 `{ agent, status }`
- `turn/start` 负载去掉已删除的 `trigger` 字段
- `new Session(...)` → `Session.create(...)`（构造函数已私有化）
- `ctx.plugin(ToolTodo)` 补上现为必填的 `allowParallelInProgress`
- `declare module '@deepseek-ai/dsh-session'` → `'@deepseek-ai/dsh-session/types'`，否则 `gen-persistence-catalog` 扫不到该事件，`todo/tree` 进不了 `KNOWN_SESSION_EVENT_TYPES`，写过该事件的会话将无法加载
- Web 渲染：原 PR 改的 `todo-row.tsx` / `tool-call-model.ts` 已迁到 `packages/client/ui-tool/`，按新结构重写为 `planSummary` 的逐层统计
- TUI：原 PR 改的 `packages/ui/tui` 已被主仓在 `ed30088adb`（`cleanup: remove TUI package and legacy dsh entrypoints`）整包删除，该改动无处可移植，已丢弃

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
