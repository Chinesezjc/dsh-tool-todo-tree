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

### 为什么不再需要改 preset

工具表按 scope 链覆盖：agent scope（preset 挂载的那些行）比 host scope 更近，**同名**项由近者胜出。`0.3.x` 注册的是 `todo_write`，而 shipped 的 `standard`/`code`/`cordis` 三个 preset 各自都有一行 `- id: tool-todo`，于是 preset 那一行必然遮蔽 host 层的树形工具——`dsh plugin add` 与 `--dump-config` 都显示配置正确，会话里模型拿到的却是扁平工具（落库 `todo/write`、projection 是 `todos`、文案 `Updated todo list:`）。

`0.4.0` 起工具名是 `todo_tree_write`，不存在同名项，遮蔽不成立，这个坑整条消失。preset 层**没有** patch 语义（harness 自己的 `packages/preset/agent-presets/README.md` 写明「副本会随部署升级漂移，这一层无法表达 standard plus one change」），所以「复制 preset 再删一行」这条路线天生要跟着 harness 发版重新派生——本包不再需要它。

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
- `todoTree` projection：组合了 session-projection 接缝时发布当前整树，供 UI 读取（由下一个 `turn/start` 清空）。它带 `wire` 视图，浏览器端才收得到这棵树
- `allowParallelInProgress`（**必填**，无默认）：`true` 允许任意深度多个节点同时 `in_progress`，`false` 则全树只允许一个、多标即拒绝。与扁平工具同名开关语义一致，因此用它替换扁平工具不会悄悄改掉部署已选的并行策略；工具描述也随之切换
- 父节点只有在全部子节点 `completed` 时才可为 `completed`
- 同层兄弟节点 `content` 去重；空 `children` 归一化为省略该字段
- `maxDepth`（默认 3）收窄接受的嵌套深度，上限为协议常量 `SCHEMA_DEPTH`

**Web 侧**（`exports["./client"]`，由 `dsh.client` 声明，web shell 自行发现并加载）

- 计划条：注册进 `conversation.input.dock`（`id=todo-tree`），读 `todoTree` projection，按深度缩进列出每一层节点；折叠态表头给出跨全部深度的各状态计数
- 卡片外观（`--dsw-alias-border-l1` 边框、12px 圆角、`--dsw-specific-tip` 底色、dock 列宽与 180px 滚动上限、字号字重）与扁平工具的计划条逐条对齐——两者占同一个 dock 位、各按自己的工具数据渲染，**唯一有意的视觉差异是 `.item` 的深度缩进**
- `todo_tree_write` 行：注册进 keyed slot `tool.call.toolview`，key 就是本包的工具名（默认 priority，不再遮蔽任何行），单行摘要逐层统计
- 三个图标按**存在性**解析（`src/icons.ts`）：`ui-primitives` 在 0.1.6 训练线叫 `IconChecklistOutline14`，0.1.7 训练线改叫 `IconChecklistOutlineMedium`，同一个产物要同时跑在两代 shell 上，所以两个名字都试、都没有就只渲染文字
- 两处遍历都用显式栈：它们读的计划都未经校验（行读的是一次调用的 `argsRaw`，即使该调用被 `execute` 拒绝也原样保留；计划条读的可能来自本 build 没写过的日志），递归会把一个畸形计划变成 `RangeError` 并带崩整个会话渲染

## 版本与兼容

本包跟随**当前训练线**，不承诺向后兼容旧 harness：

| | |
|---|---|
| devDependencies | `^0.1.7-alpha.2`（实际解析到 `0.1.7-rc.1`）；`@deepseek-ai/dsh-client-runtime` 走它自己的 `^0.1.1-rc.2` |
| peerDependencies | 下限 `^0.1.5-rc.3`（当前 npm 上 `@deepseek-ai/dsh` 的 `latest`，也是最早带 projection `wire` 的已发布训练线） |

**`0.4.0` 及更早只改了工具名，在当前的 harness 上还有第二个问题**：那时它按 `0.1.0-rc.6` 训练线的 API 注册 projection——`{ schema, view }`。当前 harness 读的是 `{ stateSchema, wire: { viewSchema, view } }`，未知字段被静默忽略（`register` 只校验 `stateVersion`），于是这个 unit 变成 **host-only**，浏览器端永远收不到 `todoTree`，计划条不渲染但也不报错。用运行中的实例实测过这个差别：

```
修前： keys: key,schema,init,apply,view,stateVersion   stateSchema present: false | wire present: false
修后： keys: key,stateSchema,init,apply,wire,...        stateSchema present: true  | wire present: true
```

