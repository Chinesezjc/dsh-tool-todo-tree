# dsh-tool-todo-tree

嵌套（树形）todo 工具插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)。
模型侧工具名是 **`todo_tree_write`**。

它与 `@deepseek-ai/dsh-tool-todo`（扁平的 `todo_write`）**注册不同的工具名**，所以两者可以在同一个部署里共存：
`dsh plugin add` 之后，模型在会话里直接就能看到这个树形工具，**不需要改动任何 agent preset**。

## 安装

本包是可独立构建的 DSH bundle，依赖全部取自已发布的 `@deepseek-ai/*` npm 包，**不需要 DSH 源码树**。装完即同时得到 host 侧的工具与浏览器端的树形渲染。

```sh
dsh plugin --profile <名字> add dsh-tool-todo-tree
```

registry 上的 tarball 自带 `lib/`，安装时不跑构建（`prepare` 只在 git 安装时触发）。也可以从本地 tarball（`pnpm pack`）或 git ref（`github:Chinesezjc/dsh-tool-todo-tree#<sha>`，pnpm 会跑 `prepare`，需在 profile 的 `pnpm-workspace.yaml` 放行）安装。

`dsh plugin add` 会把包写进 profile 依赖，并把 `cordis.patch.yml` 注册为一层 bundle。该层只插入树形工具，**不动扁平工具**：

```yaml
- insert:
    - id: tool-todo-tree
      name: dsh-tool-todo-tree
      config:
        maxDepth: 3
        allowParallelInProgress: true
```

重启 web 服务后，会话的工具表里就同时有 `todo_write` 与 `todo_tree_write`。`--dump-config` 应能看到 `- id: tool-todo`（base bundle 的那一行，**不带** `disabled:`）与本包插入的 `- id: tool-todo-tree` 两行都在。

### 为什么 0.4.0 起不再需要改 preset

工具表按 scope 链覆盖：agent scope（preset 挂载的那些行）比 host scope 更近，**同名**项由近者胜出。`0.3.x` 注册的是 `todo_write`，而 shipped 的 `standard`/`code`/`cordis` 三个 preset 各自都有一行 `- id: tool-todo`，于是 preset 那一行必然遮蔽 host 层的树形工具——`dsh plugin add` 与 `--dump-config` 都显示配置正确，会话里模型拿到的却是扁平工具（落库 `todo/write`、projection 是 `todos`、文案 `Updated todo list:`）。

改名为 `todo_tree_write` 之后不存在同名项，遮蔽不成立，这个坑整条消失。preset 层**没有** patch 语义（harness 自己的 `packages/preset/agent-presets/README.md` 写明「副本会随部署升级漂移，这一层无法表达 standard plus one change」），所以「复制 preset 再删一行」这条路线天生要跟着 harness 发版重新派生——0.4.0 不需要它了。

## 和扁平工具的关系

- **默认两者都在**：树形工具适合有子步骤的计划，扁平工具适合单层清单；工具描述里各自写明了这一点。
- **想只留树形**：在自己的 overlay 里禁用扁平行即可（bundle patch 不做这件事，因为它会剥夺部署的扁平能力）：

  ```yaml
  - id: tool-todo
    disabled: true
  ```

  注意 preset 层是**另一份** composition：只改 host overlay 时，preset 里的 `tool-todo` 行仍会挂载扁平工具。要连它一起去掉，需要复制一份 preset 并删掉整个 `tool-todo` 条目（连同 `config:` 子键，只删 `- id:` 会留下孤立的 `config:` 让 YAML 失效）。
- **两种形状各写自己的事件**：树形写 `todo/tree`、扁平写 `todo/write`，一个 session 的日志可以同时带上两者，`./invariant` companion 不再把这种混合当错误；它只保留「`todo/tree` 必须落在打开的 turn 内」这条。
- **不要再把本包加进 preset**：preset 的每一行都在 agent scope 内挂载，而本工具设计上只挂 host 层、靠继承到达 session；放进去会让 `todo_tree_write` 的 projection/工具注册多出一份。host 层挂载已足够。

## 这个包做什么

**host 侧**

- `todo_tree_write`：整棵任务树的全量替换写入，节点通过 `children` 嵌套
- 每次调用向所属 agent 的 session 追加一条 `todo/tree` 事件快照，回放为 last-write-wins
- `todoTree` projection：组合了 session-projection 接缝时发布当前整树，供 UI 读取（由下一个 `turn/start` 清空）
- `allowParallelInProgress`（**必填**，无默认）：`true` 允许任意深度多个节点同时 `in_progress`，`false` 则全树只允许一个、多标即拒绝。与扁平工具同名开关语义一致，因此用它替换扁平工具不会悄悄改掉部署已选的并行策略；工具描述也随之切换
- 父节点只有在全部子节点 `completed` 时才可为 `completed`
- 同层兄弟节点 `content` 去重；空 `children` 归一化为省略该字段
- `maxDepth`（默认 3）收窄接受的嵌套深度，上限为协议常量 `SCHEMA_DEPTH`

