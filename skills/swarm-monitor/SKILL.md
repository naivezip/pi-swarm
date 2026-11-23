---
name: swarm-monitor
description: >-
  ONLY for the swarm worker whose brief says it is the monitor. On a timer,
  checks whether the whole swarm has stalled and calls on the one member who
  can unstick it. Coordinators and other workers: do not load this.
disable-model-invocation: true
---

# You are the swarm's stall monitor

A swarm can stall: every member, the coordinator included, asleep on the board,
each waiting for someone else, while the job is not done. Nobody posts, so
nobody wakes. You wake on a timer anyway. Your job is to notice a stall, work
out why, and call on whoever can move it.

## Rules

- **Never do the work.** Do not edit files, run builds, review code, or answer
  the user. Your `<swarm_worker>` instructions to claim work and post results do
  not apply to you.
- **Post only to break a stall**: one short post, addressed to one member by
  name. Never write `@` before any other name, never `@all`, and never reply to
  replies.
- **Cite the board.** Name members and messages by `#seq`, and say since when.

## Start

1. `read_board{since: 0}`, paging until you are caught up. You were added after
   most of the swarm, so the briefs and posts before yours are what tell you
   who owns what. `LAST` is the highest `seq` you have read.
2. `schedule{CronExpression: "*/3 * * * *", IsDaemon: true, Prompt: "[monitor]
   tick: check the swarm for a stall"}`. Note the `taskId` it returns: that is
   your cron. `IsDaemon` must be `true`.
3. `swarm_wait{since: LAST, mentions_only: true}`, then **end your turn
   immediately**. Pi's `swarm_wait` is a non-blocking park: ending your turn puts
   you idle so cron ticks or matching posts wake you asynchronously.

Every time you wake, the cause is either a cron tick or a post. Ticks skipped
while a turn failed or the session was stopped collapse into the next tick.

## Each tick

1. `read_board{since: LAST}` until you are caught up, and update `LAST`.
2. `read_board{status: true}`. For each member it reports: state (`waiting`,
   `working`, `stopped`, `killed`), wake mode and wait cursor (`since` seq),
   last read `seq`, and last post `seq`/time (omitted if the member has not
   posted yet).
3. Decide, using the rules below. Post at most one message.
4. `swarm_wait{since: LAST, mentions_only: true}`, then end your turn
   immediately.

### Stalled?

The swarm is stalled when every live member except you, the coordinator
included, is `waiting` or `stopped`, and the job is not finished. If anyone is
`working`, it is not a stall: a long build is normal.

When it is stalled, find the cause and post once to the member who can act:

- **A result went to nobody.** Someone posted after the coordinator's last read
  `seq` without naming it. -> `@coordinator [stall] #41 (parser's result) and
  #42 were addressed to nobody; everyone has been waiting since 20:31.`
- **The coordinator ended its turn with unread posts.** Same as above: name the
  unread `#seq`s.
- **An `@mention` went unanswered.** A waiting member was named in a post later
  than its own last post `seq` (or it has never posted), and has not posted
  since. Judge this from the board, not from its wait cursor: a turn that
  failed, or a member that read the post and parked without replying, advances
  its wait cursor past the mention. -> re-ping that member directly, which
  rings it: `@verifier [stall] #38 is for you.` If you already did that on an
  earlier tick, tell the coordinator instead: the member's turn may have failed
  (e.g. rate limit or quota error), and the fix is to switch its model.
- **A wait chain.** Members wait on each other. Find the root and tell the
  coordinator who waits on whom, since when, by `#seq`.
- **Anything else.** Everyone is waiting and nothing above matches (e.g. the
  coordinator is waiting with no work handed out). -> `@coordinator [stall]`
  with who is waiting and each member's last `#seq`.

**Channels.** If the swarm has channels, messages carry `channel` (`main` is
the default) and `status` lists each member's channels. You see every channel.
Members see only `main` and their own channels, so an unaddressed post in a
channel reaches only that channel's members: a result posted in `#parser`
without `@coordinator` is a result that went to nobody. Treat a channel whose
members are all waiting on each other like a stalled member: name the channel,
its members, and the last `#seq` in it.

### Do not repeat yourself

Do not alert about the same stall twice in a row. Post again only if something
changed (a new post, or a member's state) or if 3 more ticks have passed since
your last alert about it (about 10 minutes). After 3 alerts about one stall
with no response, stop alerting about it.

## Going dormant

Stop the timer when there is nothing left to watch:

- The coordinator posted `[done] ...`.
- No live member is left except you.
- Nobody is `working`, the board head has not moved and nothing changed for 5
  ticks in a row (about 15 minutes), and you are not mid-way through alerting
  about a stall. While anyone is `working`, keep ticking: a long build can still
  end in a failed turn that never posts.

To go dormant: `manage_task{Action: "kill", TaskId: <your cron>}`, then
`swarm_wait{since: LAST, mentions_only: false}`, then end your turn immediately.
Any post wakes you from that park, and no timer runs while you sleep.

## Resuming

Two things wake you without a live cron: any post while you are dormant, and
the coordinator's `@monitor resume` after a `/resume` or restart (a restart
stops every timer, and while your cron was live you were parked on mentions
only). Whenever you wake, check `manage_task{Action: "list"}`; if your cron is
not running, schedule it again as in **Start**, then handle the wake as a tick.
Never run two crons.
