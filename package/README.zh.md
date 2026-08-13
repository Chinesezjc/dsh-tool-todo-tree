# @deepseek-ai/dsh-tool-todo-tree

[English](README.md) | 中文

面向模型的嵌套 `todo_write` 工具：agent（智能体）的完整任务树，每次调用都会整体替换。它是 [`dsh-tool-todo`](../tool-todo) 的树形替代方案——每个部署只挂载两者之一。

## 功能

注册一个工具 `todo_write(todos: [{ content, status, children? }])` 到 `ctx.tools`。模型每次调用都会发送完整的树，不存在部分更新或单项编辑。每次调用都会向调用 agent 的会话日志追加 `todo/tree` 事件（完整树快照），具体调用 `agent.session.append('todo/tree', { todos })`；当前树是最新的该类事件（回放时后写者胜）。

`status` 是 `pending`、`in_progress` 或 `completed` 之一。`children` 将子任务嵌套在其父任务之下；当节点没有子节点时，规范形态会省略该字段（而非写成 `[]`）。

## 与扁平工具的互斥

本包与 `dsh-tool-todo` 都注册名称 `todo_write`。工具注册表在注册时拒绝重复项，因此后挂载的那个插件无法装上自己的工具——每个部署选择扁平列表或树，绝不同时选择两者。失败的那个 entry 的 fiber 会 settle 为 `FAILED`，而 `@deepseek-ai/dsh-app-boot` 中的 `assertEntriesActivated` 正是审计该状态，因此同时挂载两者的组合会在启动时被报出，而不是静默地以先挂载成功的工具继续运行。两者还写入不同的会话事件（`todo/write` 对 `todo/tree`），因此消费方始终知道某条日志条目携带哪种形态。

该名称冲突是**按注册层**生效的。scoped 注册（`agent.ctx`）会刻意遮蔽同名的 global 注册，而不是与它冲突，这会让形态选择取决于 fiber 生命周期：一旦该遮蔽被 dispose 或 HMR 卸载，那个 agent 就会静默回落到 global 工具，会话日志最终同时携带两种事件类型，且没有任何记录表明哪一种在何时是权威。因此 `apply` 直接拒绝 scoped 上下文——请在组合根处禁用不想要的那个 entry 来选择形态。镜像组合（**扁平**工具以 scoped 方式遮蔽 global 的树工具）不由本包在加载期拒绝，因此当会话日志已携带 `todo/write` 条目时，`execute` 会拒绝追加。在已交付的部署里真正守住该保证的是这条运行期拒绝，而不是不变式（invariant）companion：companion 属于可选的诊断设施，没有任何已交付组合会挂载它。companion 仍会拒绝任何同时持有两种事件类型的日志，覆盖并非本部署写入的持久日志。

## Schema 深度与配置深度

参数 schema DSL 不支持递归，因此对外公布的 JSON schema 会将节点形状逐字展开到 `SCHEMA_DEPTH`（3）层；最内层仍声明 `children`，但声明为不带元素形状的无类型数组，因为已经没有第四层可以描述。这样既对外公布了深度上限，又让 `children: []` 在每一层的写法保持一致；上限本身由 `execute` 强制执行，而非 schema。`SCHEMA_DEPTH` 是模型契约的一部分，而非可调项。`maxDepth` 配置（默认 `SCHEMA_DEPTH`）将接受的深度收窄到该值或更低；超出 `1..SCHEMA_DEPTH` 的值会在加载期被拒绝，因为强制执行超过 schema 所公布的深度会让契约与执行悄然分歧。

## 单一所有者

该树属于调用工具的唯一 agent 会话。不存在 subagent／共享／swarm scope：非 agent 调用方（没有 `exec.agent`）无处写入树，因此会被拒绝——与扁平工具相同的有意 scope 限制。

## 验证

除 schema 的类型／必填／枚举检查外，`execute` 还会拒绝空 `content`、同级组内重复的 `content`（同一文案可以在不同层级重复出现——父任务与其子步骤可以共享标签）、整棵树中多于一个 `in_progress` 节点、超出配置 `maxDepth` 的嵌套，以及子节点未全部 `completed` 的 `completed` 父节点。空 `children` 数组会在记录前被规范化为省略字段。