`0.5.0` 的移植内容：

- projection 用 `stateSchema` + `wire: { viewSchema, view }`（`src/index.ts`），并在 `src/types.ts` 里同时声明 `SessionProjectionStateMap` 与 `SessionProjectionMap`
- companion 读日志改用 `session.snapshotEvents()`：`Session.events` 已不存在，而同步历史读取器被 harness 标为 deprecated（Agent Note `2026-09-09-deprecate-synchronous-session-event-reads.md`）。这里沿用主仓自己 companion 的做法——带一行 `// oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.`
- Web 侧图标按存在性解析，兼容 0.1.6 与 0.1.7 两代名字
- 测试面：`agentLoop.create()` 现在返回 `Promise<Agent>`、`CallId`→`ToolCallId`、`Inbox` 变纯类型（用 testkit 的 `unsupportedInbox()`）、`seq` 是 brand 类型、`persona`→`personaPrefix`、`tool/result` 的 `isError` 在消息顶层

**同步步骤**：harness 再动这几处 API 时，抬 devDependencies 与 peer 下限、重跑 `pnpm run check`、把 `standalone` job 装的 CLI 版本与 `patches` job 的 `ref:` 一起抬到对应修订（见「已知缺口」）。

## 验证

以下均为实跑结果。CI 两个 job：`standalone` 走 npm 安装链路（装当前 published `latest` 的 `@deepseek-ai/dsh@0.1.5-rc.3`），`patches` 走源码树装配链路。

**独立路径（干净 clone + 干净 install）**：`pnpm install` 只从 npm 取依赖；`pnpm run check`（typecheck 两个 face → build → test）exit 0，**9 个文件 / 117 用例全过**；产物 `lib/client.js` 16.5 kB、`lib/index.js` 10.1 kB。

**模型可见的工具面（mock 模型，真实 agent loop）**：`tests/integration.spec.ts` 里按 preset 的方式在 agent scope 挂扁平工具、本包在 host scope，模型依次调用 `todo_tree_write`、`todo_write`、`todo_tree_write`：三次 `tool/result` 全部 `isError: false`，日志得到 2 条 `todo/tree` + 1 条 `todo/write`。这就是「装了就能用」的判据。

**真实安装链路（0.5.0）**：`pnpm pack` → `dsh plugin --profile ttdemo add ./*.tgz` 成功；随后起 web 实例，启动日志 0 条 error，首页 boot graph 里出现 `dsh-tool-todo-tree/client.js`。CI 的 `standalone` job 用**发布版** `@deepseek-ai/dsh@0.1.5-rc.3` 把这条链路整个跑一遍：装包 → 组合前后 `--dump-config` diff **只多出本包那一行**（不给部署禁用扁平行）→ boot 并用 `curl` 确认浏览器半边进了首页 boot graph。

**活 harness 探针**：把构建出的 `lib/` 挂到运行中的 checkout 上，包一层 `sessionProjections.register` 抓取插件真正传入的定义对象，确认 `stateSchema`/`wire` 都在（见上文「版本与兼容」的对照输出）。

**负例验证**（断言能失败才算验证，以下都实跑过）：
- 把 client 半的 keyed key 改回 `todo_write` → `tests/client.spec.tsx` 的 `apply` 用例转红。
- 把 host 半的工具名改回 `todo_write` → `tests/tool-todo-tree.spec.ts` 与 `tests/integration.spec.ts` 12 条以上转红（含「与扁平工具并存」与「preset 不会顶掉树形工具」两条）。
- 图标解析：`tests/icons.spec.ts` 分别对「只有新名」「只有旧名」「两个都没有」「名字存在但不是函数」四种表求值（这正是 0.1.6→0.1.7 那次改名会踩的四种情形）。
- 短路 `maxDepth` 深度检查 → `loader-composition` 的「maxDepth: 1 拒绝嵌套写入」转红。
- `allowParallelInProgress` 双向短路：忽略配置写死「永远单一」→ `true` 用例转红；写死「永远并行」→ `false` 用例转红。
- 删掉 projection 的 fold 分支 → 3 个 last-wins 用例转红；整段删掉 projection 注册 → 对应用例转红。
- 把 `planRows` 改成只遍历顶层 → 8 个用例转红（含计划条缩进、跨深度计数、20 万层嵌套那条）。
- `tests/stylesheet.spec.ts` 四条断言各自反向注入一次：边框 token 换回 `--dsw-alias-line-secondary` → 3 条转红；删掉 `background` → 卡片面断言转红；删掉 `padding-inline-start` → 缩进断言转红；重新引入 `composes:` → 对应断言转红。

