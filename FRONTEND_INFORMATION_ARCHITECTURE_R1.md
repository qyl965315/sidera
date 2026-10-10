# Sidera R1 Frontend — User-Facing Information Architecture

## Core rule
The frontend is **project/task first**, not Node first.

The Human opens Sidera to answer:
1. What projects/workflows are running right now?
2. What tasks exist inside each project?
3. What is the state/progress of each task?
4. If I open a task, who is doing it and what is blocking it?
5. Is anything uncertain or in error and does it need review?

The Human should NOT need to understand Node-internal task decomposition, how many conversations a Node opened, Session placement, Host routing, or Run internals from the main workflow UI.

## User-facing hierarchy

Home
└─ Active Projects
   └─ Project
      └─ Tasks
         └─ Task Detail
            ├─ Assigned Node(s)
            ├─ Node status for this task
            ├─ Parallel groups if applicable
            ├─ Progress / state
            ├─ Dependencies / blockers
            ├─ Outputs / evidence
            └─ Errors / uncertainty

Node/Session/Host/Run internals belong to an **Advanced / System** area, not the default project view.

## Home page

The first visual content after the compact header must be **进行中的项目**.

Each project card shows:
- user-facing project name;
- one-line goal;
- overall state;
- overall progress only when meaningful;
- task counts: 工作中 / 等待中 / 已完成 / 不确定 / 报错;
- the project's current tasks as the primary content.

Each task row/card on Home shows:
- user-facing task name;
- status;
- progress:
  - if a defensible numeric estimate exists, show `约 62%` and mark it as an estimate;
  - if exact progress exists, show exact;
  - otherwise show state only, with no invented percentage;
- optional short blocker/next-step text;
- NO Node identity on the Home task row by default.

Clicking a task opens the Task Detail page.

## Task naming
Separate:
- internal/canonical task name, e.g. `Image Production`;
- Human-facing display name, e.g. `图像生成`.

Home and normal detail UI use the Human-facing display name. Canonical/internal name may appear only in an Advanced details section.

## Normal task states
Exactly four normal task/assignment states:
1. `working` → 工作中
2. `waiting` → 等待中
3. `completed` → 已完成
4. `uncertain` → 不确定

Any other terminal/abnormal execution condition is surfaced as `error` → 报错 and should carry an error code/category when available.

Important:
- uncertain is NOT error;
- uncertain is NOT retryable;
- waiting can represent queued/dependency/review wait with a reason;
- internal backend states may be richer, but the Human-facing projection maps them into this small vocabulary without losing details in the inspector.

## Task Detail

Task is the subject of the page.

Header:
- display name;
- status;
- progress (estimated/exact/state-only);
- project;
- short goal.

Sections:
### 谁在做
Show the Node assignment only here.
Each assigned Node shows:
- Node display name;
- its state for THIS task;
- concise responsibility in this task;
- current blocker if any.

Do not expose Node-internal conversation/session/task decomposition in the default detail.

### Parallel execution
If two or more Nodes are jointly doing the same sub-step concurrently, group them visually in one bounded unit labeled `并行执行组`.
Example:
`图像生成`
└─ 并行执行组
   ├─ Gemini · 工作中
   └─ Grok · 工作中

The grouped unit communicates collaboration; it does not imply a new Node identity.

### Progress / dependencies
Show:
- completed steps;
- current step;
- waiting dependency;
- next known step.
Use plain language.

### Outputs / evidence
Show user-relevant artifacts/results. Exact IDs are secondary/advanced.

### Uncertainty / Error
Uncertain:
- explicit purple/neutral attention state;
- explain what is not proven;
- never show Retry.

Error:
- red error surface;
- display stable error code/category;
- literal reason;
- indicate whether another Node has reviewed/verified it if such evidence exists.

## Project Detail

A project is the Human-facing running workflow.
Show:
- project goal;
- overall state/progress;
- task list grouped by status or ordered execution;
- dependencies between tasks only when they affect Human understanding;
- recent meaningful events;
- counts of Node assignments, but Nodes are secondary.

## Navigation
Default user navigation should become:
- 首页
- 项目
- 异常
- 节点
- 系统

Meaning:
- 首页: active projects and tasks;
- 项目: all active/recent projects;
- 异常: uncertain + errors, with uncertainty separated from error;
- 节点: Node overview for users who want it;
- 系统: connections/effects/resources/events/advanced R1 internals.

Do not expose Mesh/Effects/Resources/Events/Connections as seven equal primary tabs on the default user shell. They may remain as advanced/system subviews.

## Language
- Default zh-CN.
- Explicit 中文 / EN switch.
- Hand-authored translations only.
- Persist selection in localStorage.
- Exact IDs and protocol names are never machine-translated.

## Visual simplification
The current R0 has too many equal-weight borders/cards/status chips/IDs.
R0.1 should:
- reduce visible borders;
- reduce always-visible exact IDs;
- use more whitespace;
- make Project → Task hierarchy obvious through typography/spacing rather than boxes everywhere;
- keep one strong status color per semantic state;
- avoid decorative topology graphics;
- reserve detailed technical evidence for drawers/advanced sections;
- make the eye land on active projects and tasks first.

## R1 boundary
This is an R1 UI. Do NOT redesign backend ontology around R2 multi-session concurrency.
Node internals remain opaque in the Human workflow view.
