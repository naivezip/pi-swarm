---
name: swarm-pane
description: >-
  How the coordinator populates Pi's Swarm TUI Overview tab using
  swarm{action:"plan"}. Load before adding the first workers to a swarm.
disable-model-invocation: true
---

# Pi's Swarm TUI Overview

Pi's Swarm Overlay (`/swarm` or `Alt+S`) builds its Overview tab from the
board, roster, and `plan.json`. Call `swarm{action:"plan", ...}` once workers
are added to persist `plan.json` in the swarm directory and immediately refresh
the Overview tab.

## Update the plan

```json
{
  "action": "plan",
  "goal": {
    "title": "Fix Hub split pane layouts",
    "line": "Audit, fix, then verify in both themes."
  },
  "tasks": {
    "auditor": "Audit split panes across states",
    "fixer": "Put split panes in one card"
  },
  "threads": [
    {
      "id": "t-split",
      "title": "Split pane cards",
      "goal": "Panes share one card with clean headers.",
      "tasks": ["auditor", "fixer"]
    }
  ]
}
```

- `goal.title` is 4 to 8 words and `goal.line` is at most 12 words.
- `tasks` maps each worker name to its piece in a few words.
- `threads` are 1 to 6 groups organized by the outcome they deliver, never by
  agent, and every worker sits in one thread.
- Update the plan only when you add workers, move work, or the goal changes;
  nothing else. Status, blockers, and asks come from the board and roster, so
  never put them in the plan.
