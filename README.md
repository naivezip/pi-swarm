# @naivezip/pi-swarm

English | [简体中文](./README.zh.md)

## What does this do?

Turns a single [Pi](https://pi.dev) coding session into a coordinated multi-agent swarm—parallel workers in isolated git workspaces, a shared `@mention` message board, non-blocking background shells, and a live TUI dashboard. *(Inspired by Antigravity's swarm, built natively for `@earendil-works/pi-coding-agent`.)*

![pi-swarm live demo](https://raw.githubusercontent.com/naivezip/pi-swarm/main/assets/demo.gif)

<sub>Recorded live in Pi (`math` + `strings` editing disjoint files in parallel, `verifier` extending and running `npm test` 11/11 pass, live TUI status widget, and `Alt+S` Board Overlay) · <a href="https://raw.githubusercontent.com/naivezip/pi-swarm/main/assets/demo.mp4">Watch full MP4</a></sub>

## Why should I care?

- **Parallelize real repo work without git collisions** — Single-agent sessions bottleneck on multi-module tasks, while naive subagents overwrite each other's working tree. `pi-swarm` isolates workers in git worktrees (`share`) or clones (`branch`) so multiple agents edit, build, and verify concurrently.
- **Peer-to-peer coordination without polling waste** — Instead of routing every handoff through a bloated parent context or burning tokens in sleep loops, workers coordinate directly on `#main` and topic `#channels`, parking at zero cost (`swarm_wait`) until `@mention`ed.
- **Long builds and dev servers never freeze a worker** — Workers get an async-promoting `bash` shell (`manage_process`): quick commands return inline, while long test runs or daemons promote seamlessly to the background and wake the worker on exit—watched by a read-only `monitor` scheduler that catches stalls.
- **Full TUI visibility & hot model switching (zero overhead when off)** — Swarm tools register with `defaultActive: false`, adding **zero prompt or tool tokens** to normal Pi sessions. When active, inspect plans, board feeds, background processes, and live transcripts—or hot-swap a rate-limited worker's model without losing its conversation history.

## How do I use it?

### 1. Kick off a swarm in one command

```text
/swarm Implement math and string utilities in parallel, then have a verifier expand and run the test suite
```

Pi enables coordinator mode, breaks your goal into parallel threads, spawns workers in isolated git workspaces, and wakes the coordinator automatically as workers report back.

### 2. Watch and steer live (`Alt+S`)

While a swarm runs, a compact widget above your prompt tracks worker states (`working`, `waiting`, `stopped`, `killed`), active background processes (`N bg`), and cumulative tokens/cost.

Press **`Alt+S`** (or run `/swarm ui`) anytime to open the **3-tab Swarm Board Overlay**:

- **`1` Overview** — Structured `plan.json` view (`goal`, `threads`, assigned worker states, and `[N bg]` process badges). Press `Enter` on any worker to jump straight into its session.
- **`2` Board** — Scrollable message feed with `@mention` highlights, channel/member filters (`c` / `m`), and `r` / `Enter` to prefill `#<seq> ` into the coordinator input.
- **`3` Workers** — Worker roster + live transcript and `Background Processes` inspector (`taskId`, `[daemon]`, `elapsed` / `silent` durations), plus `M` (switch model when idle), `k` (confirm & kill), `S` (stop all running workers), or `Enter` to open **Worker View**.
- **Full-screen Worker View (`Enter`)** — Interact directly with an individual worker: `Enter` to prompt or steer mid-turn, `Alt+Enter` to queue a follow-up, `Ctrl+O` / `Ctrl+T` to toggle tool output or thinking blocks, `/model`, `/abort`, `/kill`, `/exit` slash commands, `Alt+S` to return to the board, or `Ctrl+D` to return to the coordinator.

*(Non-TUI `print` / `json` / `rpc` modes automatically fall back to clean plain-text summaries.)*

### 3. Commands & shortcuts

| Command / Key | What it does |
| :--- | :--- |
| `/swarm <task>` | Enable coordinator mode, inject swarm skills, and start orchestrating `<task>` |
| `/swarm` | Open the Swarm Board Overlay if a swarm exists; otherwise enable coordinator mode |
| `/swarm ui` / `Alt+S` | Open the 3-tab Swarm Board Overlay |
| `/swarm stop` | Abort all running workers and their background processes (keeps history & workspaces) |
| `/swarm off` | Exit coordinator mode and remove swarm tools from active tools |
| `/swarm clean` | Remove stale swarm worktrees/clones from previous sessions under `~/.pi/agent/swarms/` |

<details>
<summary><strong>Under the hood: Agent Tools, Skills & Architecture</strong></summary>

#### Swarm & Worker Tools

Coordinator and worker sessions share four core tools (`post_message`, `read_board`, and `swarm_wait` activate for the coordinator once the first worker is added or restored):

- `swarm` — Manage the swarm (`status`, `models`, `add`, `model`, `kill`, `title`, `channel`, `plan`):
  - `add`: Spawn a worker or sharded/homogeneous group (`tasks` / `n`), with optional `model`, `workspace` (`inherit` | `share` | `branch`), `fork` (`"coordinator"` or worker name), and `channels`.
  - `model`: Switch a `waiting`/`stopped` worker's (or own) model while preserving history and resuming unfinished turns.
  - `kill`: Permanently terminate a worker or group, kill its background process trees, and delete its `share`/`branch` workspace.
  - `channel`: `create`, `list`, `subscribe`, `unsubscribe`, `archive`.
  - `plan`: Persist structured goal/threads/tasks in `plan.json` for the TUI Overview tab.
- `post_message` — Post to `#main` or a subscribed channel; `@name`, `@group`, `@all`, and `@#channel` wake recipients (code-block mentions ignored; `@#main` refused).
- `read_board` — Read visible board messages (`since`, `limit`, `channel`, or `status: true` for roster, cursor, and background process diagnostics).
- `swarm_wait` — Non-blocking park (`since`, `mentions_only`) that wakes asynchronously on the next matching post.

Worker-specific tools:

- **Non-monitor workers (`bash` + `manage_process`)** — Replaces blocking `bash` with sync-to-async promotion (`wait_ms` default `10000`, max `30000`; `is_daemon`; `notify_after_seconds` default `120`). Commands exceeding `wait_ms` keep running in the background (`taskId` + output tail) and wake the worker on `process_exit` or `process_still_running`. `manage_process` (`list`, `status`, `send_input`, `kill`) enforces per-worker isolation and full process-tree termination.
- **Monitor workers (`schedule` + `manage_task`)** — Strictly read-only (`monitor` / `monitor-<N>`); runs one-shot timers (`DurationSeconds`) or 5-field crons (`CronExpression`, `IsDaemon`) to detect and unstick stalled workers.

#### Bundled Skills

- `swarm` (`skills/swarm/SKILL.md`) — Coordinator orchestration guide (delegation, workspaces, channels, addressing, non-blocking waiting, rate-limit recovery).
- `swarm-monitor` (`skills/swarm-monitor/SKILL.md`) — Stall-detection protocol distinguishing active background builds from stuck silent processes and daemons.
- `swarm-pane` (`skills/swarm-pane/SKILL.md`) — `plan.json` schema for the TUI Overview tab.

#### Architecture

- `extensions/index.ts` — Pi extension entry point (`defaultActive: false` tools, `/swarm` command, `Alt+S` shortcut, session restore/shutdown lifecycle, queued coordinator wakeups).
- `src/runtime.ts` — `SwarmManager` managing in-process `createAgentSession` workers, branch-safe session forking, non-blocking parks, and async wakeups.
- `src/board.ts` — Append-only `board.jsonl`, atomic `state.json` & `plan.json` persistence under `~/.pi/agent/swarms/<sessionId>/`, channel visibility, and `@mention` wake matching.
- `src/workspace.ts` — Git worktree (`share`), local git clone (`branch`), `inherit`, and stale workspace cleanup.
- `src/process-manager.ts` — `BackgroundProcessManager` with sync-to-async promotion, rolling tail buffers + log spillover, silence tracking, stdin delivery, and cross-platform process-tree termination.
- `src/scheduler.ts` — 5-field cron and one-shot timer engine for monitor workers.
- `src/ui.ts` & `src/worker-view*.ts` — Throttled TUI widget, 3-tab Swarm Board Overlay, full-screen interactive Worker View, and plain-text fallbacks.
- `docs/specs/` — Design docs and Quint formal specs (`async_background_shell.qnt`, `swarm_worker_view.qnt`).

</details>

## How do I install it?

Published on [pi.dev](https://pi.dev) and npm as `@naivezip/pi-swarm` (requires Pi and Node.js `>= 22.19.0`).

**Try it for a single session first** (no config changes):

```bash
pi -e npm:@naivezip/pi-swarm
```

**Install globally** via Pi's package manager:

```bash
pi install npm:@naivezip/pi-swarm
```

**Or install per-project** (writes to `.pi/settings.json`):

```bash
pi install -l npm:@naivezip/pi-swarm
```

<details>
<summary>Update, uninstall, or run from source</summary>

Manage installed packages:

```bash
pi list
pi update
pi remove npm:@naivezip/pi-swarm
```

Install from GitHub or a local checkout:

```bash
pi install git:github.com/naivezip/pi-swarm
pi install ./path/to/pi-swarm
pi -e ./path/to/pi-swarm
```

Local development checks:

```bash
npm run typecheck
npm test
```

</details>