**Web 侧**（`exports["./client"]`，由 `dsh.client` 声明，web shell 自行发现并加载）

- 计划条：注册进 `conversation.input.dock`（`id=todo-tree`），读 `todoTree` projection，按深度缩进列出每一层节点；折叠态表头给出跨全部深度的各状态计数
- 卡片外观（`--dsw-alias-border-l1` 边框、12px 圆角、`--dsw-specific-tip` 底色、dock 列宽与 180px 滚动上限、字号字重）与扁平工具的计划条逐条对齐——两者占同一个 dock 位、各按自己的工具数据渲染，**唯一有意的视觉差异是 `.item` 的深度缩进**
- `todo_tree_write` 行：注册进 keyed slot `tool.call.toolview`，key 就是本包的工具名（默认 priority，不再遮蔽任何行），单行摘要逐层统计
- 两处遍历都用显式栈：它们读的计划都未经校验（行读的是一次调用的 `argsRaw`，即使该调用被 `execute` 拒绝也原样保留；计划条读的可能来自本 build 没写过的日志），递归会把一个畸形计划变成 `RangeError` 并带崩整个会话渲染

## 验证

以下均为实跑结果。CI 两个 job：`standalone` 走 npm 安装链路，`patches` 走源码树装配链路（见「已知缺口」）。

**独立路径（无 monorepo）**：`pnpm install` 只从 npm 取依赖；`pnpm run typecheck`（host 与 client 两个 face）退出 0；`pnpm run build` 成功；`pnpm run test` **113/113 通过**。`check` 的顺序是 typecheck → build → test，因为 `tests/bundle.spec.ts` 断言的是**产物**（本地 `~/.npmrc` 带 `ignore-scripts=true` 时 `prepare` 不会跑，test 在 build 前会找不到 `lib/client.js`）。

**真实安装链路（0.4.0，harness 0.1.6-alpha.1）**：`pnpm pack` → `dsh plugin --profile ttdemo add ./*.tgz` 成功；`--dump-config` 里 `- id: tool-todo` 保持启用（config 完好、无 `disabled:`）、`- id: tool-todo-tree` 已插入；随后 `dsh --profile ttdemo` 起 web 实例，启动日志 0 条 error，首页的 boot graph 里出现 `dsh-tool-todo-tree/client.js`——即浏览器半边在当前 shell 上被正确发现并派发。

**模型可见的工具面（mock 模型，真实 agent loop）**：`tests/integration.spec.ts` 里 preset 的挂载方式（`agent.ctx.plugin(ToolTodo, …)`，即 agent scope）+ 本包的 host scope 注册，模型依次调用 `todo_tree_write`、`todo_write`、`todo_tree_write`：三次 `tool/result` 全部 `isError: false`，日志得到 2 条 `todo/tree` + 1 条 `todo/write`。这正是「装了就能用」的那条判据。

**已发布的 0.3.1 在活实例上的实测**：本机 3080 实例装的是 0.3.1，其首页 boot graph 里就有 `dsh-tool-todo-tree/client.js`，它依赖的三个图标、keyed slot 的 `priority` 语义与 `locale` 座位在当前 shell 里都还在。

**负例验证**（断言能失败才算验证，以下都实跑过）：
- 把 client 半的 keyed key 改回 `todo_write` → `tests/client.spec.tsx` 的 `apply` 用例转红。
- 把 host 半的工具名改回 `todo_write` → `tests/tool-todo-tree.spec.ts` 与 `tests/integration.spec.ts` 12 条以上转红（含「与扁平工具并存」与「preset 不会顶掉树形工具」两条）。
- 短路 `maxDepth` 深度检查 → `loader-composition` 的「maxDepth: 1 拒绝嵌套写入」转红。
- `allowParallelInProgress` 双向短路：忽略配置写死「永远单一」→ `true` 用例转红；写死「永远并行」→ `false` 用例转红。
- 删掉 projection 的 fold 分支 → 3 个 last-wins 用例转红；整段删掉 `ctx.inject(['sessionProjections'], …)` → 7 个中 6 个转红。
- 移除 `tests/projection.spec.ts` → `src/index.ts` 掉到 90.76% 行覆盖，未覆盖行正是 projection 注册块，覆盖率门禁 `exit=1`。
- 把 `planRows` 改成只遍历顶层 → 8 个用例转红（含计划条缩进、跨深度计数、20 万层嵌套那条）。
- `tests/stylesheet.spec.ts` 的四条断言各自反向注入一次：把边框 token 换回 `--dsw-alias-line-secondary` → 3 条转红；删掉 `background` 声明 → 卡片面断言转红；删掉 `padding-inline-start` → 缩进断言转红；重新引入 `composes:` → 对应断言转红。

