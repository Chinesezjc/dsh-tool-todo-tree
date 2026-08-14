# dsh-tool-todo-tree

嵌套（树形）`todo_write` 工具插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)。
它是 `@deepseek-ai/dsh-tool-todo`（扁平列表）的**互斥替代品**：两者注册同一个工具名 `todo_write`，一个部署只能挂载其中一个。

## 安装

本包是可独立构建的 DSH bundle，依赖全部取自已发布的 `@deepseek-ai/*` npm 包，**不需要 DSH 源码树**。装完即同时得到 host 侧的工具与浏览器端的树形渲染。

```sh
# 从本地 tarball（不需要构建权限）
pnpm pack
dsh plugin --profile <名字> add ./dsh-tool-todo-tree-0.2.0.tgz

# 或直接从 git（pnpm 会跑 prepare 构建，需在 profile 的 pnpm-workspace.yaml 放行）
dsh plugin --profile <名字> add github:Chinesezjc/dsh-tool-todo-tree#<sha>
```

npm 上的 [`dsh-tool-todo-tree`](https://www.npmjs.com/package/dsh-tool-todo-tree) 目前是 `0.1.0`，**只有 host 半边**（没有 `dsh.client` 声明，装了不会有 Web 渲染）。带浏览器半边的是 `0.2.0`，尚未发布——在那之前请用上面两条路径之一。

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

**host 侧**

- `todo_write`：整棵任务树的全量替换写入，节点通过 `children` 嵌套
- 每次调用向所属 agent 的 session 追加一条 `todo/tree` 事件快照，回放为 last-write-wins
- `todoTree` projection：组合了 session-projection 接缝时发布当前整树，供 UI 读取（由下一个 `turn/start` 清空）
- 全树范围内最多一个节点 `in_progress`；父节点只有在全部子节点 `completed` 时才可为 `completed`
- 同层兄弟节点 `content` 去重；空 `children` 归一化为省略该字段
- `maxDepth`（默认 3）收窄接受的嵌套深度，上限为协议常量 `SCHEMA_DEPTH`

**Web 侧**（`exports["./client"]`，由 `dsh.client` 声明，web shell 自行发现并加载）

- 计划条：注册进 `conversation.input.dock`，读 `todoTree` projection，按深度缩进列出每一层节点；折叠态表头给出跨全部深度的各状态计数
- `todo_write` 行：注册进 keyed slot `tool.call.toolview`，以 `priority: -1` **遮蔽**内置的扁平行（keyed slot 的规则是同 key 同 priority 报错、更低者渲染），单行摘要同样逐层统计
- 两处遍历都用显式栈：它们读的计划都未经校验（行读的是一次调用的 `argsRaw`，即使该调用被 `execute` 拒绝也原样保留；计划条读的可能来自本 build 没写过的日志），递归会把一个畸形计划变成 `RangeError` 并带崩整个会话渲染

## 验证

以下均为实跑结果。CI 两个 job：`standalone` 走 npm 安装链路，`patches` 走源码树装配链路。

**独立路径（无 monorepo）**：`pnpm install` 只从 npm 取依赖；`pnpm run typecheck`（host 与 client 两个 face）退出 0；`pnpm run test` **100/100 通过**；`pnpm run build` 成功（host 半边 6 个产物 + 浏览器半边 `lib/client.js` 13.8 kB）。

**真实安装链路**：`pnpm pack` → `dsh plugin --profile ttdemo add ./*.tgz` 成功；profile 的 `dsh.profile.bundles` 出现 `dsh-tool-todo-tree`；随后从 profile 解析插件、从 profile 的 healed mirror 解析 harness 包，挂到真实 `ToolRuntime` 上读回工具：`todo_write` 已注册，节点字段为 `content,status,children`，且第二层仍公布 `children`（嵌套形状真实可见）。

**registry 安装链路**：从 npm 装下来的 `0.1.0` 内容完整，`prepare` 不触发，`zod` 随包装上，`.` 与 `./invariant` 两个入口的类型解析均通过。

**浏览器半边**：`lib/client.js` 的 `import` 只保留 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`（即 shell 模块表提供的那些，React 未被打进去）；CSS Module 编译进包并在 jsdom 里注入了恰好一个 `style[data-plugin="dsh-tool-todo-tree"]`，内含 `--dsw-todo-tree-depth`。用 shell 模块表的替身加载该产物后，`apply` 实际注册出：`conversation.input.dock`（`id=todo-tree`）与 `tool.call.toolview`（`key=todo_write, priority=-1`）。

**Web 侧可发现性**：`dsh plugin add` 之后，从 profile 解析出的已安装包满足 shell 扫描器读的全部条件——`dsh.client.platform === 'web'`、`exports["./client"]` 解析到磁盘上真实存在的 `./lib/client.js`。

**装配进主仓源码树**（`scripts/assemble-into-harness.mjs` + `patches/`，用于跑主仓自己的门禁）：四个生成器与三个 `verify-*` 全绿；`typecheck`、`lint` 退出 0；`packages/todo` + `ui-tool` + `ui-conversation` + `gen-tool-catalog.spec.ts` 共 **772/772** 通过，且用的是主仓**未经修改**的 client 包。本包在主仓 per-file 100% 覆盖率门禁下达标（语句 154/154、分支 104/104、函数 27/27、行 131/131）。

**负例验证**（断言能失败才算验证）：
- 短路 `maxDepth` 深度检查 → `loader-composition` 的「maxDepth: 1 拒绝嵌套写入」转红。
- 删掉 projection 的 fold 分支 → 3 个 last-wins 用例转红；整段删掉 `ctx.inject(['sessionProjections'], …)` → 7 个中 6 个转红。
- 移除 `tests/projection.spec.ts` → `src/index.ts` 掉到 90.76% 行覆盖，未覆盖行正是 projection 注册块，覆盖率门禁 `exit=1`。
- 把 `planRows` 改成只遍历顶层 → 8 个用例转红（含计划条缩进、跨深度计数、20 万层嵌套那条）。
- keyed slot 的 `priority` 语义是在主仓里用探针实测的：同 key 同 priority 第二次注册直接抛错（错误信息本身指出「register at a different priority to shadow it (lowest renders)」），改成 `priority: -1` 后即被接受。

## 版本对齐的坑

npm 上 `@deepseek-ai/dsh-*` 的 `dist-tags.latest` 多数仍指向旧的 `0.0.1-rc.1`，而与 `@deepseek-ai/dsh@0.1.0-rc.6` 配套的是 `next` 标签下的 `0.1.0-rc.6`。混用会在运行期炸出缺失导出（例如 `dsh-agent-loop` 需要 `dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER`，旧版没有）。本包的 peer 范围统一钉在 `^0.1.0-rc.6`。

`@deepseek-ai/dsh-session` 声明了未发布的 peer `@deepseek-ai/dsh-type-meta`，因此 `autoInstallPeers` 开启时安装会失败。本包关掉它并显式声明所需 peer；`dsh plugin add` 走 profile 的 healed mirror，不受影响。

## 已知缺口

- **计划条只缩进、不可折叠**：按深度缩进各行，没有按节点折叠，较宽的树依赖计划条自身滚动。
- **浏览器渲染未在真实浏览器里截图验证**：现有证据是 jsdom 组件测试、构建产物的导入/CSS 检查，以及加载后实际注册的 slot 与 priority；没有跑起 `dsh web` 用真实页面确认视觉结果。
- **`integration.spec.ts` 的对向守卫断言被收窄**：那条拒绝在扁平工具的 `execute` 里，属上游代码，已发布版本不含该守卫。独立套件只断言「树快照仍是日志上唯一的 todo 形态」，并探测所装上游是否带守卫。
- **`mock-adapter.ts` 是复制来的**：harness 把它放在 `packages/core/agent-loop/tests/`，已发布包只含 `lib/`，任何发布产物都不暴露它，因此独立套件自带一份精简版。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