`./invariant` companion 独立于工具校验**持久**快照，因此也覆盖并非本部署写入的日志：它强制执行 `SCHEMA_DEPTH` 协议上限而非本地 `maxDepth`，重复检查同级去重、单一 `in_progress` 以及 completed 父节点这几条规则，拒绝 `children: []`（规范化意味着持久快照绝不会写成那样），拒绝同时携带 `todo/tree` 与 `todo/write` 的日志，并拒绝位于开启 turn 之外的 `todo/tree` 快照。该 turn 封闭规则与 [`dsh-session`](../../core/session) companion 对扁平 `todo/write` 的要求一致：那项检查有意忽略可合并扩展的事件变体，因此本包为自己的事件承担这条规则。它成立的前提是 `todo_write` 是唯一生产者，且它从 `execute` 追加，而 agent loop 只会在 turn 内到达那里。两项检查共享对日志的同一次折叠：每个会话只扫描一次，随后每次 todo 追加只折入一个事件，因此开销与会话长度成线性关系，而不会在每个流式事件上重新扫描。被拒绝的追加不会推进该状态，因为它携带的事件从未进入日志。

## 渲染

规范结果为 `{ todos, counts: { pending, inProgress, completed } }`，其中 `counts` 汇总任意深度的每个节点；其 Native 渲染器返回精简的更新确认。工具还会写入完整 `todo/tree` 会话事件，并在组合了 session-projection 接缝时把当前树发布到 `todoTree` projection 键（last-write-wins，由下一个 `turn/start` 清空）。

浏览器端有两个界面消费它们。每次调用的 `TodoRow` 以本包与扁平工具共享的工具**名称**为键，读取调用参数，并用显式栈统计 `children`——它读取的参数未经校验，递归遍历会把渲染调用栈撑爆——因此那一行摘要汇总了每个节点。`TodoPanel` 计划条读取 projection：它接受两种计划形状，并按深度缩进每一行，因此扁平部署的渲染与原先完全一致，树形部署则显示层级。

## 导出形状

函数／命名空间插件：导出 `name`/`inject`/`apply`，不提供默认导出。意外的 `export default` 会通过 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型所见内容

模型会看到生成的 [`todo_write` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo-tree)——嵌套节点形状展开为三个字面层级。

#### Token 影响

工具可见的每个请求都有固定 schema 成本；三层字面展开使其比扁平工具的 schema 更大。

#### KV Cache 影响

只要定义和可见性不变，前缀就保持稳定。插件生命周期或 scope 限制可能会使此 schema 之后的复用失效。

### 工具调用历史与结果

#### 模型所见内容

每个 assistant 工具调用都会在参数中保留整棵替换树。成功时精确返回 `Updated todo tree: <pending> pending, <inProgress> in progress, <completed> completed.`。稳定失败文本为 ``Error: invalid todo: `content` must be a non-empty string``、`Error: invalid todos: duplicate sibling content "<content>"`、`Error: invalid todos: completed task "<content>" has unfinished children`、`Error: invalid todos: at most one task may be in_progress, got <count>`、`Error: invalid todos: tree exceeds the configured maximum depth of <maxDepth>` `Error: todo_write requires an owning agent session` 和 `Error: session already carries a flat todo/write list; a deployment must mount exactly one todo tool`。完整 `todo/tree` 会话事件是 UI 与回放状态，而非第二条模型消息。

#### Token 影响

Token 增长与模型每次提交的完整树成比例，且这些调用参数会保留到压缩（compaction）。结果本身很小，且形状固定。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延后工作

- **仅单一所有者 scope**：树属于唯一调用 agent 会话；subagent／共享／swarm scope 是有意裁减，非 agent 调用方会被拒绝。
- **嵌套上限为三层**：schema DSL 无法表达递归，因此对外公布的形状是固定的字面展开；更深的计划必须在第三层分组。
- **整树替换是唯一操作**：没有部分更新，也没有回读工具；模型每次调用都必须重新发送整棵树。
- **深度只做缩进，不可折叠**：计划条按深度缩进各行，但没有按节点折叠，因此较宽的树依赖计划条自身的滚动。
- **非浏览器界面不渲染**：已交付的消费方是 projection 与浏览器端的行／计划条；其他想要持久树形视图的 host 需自行订阅 `todo/tree` 并渲染。
