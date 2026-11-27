# @naivezip/pi-swarm

[English](./README.md) | 简体中文

## 这是什么？

把单个 [Pi](https://pi.dev) 编程会话升级为协同工作的多 Agent 蜂群（Swarm）——在隔离的 Git 工作区中并行开发、通过共享 `@mention` 消息看板直接协作、支持不阻塞的异步后台 Shell，并提供实时可控的 TUI 仪表盘。*（灵感源自 Antigravity Swarm，专为 `@earendil-works/pi-coding-agent` 原生打造。）*

![pi-swarm 实机演示](https://raw.githubusercontent.com/naivezip/pi-swarm/main/assets/demo.gif)

<sub>Pi 实机录制（`math` 与 `strings` 并行修改互不冲突的文件，`verifier` 补充测试并跑通 `npm test` 11/11，配合底部实时状态栏与 `Alt+S` 三标签页看板）· <a href="https://raw.githubusercontent.com/naivezip/pi-swarm/main/assets/demo.mp4">观看完整 MP4 录屏</a></sub>

## 为什么值得用？

- **真正并行改代码，不怕 Git 工作区互踩** — 单 Agent 串行处理多模块任务太慢，普通子 Agent 并发又容易互相覆盖文件。`pi-swarm` 为 Worker 自动分配独立的 Git worktree（`share`）或本地克隆（`branch`），让前后端重构、补测与验证安全并行。
- **Agent 之间点对点协作，告别轮询烧 Token** — 无需把所有中间沟通塞爆主控上下文，也不必靠死循环轮询等待。Worker 直接在 `#main` 或专题 `#channel` 发帖协作，空闲时通过 `swarm_wait` 零开销挂起，仅在被 `@` 提及时精准唤醒。
- **长耗时构建与常驻服务不再卡死会话** — Worker 内置“短命令同步返回、长命令自动转后台”的异步 `bash`（配合 `manage_process`）：跑全量测试或启动开发服务器超时无需中断，自动转入后台并在结束时唤醒所属 Worker；同时支持只读 `monitor` 定时巡检并解救卡住的任务。
- **TUI 全程可视可控，平时零上下文开销** — 所有 Swarm 工具默认 `defaultActive: false`，日常使用普通 Pi 会话**零提示词膨胀、零额外 Token**。激活后可随时查看计划图、消息流、后台进程与 Worker 实时对话，遇到限流还能保留上下文热切换模型。

## 怎么用？

### 1. 一条命令拉起蜂群

```text
/swarm 并行实现 math 与 string 工具模块，并安排 verifier 补充和运行全量测试
```

Pi 会自动进入协调者（Coordinator）模式，将目标拆分为并行线程、在隔离工作区拉起各路 Worker，并在任务推进或完成时自动唤醒主会话汇报。

### 2. 在 TUI 中实时观测与接管（`Alt+S`）

Swarm 运行期间，输入框上方的常驻状态条会实时显示各 Worker 状态（`working`、`waiting`、`stopped`、`killed`）、活跃后台进程（`N bg`）以及累计 Token / 费用。

随时按 **`Alt+S`**（或输入 `/swarm ui`）打开 **三标签页 Swarm 看板浮层**：

- **`1` Overview（总览）** — 渲染 `plan.json` 任务图（总目标、并行线程、Worker 实时状态与 `[N bg]` 后台进程标记）。选中任意 Worker 按 `Enter` 即可直达其独立视图。
- **`2` Board（看板）** — 可滚动的实时消息流，支持 `@mention` 高亮、按频道（`c`）/ 成员（`m`）过滤，按 `r` 或 `Enter` 可将 `#<seq> ` 预填回主输入框快速引用回复。
- **`3` Workers（成员）** — 查看实时对话记录与 `Background Processes` 详情（`taskId`、`[daemon]`、已运行 `elapsed` 与静默 `silent` 时长），支持 `M`（空闲时切换模型）、`k`（确认后终止）、`S`（停止所有运行中的 Worker），或按 `Enter` 进入 **Worker 专属视图**。
- **全屏 Worker 视图（`Enter`）** — 像操作主会话一样直接与单个 Worker 对话：`Enter` 发送指令或在运行中实时纠偏（steer），`Alt+Enter` 排队追加消息（follow-up），`Ctrl+O` / `Ctrl+T` 展开工具输出或思考过程，支持 `/model`、`/abort`、`/kill`、`/exit` 命令，按 `Alt+S` 返回看板，按 `Ctrl+D` 返回协调者视图。

*（在 `print` / `json` / `rpc` 等非 TUI 模式下，会自动回退输出结构化纯文本摘要。）*

### 3. 常用命令与快捷键

| 命令 / 快捷键 | 作用 |
| :--- | :--- |
| `/swarm <task>` | 开启协调者模式，注入编排技能指引，并开始拆解执行 `<task>` |
| `/swarm` | 若当前会话已有 Swarm 则打开看板浮层；否则开启协调者模式 |
| `/swarm ui` / `Alt+S` | 打开三标签页 Swarm 看板浮层 |
| `/swarm stop` | 中止所有运行中的 Worker 及其后台进程（保留对话历史与工作区） |
| `/swarm off` | 退出协调者模式并卸载活跃的 Swarm 工具 |
| `/swarm clean` | 清理 `~/.pi/agent/swarms/` 下历史会话遗留的过期 worktree 与 clone 工作区 |

<details>
<summary><strong>深入了解：底层工具、内置技能与架构</strong></summary>

#### Swarm 与 Worker 工具

协调者与 Worker 共享四个核心工具（添加首个 Worker 或恢复会话后自动为协调者激活 `post_message`、`read_board` 和 `swarm_wait`）：

- `swarm` — 管理蜂群生命周期（`status`、`models`、`add`、`model`、`kill`、`title`、`channel`、`plan`）：
  - `add`：创建单个 Worker 或分片/同构 Worker 组（`tasks` / `n`），支持指定 `model`、`workspace`（`inherit` | `share` | `branch`）、`fork`（`"coordinator"` 或已有 Worker 名）与 `channels`。
  - `model`：为 `waiting` / `stopped` 状态的 Worker（或自身）热切换模型，保留对话历史并自动续跑中断轮次。
  - `kill`：永久终止 Worker 或组，清理其名下整棵后台进程树，并删除对应的 `share` / `branch` 工作区。
  - `channel`：`create`、`list`、`subscribe`、`unsubscribe`、`archive`。
  - `plan`：将结构化目标、线程与任务写入 `plan.json`，驱动 TUI Overview 视图。
- `post_message` — 向 `#main` 或已订阅频道发帖；支持 `@name`、`@group`、`@all`、`@#channel` 精准唤醒（自动忽略代码块内的 `@`，禁止 `@#main`）。
- `read_board` — 读取可见看板消息（支持 `since`、`limit`、`channel`，或 `status: true` 查看成员游标与后台进程诊断）。
- `swarm_wait` — 非阻塞挂起（`since`、`mentions_only`），有新匹配消息到达时由运行时异步唤醒。

Worker 专属工具：

- **常规 Worker（`bash` + `manage_process`）** — 支持同步转后台晋升（`wait_ms` 默认 `10000`、上限 `30000`；`is_daemon`；`notify_after_seconds` 默认 `120`）。超时未退出的长命令不杀进程直接转后台，返回 `taskId` 与输出尾部，并在 `process_exit` 或非守护进程 `process_still_running` 时异步唤醒所属 Worker；`manage_process`（`list`、`status`、`send_input`、`kill`）严格隔离归属并负责整棵进程树清理。
- **监控 Worker（`schedule` + `manage_task`）** — `monitor` / `monitor-<N>` 严格只读，通过一次性定时器（`DurationSeconds`）或 5 段式 Cron（`CronExpression`、`IsDaemon`）巡检全局停滞状态。

#### 内置技能（Skills）

- `swarm`（`skills/swarm/SKILL.md`）— 协调者编排指南（任务拆解、工作区选择、频道协作、精准 `@` 唤醒、限流故障恢复）。
- `swarm-monitor`（`skills/swarm-monitor/SKILL.md`）— 停滞检测协议，区分正常推进的后台构建、守护进程与长期无输出卡死任务。
- `swarm-pane`（`skills/swarm-pane/SKILL.md`）— `plan.json` 编写规范，驱动 TUI Overview 视图。

#### 代码架构

- `extensions/index.ts` — Pi 扩展入口（按需激活工具、`/swarm` 命令、`Alt+S` 快捷键、会话恢复与关闭清理、主会话唤醒排队）。
- `src/runtime.ts` — `SwarmManager`，负责进程内 `createAgentSession` Worker、分支安全会话 Fork、非阻塞挂起与异步唤醒。
- `src/board.ts` — `~/.pi/agent/swarms/<sessionId>/` 下的追加写 `board.jsonl`、原子持久化 `state.json` / `plan.json`、频道权限与 `@` 唤醒匹配。
- `src/workspace.ts` — Git worktree（`share`）、本地 clone（`branch`）、`inherit` 工作区管理及过期目录清理。
- `src/process-manager.ts` — `BackgroundProcessManager`，实现同步转后台竞争、滚动缓冲与大日志落盘、静默计时、标准输入投递与跨平台进程树查杀。
- `src/scheduler.ts` — 面向监控 Worker 的 5 段式 Cron 与一次性定时器引擎。
- `src/ui.ts` 与 `src/worker-view*.ts` — 节流刷新的 TUI 状态组件、三标签页看板浮层、全屏交互式 Worker 视图及纯文本回退。
- `docs/specs/` — 设计文档与 Quint 形式化规约（`async_background_shell.qnt`、`swarm_worker_view.qnt`）。

</details>

## 怎么安装？

`@naivezip/pi-swarm` 已发布至 [pi.dev](https://pi.dev) 与 npm（需安装 Pi 且 Node.js `>= 22.19.0`）。

**单次会话零配置试用**（不修改任何配置文件）：

```bash
pi -e npm:@naivezip/pi-swarm
```

**全局安装**：

```bash
pi install npm:@naivezip/pi-swarm
```

**仅在当前项目安装**（写入 `.pi/settings.json`）：

```bash
pi install -l npm:@naivezip/pi-swarm
```

<details>
<summary>更新、卸载或从源码运行</summary>

管理已安装扩展包：

```bash
pi list
pi update
pi remove npm:@naivezip/pi-swarm
```

从 GitHub 或本地开发目录安装：

```bash
pi install git:github.com/naivezip/pi-swarm
pi install ./path/to/pi-swarm
pi -e ./path/to/pi-swarm
```

本地开发校验：

```bash
npm run typecheck
npm test
```

</details>