### 已修：卡片曾经没有边框和底色

`0.3.0` 之前 `.strip` 用的是 `--dsw-alias-line-secondary`（边框）与 `--dsw-alias-fill-surface-l2`（背景）。**ui-theme 两个都没定义**，浏览器于是丢弃这两条声明：文字与状态图标的 token 都正常解析，所以颜色对，但卡片没有边框、背景透明，读起来像散在 dock 里的一段文字而不是一张卡片。

这个缺陷整条工具链都抓不到：未定义的自定义属性不是错误，`typecheck`、组件测试（jsdom 不做主题解析）、`bundle.spec.ts`（只断言产物格式）全部照绿。唯一能抓住它的位置是把 token 名钉在「已在真实页面回读过」的集合上，这就是 `tests/stylesheet.spec.ts` 的职责——新增 token 前必须先在运行中的页面里读出它的值。

顺带两个实测结论：shell 自己的 `ui-conversation/ContextBody.module.css` 也在引用同一个失效的 `--dsw-alias-line-secondary`（不止本插件）；`--dsw-alias-fill-l2` 同样解析不出来，所以它不能当替代品，正确的背景 token 是 `--dsw-specific-tip`。

另外 `composes:` 在本包的构建链下**不会展开**——产物里 `.row` 的类名不含被借用的类，规则会静默丢掉布局。已改为每条规则各自写全，并由断言守住。

### 历史：0.3.1 的真模型实录（当时还必须改 preset）

隔离 `DSH_HOME`、真 API key、preset 已删掉扁平工具那一项：模型一次调用 `todo_write` 写出三父六子的嵌套计划后——落库事件是 `todo/tree`；projection 里出现 `todoTree` 且携带完整嵌套数据，`todos` 键不存在；工具结果文案是 `Update todo tree`。真实浏览器页面里计划条显示 `Todo tree · 1 in progress · 8 pending`，工具行显示 `Update todo tree · 0/9 completed · 调研`（9 = 3 父 + 6 子）。

同一条件下**不改 preset** 的对照组：落库 `todo/write`、projection 里 `todoTree` 为 `null` 而 `todos` 有值、文案 `Updated todo list:`——这就是 0.3.x 那条 preset 要求的由来。`0.4.0` 起这条对照不再成立，`0.5.0` 起计划条的 wire 也修好了；**0.5.0 尚未在真模型会话里重录一遍**（工具面与 wire 注册见上文两条实测）。

## 已知缺口

- **`patches` lane 钉在一个 harness 修订上**：三个 patch 编辑的文件逐个列出 harness 已发布的工具名，因此 job 的 checkout 钉在公开仓 `deepseek-ai/deepseek-harness` 的 `00102833dfa`（2026-09-23 master），否则任何新增工具的 harness 提交都会让它变红。**同步步骤**：在目标修订上起一个 worktree → `node scripts/assemble-into-harness.mjs <worktree>` → 重新施加三处改动（根 `package.json` 的 workspace devDependency、`scripts/gen-tool-catalog.ts` 的 import 与 catalog 条目、`packages/core/tools/tests/gen-tool-catalog.spec.ts` 的期望工具名列表）→ `git diff -- <file>` 覆盖 `patches/` 三个文件 → 更新 ci.yml 里的 `ref:`。注意 `~/deepseek-harness` 的 origin 是**私有**仓，派生必须对着公开仓做。
- **组件测试里 `ui-primitives` 是替身**：它是浏览器平台模块（shell 通过注入的 `require` 提供），在 Node 里要装 clsx/katex/shiki/micromark 一整条链才能渲染一个组件，因此 `vitest.config.ts` 把它 alias 到 `tests/ui-primitives-stub.tsx`。产物本身仍要求真实的 `@deepseek-ai/dsh-client-ui-primitives`（`tests/bundle.spec.ts` 钉着这一条），两代图标名由 `tests/icons.spec.ts` 覆盖。
- **计划条只缩进、不可折叠**：按深度缩进各行，没有按节点折叠，较宽的树依赖计划条自身滚动。
- **`mock-adapter.ts` 是复制来的**：harness 把它放在 `packages/core/agent-loop/tests/`，已发布包只含 `lib/`，任何发布产物都不暴露它，因此独立套件自带一份精简版。
- **浏览器半边没有自动化渲染测试**：`tests/client.spec.tsx` 覆盖计划推导、行与计划条的渲染、以及 `apply` 注册出的槽位；真实页面里的计算样式是人工回读的（见上文），没有进 CI。

## 许可

[MIT](LICENSE)，Copyright (c) 2026 Chinesezjc。
