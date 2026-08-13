# @deepseek-ai/dsh-tool-todo-tree

English | [中文](README.zh.md)

The model-facing NESTED `todo_write` tool: the agent's whole task tree, replaced wholesale on each call. The tree-shaped alternative to [`dsh-tool-todo`](../tool-todo) — a deployment mounts exactly one of the two.

## What it does

Registers one tool, `todo_write(todos: [{ content, status, children? }])`, on `ctx.tools`. The model sends the ENTIRE tree every call — there are no partial updates or per-item edits. Each call appends a `todo/tree` event (the full tree snapshot) to the calling agent's session log via `agent.session.append('todo/tree', { todos })`; the current tree is the most recent such event (last-write-wins on replay).

`status` is one of `pending`, `in_progress`, or `completed`. `children` nests sub-tasks under their parent; a canonical node omits the field when it has no children (never `[]`).

## Mutual exclusion with the flat tool

This package and `dsh-tool-todo` both register the name `todo_write`. The tool registry rejects the duplicate at registration, so the second plugin to mount cannot install its tool — a deployment picks the flat list or the tree, never both. The losing entry's fiber settles `FAILED`, and `assertEntriesActivated` in `@deepseek-ai/dsh-app-boot` audits exactly that state, so a composition mounting both is reported at startup rather than silently running on whichever tool mounted first. The two also write DIFFERENT session events (`todo/write` vs `todo/tree`), so consumers always know which shape a log entry carries.

That collision is per registry LAYER. A scoped registration (`agent.ctx`) deliberately shadows a same-named global rather than colliding with it, which would make shape selection depend on fiber lifetime: disposing or HMR-unloading the shadow silently returns that agent to the global tool, and the session log ends up carrying both event types with no record of which was authoritative when. So `apply` refuses a scoped context outright — select a shape by disabling the entry you do not want at the composition root. The mirror composition (the FLAT tool scoped over a global tree) is not this package's to reject at load, so `execute` refuses to append when the session log already carries a `todo/write` entry. That runtime refusal, not the invariant companion, is what holds the guarantee in a shipped deployment: companions are opt-in diagnostics and no shipped composition mounts one. The companion still rejects any log holding both event types, covering a persisted log this deployment did not write.

## Schema depth vs configured depth

The parameter schema DSL has no recursion, so the advertised JSON schema spells the node shape out literally to `SCHEMA_DEPTH` (3) levels; the innermost level still declares `children`, but as an untyped array with no element shape, because there is no fourth level to describe. That advertises the cap while keeping `children: []` spelled the same way at every depth; the cap itself is enforced in `execute`, not by the schema. `SCHEMA_DEPTH` is part of the model contract, not a tunable. The `maxDepth` config (default `SCHEMA_DEPTH`) narrows the ACCEPTED depth at or below it; a value outside `1..SCHEMA_DEPTH` is rejected at load, because enforcing more than the schema advertises would silently diverge contract from enforcement.

## Single owner

The tree belongs to the ONE agent session that called the tool. There is no subagent/shared/swarm scope: a non-agent caller (no `exec.agent`) has nowhere to write the tree and is rejected — the same deliberate scope limit as the flat tool.

## Validation

Beyond the schema's type/required/enum checks, `execute` rejects an empty `content`, a duplicate `content` WITHIN a sibling group (the same line may recur on different levels — a parent and its sub-step can share a label), more than one `in_progress` node across the WHOLE tree, nesting beyond the configured `maxDepth`, and a `completed` parent over a child that is not `completed`. An empty `children` array is canonicalized to an absent field before logging.

The `./invariant` companion validates DURABLE snapshots independently of the tool, so it also covers logs this deployment did not write: it enforces the `SCHEMA_DEPTH` protocol cap rather than the local `maxDepth`, repeats the sibling-dedup, one-`in_progress`, and completed-parent rules, rejects `children: []` (canonicalization means a durable snapshot never spells it that way), rejects a log carrying both `todo/tree` and `todo/write`, and rejects a `todo/tree` snapshot outside an open turn. The enclosure rule mirrors what [`dsh-session`](../../core/session)'s companion requires of the flat `todo/write`: that check deliberately ignores merge-extensible variants, so this package owns the rule for its own event. It holds because `todo_write` is the only producer and appends from `execute`, which the agent loop reaches only inside a turn. Both checks share one fold over the log: each session is scanned once, then one event is folded per todo append, so cost stays linear in a session's length rather than rescanning on every streamed event. A rejected append does not advance that state, because the event it carried never reached the log.

## Rendering

The canonical result is `{ todos, counts: { pending, inProgress, completed } }` where `counts` totals every node at any depth; its Native renderer returns the compact update acknowledgement. The tool also writes the full `todo/tree` session event. No shipped renderer consumes that event yet: a host that wants a durable tree view subscribes to the event stream and renders it itself. The browser client's per-call `TodoRow` is the one shipped surface that does reflect a tree, because it is keyed by the tool NAME this package shares with the flat tool and reads the call args rather than the event; it counts through `children` with an explicit stack (the args it reads are unvalidated, so a recursive walk would overflow the render stack), so its one-line summary totals every node.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`todo_write` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-todo-tree) — the nested node shape expanded to three literal levels.

#### Token effect

Fixed schema cost on every request where the tool is visible; the literal three-level expansion makes it larger than the flat tool's schema.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each assistant tool call retains the entire replacement tree in its arguments. Success returns exactly `Updated todo tree: <pending> pending, <inProgress> in progress, <completed> completed.` Stable failures are ``Error: invalid todo: `content` must be a non-empty string``, `Error: invalid todos: duplicate sibling content "<content>"`, `Error: invalid todos: completed task "<content>" has unfinished children`, `Error: invalid todos: at most one task may be in_progress, got <count>`, `Error: invalid todos: tree exceeds the configured maximum depth of <maxDepth>`, `Error: todo_write requires an owning agent session`, and `Error: session already carries a flat todo/write list; a deployment must mount exactly one todo tool`. The full `todo/tree` session event is UI and replay state, not a second model message.

#### Token effect

Token growth scales with every full tree the model submits, and those call arguments remain until compaction. The result itself is small and fixed-shape.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Single-owner scope only** — the tree belongs to the one calling agent session; subagent/shared/swarm scopes are a deliberate cut, and a non-agent caller is rejected.
- **Nesting is capped at three levels** — the schema DSL cannot express recursion, so the advertised shape is a fixed literal expansion; deeper plans must group at the third level.
- **Whole-tree replacement is the only operation** — no partial updates, no read-back tool; the model must resend the entire tree each call.
- **Flat-UI deployments see nothing** — UIs render `todo/tree` events only if they implement the tree renderer; the flat `todo/write` renderers ignore this event by design.