### 已修：卡片曾经没有边框和底色

`0.3.0` 之前 `.strip` 用的是 `--dsw-alias-line-secondary`（边框）与 `--dsw-alias-fill-surface-l2`（背景）。**ui-theme 两个都没定义**，浏览器于是丢弃这两条声明：文字与状态图标的 token 都正常解析，所以颜色对，但卡片没有边框、背景透明，读起来像散在 dock 里的一段文字而不是一张卡片。

这个缺陷整条工具链都抓不到：未定义的自定义属性不是错误，`typecheck`、组件测试（jsdom 不做主题解析）、`bundle.spec.ts`（只断言产物格式）全部照绿。唯一能抓住它的位置是把 token 名钉在「已在真实页面回读过」的集合上，这就是 `tests/stylesheet.spec.ts` 的职责——新增 token 前必须先在运行中的页面里读出它的值。

顺带两个实测结论：shell 自己的 `ui-conversation/ContextBody.module.css` 也在引用同一个失效的 `--dsw-alias-line-secondary`（不止本插件）；`--dsw-alias-fill-l2` 同样解析不出来，所以它不能当替代品，正确的背景 token 是 `--dsw-specific-tip`。

另外 `composes:` 在本包的构建链下**不会展开**——产物里 `.row` 的类名不含被借用的类，规则会静默丢掉布局。已改为每条规则各自写全，并由断言守住。

### 历史：0.3.1 的真模型实录（当时还必须改 preset）

隔离 `DSH_HOME`、真 API key、preset 已删掉扁平工具那一项：模型一次调用 `todo_write` 写出三父六子的嵌套计划后——落库事件是 `todo/tree`；projection 里出现 `todoTree` 且携带完整嵌套数据，`todos` 键不存在；工具结果文案是 `Update todo tree`。真实浏览器页面里计划条显示 `Todo tree · 1 in progress · 8 pending`，工具行显示 `Update todo tree · 0/9 completed · 调研`（9 = 3 父 + 6 子）。

同一条件下**不改 preset** 的对照组：落库 `todo/write`、projection 里 `todoTree` 为 `null` 而 `todos` 有值、文案 `Updated todo list:`——这就是 0.3.x 那条 preset 要求的由来。**0.4.0 起这条对照不再成立**：不删 preset 也拿到 `todo_tree_write`；上面那条实录里「模型调用 `todo_write`」在新版本里会变成「调用 `todo_tree_write`（或两者都调）」。0.4.0 尚未在真模型会话里重录一遍。

## 版本对齐的坑

npm 上 `@deepseek-ai/dsh-*` 的 `dist-tags.latest` 多数仍指向旧的 `0.0.1-rc.1`，而与 `@deepseek-ai/dsh@0.1.0-rc.6` 配套的是 `next` 标签下的 `0.1.0-rc.6`。混用会在运行期炸出缺失导出（例如 `dsh-agent-loop` 需要 `dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER`，旧版没有）。本包的 peer 范围统一钉在 `^0.1.0-rc.6`。

`@deepseek-ai/dsh-session` 声明了未发布的 peer `@deepseek-ai/dsh-type-meta`，因此 `autoInstallPeers` 开启时安装会失败。本包关掉它并显式声明所需 peer；`dsh plugin add` 走 profile 的 healed mirror，不受影响。

## 已知缺口

- **`patches` job 目前对不上当前 master**：`patches/*.patch` 写在 harness `2026-08-17` 前后的修订上，今天用 `origin/master` 的文件 `git apply --check` 三个都报 `patch failed`。它不影响本包的可用性（路线 B 不需要任何 harness 侧改动），但这条 CI lane 需要重新派生或连同 `scripts/assemble-into-harness.mjs` 一起退役。`tool-todo-reciprocal-guard.patch` 已删除：扁平工具不再需要拒绝覆盖 `todo/tree`，那是互斥时代的守卫。
- **计划条只缩进、不可折叠**：按深度缩进各行，没有按节点折叠，较宽的树依赖计划条自身滚动。
- **`mock-adapter.ts` 是复制来的**：harness 把它放在 `packages/core/agent-loop/tests/`，已发布包只含 `lib/`，任何发布产物都不暴露它，因此独立套件自带一份精简版。
- **浏览器半边没有自动化渲染测试**：`tests/client.spec.tsx` 覆盖计划推导、行与计划条的渲染、以及 `apply` 注册出的槽位；真实页面里的计算样式是人工回读的（见上文），没有进 CI。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
