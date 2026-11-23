# @naivezip/pi-swarm

Multi-agent swarm orchestration package for Pi (`@earendil-works/pi-coding-agent`), providing a shared message board, in-process SDK workers, isolated git workspaces, a stall monitor scheduler, and an interactive TUI board overlay.

## Demo

Recorded live in Pi on WSL using `magpie / workbuddy/deepseek-v4.1-flash` (`math` + `strings` editing disjoint files in parallel, `verifier` extending tests and running `npm test` 11/11 pass, live TUI status widget, and `Alt+S` 3-tab Board Overlay):

![pi-swarm live demo](assets/demo.gif)

[Download / watch full MP4 recording](assets/demo.mp4)

## Install

Install from npm:

```bash
pi install npm:@naivezip/pi-swarm
```

Or install from GitHub:

```bash
pi install git:github.com/naivezip/pi-swarm
```

Or install from a local checkout:

```bash
pi install d:\pi-swarm
```

Or load for a single session without modifying settings:

```bash
pi -e d:\pi-swarm
```

## Commands & Shortcut

Swarm tools are registered with `defaultActive: false` so normal Pi sessions incur zero prompt or tool overhead until activated.

- `/swarm <task>`: Enables coordinator mode, activates the `swarm` tool, injects coordinator (`swarm`, `swarm-pane`) skill guidance, and sends `<task>` to the coordinator.
- `/swarm`: Opens the interactive Swarm Board Overlay if a swarm exists for the current session; otherwise enables coordinator mode (`swarm` tool).
- `/swarm ui`: Opens the 3-tab Swarm Board Overlay (or prints a plain-text summary in non-TUI modes).
- `/swarm stop`: Aborts all currently running workers without deleting their histories or workspaces.
- `/swarm off`: Deactivates coordinator mode and removes all 4 swarm tools from active tools (warns if workers are still running).
- `/swarm clean`: Removes stale swarm worktrees and clones from other sessions under `~/.pi/agent/swarms/`.
- `Alt+S`: Keyboard shortcut to open the Swarm Board Overlay when a swarm is active.

## Tools

Coordinator and worker sessions share four core tools (`post_message`, `read_board`, and `swarm_wait` activate for the coordinator as soon as the first worker is added or on session restore):

- `swarm`: Manage the swarm (`status`, `models`, `add`, `model`, `kill`, `title`, `channel`, `plan`).
  - `add`: Spawn a worker or sharded/homogeneous group (`tasks` / `n`), with optional `model`, `workspace` (`inherit` | `share` | `branch`), `fork` (`"coordinator"` or worker name), and `channels`.
  - `model`: Switch a `waiting` worker's (or own) model while preserving conversation history and resuming unfinished/errored turns.
  - `kill`: Permanently terminate a worker or group and delete its `share`/`branch` workspace.
  - `channel`: `create`, `list`, `subscribe`, `unsubscribe`, `archive`.
  - `plan`: Persist structured goal/threads/tasks in `plan.json` for the TUI Overview tab.
- `post_message`: Post to `#main` or a subscribed channel; `@name`, `@group`, `@all`, and `@#channel` wake recipients (mentions inside code blocks are ignored; `@#main` is refused).
- `read_board`: Read visible board messages (`since`, `limit`, `channel`, or `status: true` for detailed roster/cursor diagnostics).
- `swarm_wait`: Non-blocking park (`since`, `mentions_only`). Returns immediately if matching unread posts exist; otherwise registers the wait cursor so the host/runtime wakes the caller asynchronously on the next matching post.

Monitor workers (`monitor` or `monitor-<N>`) also receive:

- `schedule`: Create one-shot timers (`DurationSeconds`) or 5-field crons (`CronExpression`, `IsDaemon`).
- `manage_task`: List or kill scheduled monitor tasks.

## Skills

- `swarm` (`skills/swarm/SKILL.md`): Coordinator orchestration guide (delegation, workspaces, channels, addressing, non-blocking waiting, quota/rate-limit recovery).
- `swarm-monitor` (`skills/swarm-monitor/SKILL.md`): Stall-detection protocol for `monitor` workers.
- `swarm-pane` (`skills/swarm-pane/SKILL.md`): Concise `plan.json` structure for the TUI Overview tab.

## TUI Widget & Overlay

- **Persistent Widget** (`ctx.ui.setWidget("pi-swarm", ...)`): Displays swarm title, channel/post count, live worker states (`working`, `waiting`, `stopped`, `killed`), current tool activity or error tags, cumulative tokens/cost, and shortcut hint (`Alt+S` / `/swarm`).
- **Interactive Overlay** (`ctx.ui.custom(..., { overlay: true })`):
  - **Overview (`1`)**: Renders `plan.json` (`goal`, `threads`, assigned `tasks` with live worker status) or falls back to a live roster and channels summary.
  - **Board (`2`)**: Scrollable feed with `@mention` highlighting, channel filter (`c`), member filter (`m`), and `r` / `Enter` to prefill `#<seq> ` into the coordinator editor.
  - **Workers (`3`)**: Worker list + live transcript & streaming detail pane with safe actions: `k` (confirm & kill), `M` (switch model when waiting), `S` (stop all running workers).
  - Press `1`/`2`/`3`, `Tab`/`Shift+Tab`, or `Left`/`Right` to switch tabs; `Esc` or `q` to close.

## Architecture

- `src/types.ts`: Canonical state, board, plan, scheduler, and validation types.
- `src/board.ts`: Append-only `board.jsonl`, atomic `state.json` and `plan.json` persistence under `~/.pi/agent/swarms/<sessionId>/`, channel visibility, and wake matching.
- `src/workspace.ts`: Git worktree (`share`), local git clone (`branch`), `inherit`, and stale workspace cleanup.
- `src/scheduler.ts`: 5-field cron and one-shot timer engine for monitor workers.
- `src/runtime.ts`: `SwarmManager` managing in-process `createAgentSession` workers, `DefaultResourceLoader({ noExtensions: true, extensionFactories: [createMcpExtension(), workerExtension] })`, branch-safe session forking, non-blocking parks, and async wakeups.
- `src/tools.ts`: TypeBox tool definitions and TUI call/result renderers.
- `src/ui.ts`: Throttled TUI widget, 3-tab interactive overlay, and non-TUI plain-text fallback.
- `extensions/index.ts`: Pi extension entry point (`defaultActive: false` tools, `/swarm` command, `Alt+S` shortcut, session restore/shutdown lifecycle, coordinator wakeup).

## Development

```bash
npm run typecheck
npm test
```
