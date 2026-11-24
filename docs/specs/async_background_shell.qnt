// Formal specification of pi-swarm async background shell, worker wake/ownership,
// and coordinator wake state machines. Models actual control flow in:
//   - src/process-manager.ts (BackgroundProcessManager)
//   - src/runtime.ts (SwarmManager)
//   - extensions/index.ts (deliverCoordinatorWake / flushPendingCoordinatorWake)
//   - src/tools.ts (bash / manage_process)
module async_background_shell {
  pure val WORKERS: Set[str] = Set("w1", "w2")

  type ProcState = ProcStarting | ProcRunning | ProcExited | ProcKilled | ProcCancelled
  type ProcEventKind = EvProcessExit | EvProcessStillRunning
  type WorkerStatus = WWaiting | WWorking | WStopped | WKilled
  type WakeMode = ModeMentions | ModeAnything
  type CoordStatus = CWaiting | CWorking

  type ProcessEvent = {
    taskId: int,
    owner: str,
    kind: ProcEventKind,
    beforeStopAll: bool
  }

  type ProcessRecord = {
    taskId: int,
    owner: str,
    lastAccessedBy: str,
    state: ProcState,
    isDaemon: bool,
    promoted: bool,
    exiting: bool,
    runSettled: bool,
    startedAt: int,
    lastOutputAt: int,
    endedAt: int,
    manuallyKilled: bool,
    startGlobalGen: int,
    startOwnerGen: int
  }

  type WorkerRecord = {
    status: WorkerStatus,
    wakeMode: WakeMode,
    waitSince: int,
    lastReadSeq: int,
    lastError: bool,
    lastTurnErrored: bool,
    explicitWaitThisTurn: bool,
    hasActiveSession: bool
  }

  type BoardMsg = {
    seq: int,
    author: str,
    mentionsCoord: bool,
    mentionsWorker: Set[str],
    mentionAll: bool
  }

  type CoordRecord = {
    state: CoordStatus,
    hostIsIdle: bool,
    wakeMode: WakeMode,
    waitSince: int,
    lastReadSeq: int,
    explicitWait: bool,
    runtimePendingWake: int,
    extPendingWake: int,
    wakeRequiredSeq: int,
    sentWakeSeqs: List[int]
  }

  type Microtask =
    | MtWakeBoard({ worker: str, seq: int })
    | MtWakeProcess({ worker: str, events: List[ProcessEvent] })
    | MtWakeModelSwitch({ worker: str })

  // Runtime lifecycle flags & kill generation counters bundled to keep frame conditions compact.
  type MgrState = {
    clock: int,
    disposed: bool,
    stopping: bool,
    stoppedAll: bool,
    nextTaskId: int,
    globalKillGen: int,
    ownerKillGen: str -> int
  }

  var mgr: MgrState
  var procs: int -> ProcessRecord
  var emittedEvents: List[ProcessEvent]
  var workers: str -> WorkerRecord
  var wakingWorkers: Set[str]
  var workerStartingSession: Set[str]
  var workerBlockedOnBash: str -> int
  var pendingProcEvents: str -> List[ProcessEvent]
  var pendingWakeSeq: str -> int
  var deliveredProcEvents: str -> List[ProcessEvent]
  var microtasks: List[Microtask]
  var board: List[BoardMsg]
  var coord: CoordRecord

  pure def mapRemove(m: k -> v, key: k): k -> v =
    m.keys().exclude(Set(key)).mapBy(x => m.get(x))

  pure def tickMgr(m: MgrState): MgrState = { ...m, clock: m.clock + 1 }

  pure def msgWakesWorker(msg: BoardMsg, w: str, wr: WorkerRecord): bool =
    wr.status != WKilled and msg.author != w and
    (msg.mentionAll or msg.mentionsWorker.contains(w) or wr.wakeMode == ModeAnything)

  pure def msgWakesCoord(msg: BoardMsg, c: CoordRecord): bool =
    msg.author != "coordinator" and (msg.mentionsCoord or c.wakeMode == ModeAnything)

  pure def maxSeq(a: int, b: int): int = if (a >= b) a else b

  pure def listContainsEvent(lst: List[ProcessEvent], ev: ProcessEvent): bool =
    lst.select(x => x.taskId == ev.taskId and x.kind == ev.kind).length() > 0

  pure def microtasksContainEvent(mts: List[Microtask], w: str, ev: ProcessEvent): bool =
    mts.select(mt => match mt {
      | MtWakeProcess(p) => p.worker == w and listContainsEvent(p.events, ev)
      | _ => false
    }).length() > 0

  pure def initWorker(active: bool): WorkerRecord = {
    status: if (active) WWorking else WWaiting,
    wakeMode: ModeMentions,
    waitSince: 0,
    lastReadSeq: 0,
    lastError: false,
    lastTurnErrored: false,
    explicitWaitThisTurn: false,
    hasActiveSession: active
  }

  action init = all {
    mgr' = {
      clock: 1,
      disposed: false,
      stopping: false,
      stoppedAll: false,
      nextTaskId: 1,
      globalKillGen: 0,
      ownerKillGen: WORKERS.mapBy(_ => 0)
    },
    procs' = Map(),
    emittedEvents' = List(),
    workers' = WORKERS.mapBy(w => initWorker(w == "w1")),
    wakingWorkers' = Set(),
    workerStartingSession' = Set(),
    workerBlockedOnBash' = Map(),
    pendingProcEvents' = WORKERS.mapBy(_ => List()),
    pendingWakeSeq' = WORKERS.mapBy(_ => 0),
    deliveredProcEvents' = WORKERS.mapBy(_ => List()),
    microtasks' = List(),
    board' = List(),
    coord' = {
      state: CWaiting,
      hostIsIdle: true,
      wakeMode: ModeMentions,
      waitSince: 0,
      lastReadSeq: 0,
      explicitWait: false,
      runtimePendingWake: 0,
      extPendingWake: 0,
      wakeRequiredSeq: 0,
      sentWakeSeqs: List()
    }
  }

  // --- Process lifecycle (src/process-manager.ts + src/runtime.ts) ---

  // Worker calls bash(...): checks !disposed & !stopping & status != WKilled, captures kill generations, awaits fsAccess.
  action runWorkerBashStart(w: str, isDaemon: bool): bool = {
    val wr = workers.get(w)
    val tid = mgr.nextTaskId
    all {
      not(mgr.disposed),
      not(mgr.stopping),
      wr.status == WWorking,
      not(w.in(workerBlockedOnBash.keys())),
      mgr' = { ...mgr, clock: mgr.clock + 1, nextTaskId: tid + 1 },
      procs' = procs.put(tid, {
        taskId: tid,
        owner: w,
        lastAccessedBy: w,
        state: ProcStarting,
        isDaemon: isDaemon,
        promoted: false,
        exiting: false,
        runSettled: false,
        startedAt: mgr.clock,
        lastOutputAt: mgr.clock,
        endedAt: 0,
        manuallyKilled: false,
        startGlobalGen: mgr.globalKillGen,
        startOwnerGen: mgr.ownerKillGen.get(w)
      }),
      workerBlockedOnBash' = workerBlockedOnBash.put(w, tid),
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // fsAccess resolves (src/process-manager.ts:498-505 + src/runtime.ts:2103):
  // Re-checks disposed / stopping / globalKillGen / ownerKillGen / worker status == WKilled.
  // If cancelled, cleans up ProcStarting & unblocks worker without spawning.
  action finishProcessSpawn(tid: int): bool = {
    val p = procs.get(tid)
    val cancelled = mgr.disposed or mgr.stopping or
      (mgr.globalKillGen != p.startGlobalGen) or
      (mgr.ownerKillGen.get(p.owner) != p.startOwnerGen) or
      (workers.get(p.owner).status == WKilled)
    all {
      tid.in(procs.keys()),
      p.state == ProcStarting,
      if (cancelled) all {
        procs' = procs.set(tid, { ...p, state: ProcCancelled, exiting: true, runSettled: true, endedAt: mgr.clock }),
        workerBlockedOnBash' = if (p.owner.in(workerBlockedOnBash.keys()) and workerBlockedOnBash.get(p.owner) == tid)
          mapRemove(workerBlockedOnBash, p.owner) else workerBlockedOnBash,
      } else all {
        procs' = procs.set(tid, { ...p, state: ProcRunning, startedAt: mgr.clock, lastOutputAt: mgr.clock }),
        workerBlockedOnBash' = workerBlockedOnBash,
      },
      mgr' = tickMgr(mgr),
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // Child exits fast before wait_ms (sync return; no process_exit event emitted).
  action processSyncExit(tid: int): bool = {
    val p = procs.get(tid)
    all {
      tid.in(procs.keys()),
      p.state == ProcRunning,
      not(p.promoted),
      not(p.exiting),
      not(p.runSettled),
      procs' = procs.set(tid, { ...p, state: ProcExited, exiting: true, runSettled: true, endedAt: mgr.clock }),
      workerBlockedOnBash' = if (p.owner.in(workerBlockedOnBash.keys()) and workerBlockedOnBash.get(p.owner) == tid)
        mapRemove(workerBlockedOnBash, p.owner) else workerBlockedOnBash,
      mgr' = tickMgr(mgr),
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // wait_ms timer fires: promotes running process to background without killing, unblocks worker.
  action promoteToBackground(tid: int): bool = {
    val p = procs.get(tid)
    all {
      tid.in(procs.keys()),
      not(mgr.disposed),
      p.state == ProcRunning,
      not(p.exiting),
      not(p.runSettled),
      procs' = procs.set(tid, { ...p, promoted: true, runSettled: true }),
      workerBlockedOnBash' = if (p.owner.in(workerBlockedOnBash.keys()) and workerBlockedOnBash.get(p.owner) == tid)
        mapRemove(workerBlockedOnBash, p.owner) else workerBlockedOnBash,
      mgr' = tickMgr(mgr),
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // Stdout/stderr chunk arrives, updating lastOutputAt separately from startedAt.
  action processOutput(tid: int): bool = {
    val p = procs.get(tid)
    all {
      tid.in(procs.keys()),
      p.state == ProcRunning,
      not(p.exiting),
      procs' = procs.set(tid, { ...p, lastOutputAt: mgr.clock }),
      mgr' = tickMgr(mgr),
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // Helper: route a newly emitted BackgroundProcessEvent through handleBackgroundProcessEvent + wakeWorker.
  action dispatchProcessEvent(ev: ProcessEvent): bool = {
    val owner = ev.owner
    val wr = workers.get(owner)
    val isBusy = wr.status == WWorking or owner.in(wakingWorkers)
    val hasErr = wr.lastError or wr.lastTurnErrored
    if (mgr.disposed or mgr.stopping or wr.status == WKilled) all {
      emittedEvents' = emittedEvents.append(ev),
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      pendingProcEvents' = pendingProcEvents,
      deliveredProcEvents' = deliveredProcEvents,
    } else if (isBusy or hasErr) all {
      emittedEvents' = emittedEvents.append(ev),
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      pendingProcEvents' = pendingProcEvents.set(owner, pendingProcEvents.get(owner).append(ev)),
      deliveredProcEvents' = deliveredProcEvents,
    } else if (wr.hasActiveSession) all {
      emittedEvents' = emittedEvents.append(ev),
      workers' = workers.set(owner, { ...wr, status: WWorking, lastError: false, lastTurnErrored: false }),
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      pendingProcEvents' = pendingProcEvents,
      deliveredProcEvents' = deliveredProcEvents.set(owner, deliveredProcEvents.get(owner).append(ev)),
    } else all {
      emittedEvents' = emittedEvents.append(ev),
      workers' = workers.set(owner, { ...wr, status: WWorking, lastError: false }),
      wakingWorkers' = wakingWorkers.union(Set(owner)),
      workerStartingSession' = workerStartingSession.union(Set(owner)),
      pendingProcEvents' = pendingProcEvents,
      deliveredProcEvents' = deliveredProcEvents.set(owner, deliveredProcEvents.get(owner).append(ev)),
    }
  }

  // Non-daemon reminder timer fires: emits process_still_running. Never fires for daemon.
  action fireReminder(tid: int): bool = {
    val p = procs.get(tid)
    val ev = { taskId: tid, owner: p.owner, kind: EvProcessStillRunning, beforeStopAll: mgr.stoppedAll or mgr.stopping }
    all {
      tid.in(procs.keys()),
      not(mgr.disposed),
      p.state == ProcRunning,
      p.promoted,
      not(p.exiting),
      not(p.isDaemon),
      dispatchProcessEvent(ev),
      mgr' = tickMgr(mgr),
      procs' = procs,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingWakeSeq' = pendingWakeSeq,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // Natural exit after background promotion (finalizeProcess): emits process_exit iff !wasKilled.
  action processNaturalExit(tid: int): bool = {
    val p = procs.get(tid)
    val ev = { taskId: tid, owner: p.owner, kind: EvProcessExit, beforeStopAll: mgr.stoppedAll or mgr.stopping }
    all {
      tid.in(procs.keys()),
      not(mgr.disposed),
      p.state == ProcRunning,
      p.promoted,
      not(p.exiting),
      procs' = procs.set(tid, { ...p, state: ProcExited, exiting: true, endedAt: mgr.clock }),
      dispatchProcessEvent(ev),
      mgr' = tickMgr(mgr),
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingWakeSeq' = pendingWakeSeq,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // Child error event (onError at src/process-manager.ts:697-745):
  // Checks wasKilled = (entry.state == "killed" || disposed) before emitting process_exit.
  action processChildError(tid: int): bool = {
    val p = procs.get(tid)
    val wasKilled = p.state == ProcKilled or mgr.disposed
    val ev = { taskId: tid, owner: p.owner, kind: EvProcessExit, beforeStopAll: mgr.stoppedAll or mgr.stopping }
    all {
      tid.in(procs.keys()),
      not(p.exiting),
      p.state == ProcRunning or p.state == ProcKilled,
      procs' = procs.set(tid, {
        ...p,
        state: if (not(wasKilled) and p.state == ProcRunning) ProcExited else p.state,
        exiting: true,
        runSettled: true,
        endedAt: if (p.endedAt == 0) mgr.clock else p.endedAt
      }),
      workerBlockedOnBash' = if (p.owner.in(workerBlockedOnBash.keys()) and workerBlockedOnBash.get(p.owner) == tid)
        mapRemove(workerBlockedOnBash, p.owner) else workerBlockedOnBash,
      if (p.promoted and not(wasKilled)) dispatchProcessEvent(ev) else all {
        emittedEvents' = emittedEvents,
        workers' = workers,
        wakingWorkers' = wakingWorkers,
        workerStartingSession' = workerStartingSession,
        pendingProcEvents' = pendingProcEvents,
        deliveredProcEvents' = deliveredProcEvents,
      },
      mgr' = tickMgr(mgr),
      pendingWakeSeq' = pendingWakeSeq,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // manage_process({ action: "list" | "status" | "send_input" | "kill" })
  // Enforces requireOwnedEntry (p.owner == caller); killEntry checks !exiting & state == running.
  action manageProcessOp(caller: str, tid: int, isKill: bool): bool = {
    val wr = workers.get(caller)
    val p = procs.get(tid)
    all {
      not(mgr.disposed),
      not(mgr.stopping),
      wr.status == WWorking,
      not(caller.in(workerBlockedOnBash.keys())),
      tid.in(procs.keys()),
      p.state != ProcStarting,
      p.state != ProcCancelled,
      if (p.owner != caller) all {
        // requireOwnedEntry throws Permission denied; never touches proc
        procs' = procs,
      } else if (isKill and p.state == ProcRunning and not(p.exiting)) all {
        procs' = procs.set(tid, { ...p, lastAccessedBy: caller, state: ProcKilled, manuallyKilled: true, endedAt: mgr.clock }),
      } else all {
        procs' = procs.set(tid, { ...p, lastAccessedBy: caller }),
      },
      mgr' = tickMgr(mgr),
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // finalizeProcess completes after killEntry set state = ProcKilled (suppresses process_exit).
  action processFinalizeAfterKill(tid: int): bool = {
    val p = procs.get(tid)
    all {
      tid.in(procs.keys()),
      p.state == ProcKilled,
      not(p.exiting),
      procs' = procs.set(tid, { ...p, exiting: true, runSettled: true }),
      workerBlockedOnBash' = if (p.owner.in(workerBlockedOnBash.keys()) and workerBlockedOnBash.get(p.owner) == tid)
        mapRemove(workerBlockedOnBash, p.owner) else workerBlockedOnBash,
      mgr' = tickMgr(mgr),
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // --- Worker wake, error/model_switch, and lifecycle (src/runtime.ts) ---

  // Completes await createAndStartWorkerSession inside wakeWorker (src/runtime.ts:1222-1250, 1688-1706).
  // Re-checks disposed || stopping || member.state == killed before storing active session.
  action workerFinishSessionStart(w: str): bool = {
    val wr = workers.get(w)
    val cancelled = mgr.disposed or mgr.stopping or wr.status == WKilled
    all {
      w.in(workerStartingSession),
      workerStartingSession' = workerStartingSession.exclude(Set(w)),
      wakingWorkers' = wakingWorkers.exclude(Set(w)),
      workers' = if (cancelled)
        workers.set(w, { ...wr, hasActiveSession: false })
      else
        workers.set(w, { ...wr, hasActiveSession: true, lastTurnErrored: false }),
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // Worker turn hits an error (message_end stopReason == "error").
  action workerTurnEndError(w: str): bool = {
    val wr = workers.get(w)
    all {
      not(mgr.disposed),
      not(mgr.stopping),
      wr.status == WWorking,
      not(w.in(workerStartingSession)),
      workers' = workers.set(w, { ...wr, lastError: true, lastTurnErrored: true }),
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // Worker calls swarm_wait while working.
  action workerRequestWait(w: str, mentionsOnly: bool): bool = {
    val wr = workers.get(w)
    val mode = if (mentionsOnly) ModeMentions else ModeAnything
    val hasMatch = board.select(m => m.seq > wr.lastReadSeq and msgWakesWorker(m, w, { ...wr, wakeMode: mode })).length() > 0
    all {
      not(mgr.disposed),
      not(mgr.stopping),
      wr.status == WWorking,
      not(w.in(workerBlockedOnBash.keys())),
      not(hasMatch),
      workers' = workers.set(w, { ...wr, wakeMode: mode, waitSince: wr.lastReadSeq, explicitWaitThisTurn: true }),
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // Worker calls read_board (full view) -> advances lastReadSeq to boardHead.
  action workerReadBoard(w: str): bool = {
    val wr = workers.get(w)
    val bHead = board.length()
    all {
      not(mgr.disposed),
      not(mgr.stopping),
      wr.status == WWorking,
      not(w.in(workerBlockedOnBash.keys())),
      workers' = workers.set(w, { ...wr, lastReadSeq: maxSeq(wr.lastReadSeq, bHead) }),
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // onWorkerSettled (src/runtime.ts:1312-1374):
  // Parks worker in WWaiting; if lastTurnErrored, preserves pending events/wakes;
  // otherwise pops pendingProcEvents (prioritized over board wakes) into a microtask.
  action workerSettled(w: str): bool = {
    val wr = workers.get(w)
    val pEvs = pendingProcEvents.get(w)
    val pSeq = pendingWakeSeq.get(w)
    val nextMode = if (wr.explicitWaitThisTurn) wr.wakeMode else ModeMentions
    val nextWaitSince = if (wr.explicitWaitThisTurn) wr.waitSince else wr.lastReadSeq
    val baseWr = { ...wr, status: WWaiting, wakeMode: nextMode, waitSince: nextWaitSince, explicitWaitThisTurn: false }
    all {
      not(mgr.disposed),
      wr.status == WWorking,
      not(w.in(workerBlockedOnBash.keys())),
      not(w.in(workerStartingSession)),
      workers' = workers.set(w, baseWr),
      if (wr.lastTurnErrored) all {
        pendingProcEvents' = pendingProcEvents,
        pendingWakeSeq' = pendingWakeSeq,
        microtasks' = microtasks,
      } else if (pEvs.length() > 0) all {
        pendingProcEvents' = pendingProcEvents.set(w, List()),
        pendingWakeSeq' = pendingWakeSeq,
        microtasks' = microtasks.append(MtWakeProcess({ worker: w, events: pEvs })),
      } else if (pSeq > wr.lastReadSeq) all {
        pendingProcEvents' = pendingProcEvents,
        pendingWakeSeq' = pendingWakeSeq.set(w, 0),
        microtasks' = microtasks.append(MtWakeBoard({ worker: w, seq: pSeq })),
      } else all {
        pendingProcEvents' = pendingProcEvents,
        pendingWakeSeq' = pendingWakeSeq.set(w, 0),
        microtasks' = microtasks,
      },
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      deliveredProcEvents' = deliveredProcEvents,
      board' = board,
      coord' = coord
    }
  }

  // Executes one queued microtask (wakeWorker).
  action runMicrotask: bool = {
    val mt = microtasks.head()
    val rest = microtasks.tail()
    all {
      not(mgr.disposed),
      not(mgr.stopping),
      microtasks.length() > 0,
      match mt {
        | MtWakeProcess(p) => {
            val w = p.worker
            val wr = workers.get(w)
            if (wr.status == WKilled) all {
              workers' = workers,
              wakingWorkers' = wakingWorkers,
              workerStartingSession' = workerStartingSession,
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents,
              microtasks' = rest,
            } else if (wr.status == WWorking or w.in(wakingWorkers)) all {
              workers' = workers,
              wakingWorkers' = wakingWorkers,
              workerStartingSession' = workerStartingSession,
              pendingProcEvents' = pendingProcEvents.set(w, pendingProcEvents.get(w).concat(p.events)),
              deliveredProcEvents' = deliveredProcEvents,
              microtasks' = rest,
            } else if (wr.hasActiveSession) all {
              workers' = workers.set(w, { ...wr, status: WWorking, lastError: false, lastTurnErrored: false }),
              wakingWorkers' = wakingWorkers,
              workerStartingSession' = workerStartingSession,
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents.set(w, deliveredProcEvents.get(w).concat(p.events)),
              microtasks' = rest,
            } else all {
              workers' = workers.set(w, { ...wr, status: WWorking, lastError: false }),
              wakingWorkers' = wakingWorkers.union(Set(w)),
              workerStartingSession' = workerStartingSession.union(Set(w)),
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents.set(w, deliveredProcEvents.get(w).concat(p.events)),
              microtasks' = rest,
            }
          }
        | MtWakeBoard(b) => {
            val w = b.worker
            val wr = workers.get(w)
            if (wr.status == WKilled or wr.status == WWorking or w.in(wakingWorkers) or wr.lastReadSeq >= b.seq) all {
              workers' = workers,
              wakingWorkers' = wakingWorkers,
              workerStartingSession' = workerStartingSession,
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents,
              microtasks' = rest,
            } else if (wr.hasActiveSession) all {
              workers' = workers.set(w, { ...wr, status: WWorking, lastError: false, lastTurnErrored: false }),
              wakingWorkers' = wakingWorkers,
              workerStartingSession' = workerStartingSession,
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents,
              microtasks' = rest,
            } else all {
              workers' = workers.set(w, { ...wr, status: WWorking, lastError: false }),
              wakingWorkers' = wakingWorkers.union(Set(w)),
              workerStartingSession' = workerStartingSession.union(Set(w)),
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents,
              microtasks' = rest,
            }
          }
        | MtWakeModelSwitch(ms) => {
            val w = ms.worker
            val wr = workers.get(w)
            if (wr.status == WKilled or wr.status == WWorking or w.in(wakingWorkers)) all {
              workers' = workers,
              wakingWorkers' = wakingWorkers,
              workerStartingSession' = workerStartingSession,
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents,
              microtasks' = rest,
            } else if (wr.hasActiveSession) all {
              workers' = workers.set(w, { ...wr, status: WWorking, lastError: false, lastTurnErrored: false }),
              wakingWorkers' = wakingWorkers,
              workerStartingSession' = workerStartingSession,
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents,
              microtasks' = rest,
            } else all {
              workers' = workers.set(w, { ...wr, status: WWorking, lastError: false }),
              wakingWorkers' = wakingWorkers.union(Set(w)),
              workerStartingSession' = workerStartingSession.union(Set(w)),
              pendingProcEvents' = pendingProcEvents,
              deliveredProcEvents' = deliveredProcEvents,
              microtasks' = rest,
            }
          }
      },
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingWakeSeq' = pendingWakeSeq,
      board' = board,
      coord' = coord
    }
  }

  // Coordinator switches worker model (src/runtime.ts:1739-1836):
  // Clears lastError & lastTurnErrored, preserves pendingProcEvents, wakes worker if hadError or pending work.
  action switchWorkerModel(w: str): bool = {
    val wr = workers.get(w)
    val hasPendingProc = pendingProcEvents.get(w).length() > 0
    val hasUnreadWake = board.select(m => m.seq > wr.lastReadSeq and msgWakesWorker(m, w, wr)).length() > 0
    val shouldWake = wr.lastError or hasPendingProc or hasUnreadWake
    all {
      not(mgr.disposed),
      not(mgr.stopping),
      wr.status != WKilled,
      wr.status != WWorking,
      not(w.in(wakingWorkers)),
      workers' = workers.set(w, { ...wr, lastError: false, lastTurnErrored: false }),
      microtasks' = if (shouldWake) microtasks.append(MtWakeModelSwitch({ worker: w })) else microtasks,
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      board' = board,
      coord' = coord
    }
  }

  // Coordinator permanently kills a worker (src/runtime.ts:1895-1935):
  // Synchronously marks target.state = WKilled & clears queues BEFORE await killByOwner (ownerKillGen + 1).
  action killWorkerTarget(w: str): bool = {
    val wr = workers.get(w)
    all {
      not(mgr.disposed),
      wr.status != WKilled,
      mgr' = {
        ...mgr,
        clock: mgr.clock + 1,
        ownerKillGen: mgr.ownerKillGen.set(w, mgr.ownerKillGen.get(w) + 1)
      },
      pendingWakeSeq' = pendingWakeSeq.set(w, 0),
      pendingProcEvents' = pendingProcEvents.set(w, List()),
      procs' = procs.keys().mapBy(tid => {
        val p = procs.get(tid)
        if (p.owner == w and p.state == ProcRunning and not(p.exiting))
          { ...p, state: ProcKilled, manuallyKilled: true, endedAt: mgr.clock }
        else p
      }),
      workers' = workers.set(w, { ...wr, status: WKilled, hasActiveSession: false }),
      workerBlockedOnBash' = mapRemove(workerBlockedOnBash, w),
      emittedEvents' = emittedEvents,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board,
      coord' = coord
    }
  }

  // /swarm stop begins (src/runtime.ts:2163-2185): sets stopping = true, clears pending queues, aborts workers.
  action stopAllStart: bool = all {
    not(mgr.disposed),
    not(mgr.stopping),
    mgr' = { ...mgr, clock: mgr.clock + 1, stopping: true, stoppedAll: true },
    pendingWakeSeq' = WORKERS.mapBy(_ => 0),
    pendingProcEvents' = WORKERS.mapBy(_ => List()),
    microtasks' = List(),
    workers' = WORKERS.mapBy(w => {
      val wr = workers.get(w)
      if (wr.status == WWorking) { ...wr, status: WWaiting } else wr
    }),
    workerBlockedOnBash' = Map(),
    coord' = { ...coord, runtimePendingWake: 0, extPendingWake: 0 },
    procs' = procs,
    emittedEvents' = emittedEvents,
    wakingWorkers' = wakingWorkers,
    workerStartingSession' = workerStartingSession,
    deliveredProcEvents' = deliveredProcEvents,
    board' = board
  }

  // /swarm stop finishes (src/runtime.ts:2185-2198): processManager.killAll() bumps globalKillGen & clears stopping.
  action stopAllFinish: bool = all {
    not(mgr.disposed),
    mgr.stopping,
    mgr' = { ...mgr, clock: mgr.clock + 1, stopping: false, globalKillGen: mgr.globalKillGen + 1 },
    procs' = procs.keys().mapBy(tid => {
      val p = procs.get(tid)
      if (p.state == ProcRunning and not(p.exiting))
        { ...p, state: ProcKilled, manuallyKilled: true, endedAt: mgr.clock }
      else p
    }),
    workers' = WORKERS.mapBy(w => {
      val wr = workers.get(w)
      if (wr.status == WWorking) { ...wr, status: WStopped } else wr
    }),
    emittedEvents' = emittedEvents,
    wakingWorkers' = wakingWorkers,
    workerStartingSession' = workerStartingSession,
    workerBlockedOnBash' = workerBlockedOnBash,
    pendingProcEvents' = pendingProcEvents,
    pendingWakeSeq' = pendingWakeSeq,
    deliveredProcEvents' = deliveredProcEvents,
    microtasks' = microtasks,
    board' = board,
    coord' = coord
  }

  // SwarmManager.dispose (src/runtime.ts:2202-2235 + src/process-manager.ts:901-926).
  action disposeManager: bool = all {
    not(mgr.disposed),
    mgr' = { ...mgr, clock: mgr.clock + 1, disposed: true, globalKillGen: mgr.globalKillGen + 1 },
    pendingWakeSeq' = WORKERS.mapBy(_ => 0),
    pendingProcEvents' = WORKERS.mapBy(_ => List()),
    microtasks' = List(),
    procs' = procs.keys().mapBy(tid => {
      val p = procs.get(tid)
      if (p.state == ProcRunning) { ...p, state: ProcKilled, manuallyKilled: true, endedAt: mgr.clock } else p
    }),
    workers' = WORKERS.mapBy(w => {
      val wr = workers.get(w)
      if (wr.status == WWorking or wr.status == WWaiting) { ...wr, status: WStopped, hasActiveSession: false }
      else { ...wr, hasActiveSession: false }
    }),
    workerBlockedOnBash' = Map(),
    coord' = { ...coord, state: CWaiting, runtimePendingWake: 0, extPendingWake: 0 },
    emittedEvents' = emittedEvents,
    wakingWorkers' = wakingWorkers,
    workerStartingSession' = workerStartingSession,
    deliveredProcEvents' = deliveredProcEvents,
    board' = board
  }

  // --- Board & Coordinator wake state machine (src/runtime.ts + extensions/index.ts) ---

  // Worker or coordinator posts a message to the board.
  action postBoardMessage(author: str, mentionsCoord: bool, mentionW1: bool, mentionW2: bool): bool = {
    val seq = board.length() + 1
    val mSet = Set().union(if (mentionW1) Set("w1") else Set()).union(if (mentionW2) Set("w2") else Set())
    val msg = { seq: seq, author: author, mentionsCoord: mentionsCoord, mentionsWorker: mSet, mentionAll: false }
    val authorAlive = if (author == "coordinator") coord.state == CWorking
      else (workers.get(author).status == WWorking and not(author.in(workerBlockedOnBash.keys())))
    val wakesCoord = msgWakesCoord(msg, coord)
    val coordBusy = coord.state == CWorking or not(coord.hostIsIdle)
    val nextPendingWakeSeq = WORKERS.mapBy(w => {
      val wr = workers.get(w)
      if (msgWakesWorker(msg, w, wr) and (wr.status == WWorking or w.in(wakingWorkers)))
        maxSeq(pendingWakeSeq.get(w), seq)
      else pendingWakeSeq.get(w)
    })
    val boardWakeMts = if (mgr.stopping) List() else WORKERS.fold(List(), (acc, w) => {
      val wr = workers.get(w)
      if (msgWakesWorker(msg, w, wr) and not(wr.status == WWorking or w.in(wakingWorkers)) and (seq > wr.waitSince or wr.status == WStopped))
        acc.append(MtWakeBoard({ worker: w, seq: seq }))
      else acc
    })
    val nextCoord = if (not(wakesCoord)) coord
      else if (coordBusy) {
        ...coord,
        wakeRequiredSeq: maxSeq(coord.wakeRequiredSeq, seq),
        runtimePendingWake: maxSeq(coord.runtimePendingWake, seq)
      } else if (coord.lastReadSeq < seq) {
        // deliverCoordinatorWake clears extPendingWake when wake.seq >= extPendingWake (extensions/index.ts:112-114)
        ...coord,
        wakeRequiredSeq: maxSeq(coord.wakeRequiredSeq, seq),
        extPendingWake: if (seq >= coord.extPendingWake) 0 else coord.extPendingWake,
        sentWakeSeqs: coord.sentWakeSeqs.append(seq)
      } else coord
    all {
      not(mgr.disposed),
      authorAlive,
      board' = board.append(msg),
      pendingWakeSeq' = nextPendingWakeSeq,
      microtasks' = microtasks.concat(boardWakeMts),
      coord' = nextCoord,
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      deliveredProcEvents' = deliveredProcEvents
    }
  }

  // Coordinator starts an agent turn (before_agent_start -> onCoordinatorRunStart).
  action coordStartTurn: bool = all {
    not(mgr.disposed),
    coord.state == CWaiting,
    coord.hostIsIdle,
    coord' = { ...coord, state: CWorking, hostIsIdle: false, explicitWait: false },
    mgr' = tickMgr(mgr),
    procs' = procs,
    emittedEvents' = emittedEvents,
    workers' = workers,
    wakingWorkers' = wakingWorkers,
    workerStartingSession' = workerStartingSession,
    workerBlockedOnBash' = workerBlockedOnBash,
    pendingProcEvents' = pendingProcEvents,
    pendingWakeSeq' = pendingWakeSeq,
    deliveredProcEvents' = deliveredProcEvents,
    microtasks' = microtasks,
    board' = board
  }

  // Non-swarm host turn starts (e.g. compaction) making hostIsIdle = false while coord.state stays CWaiting.
  action coordHostBusy: bool = all {
    not(mgr.disposed),
    coord.hostIsIdle,
    coord' = { ...coord, hostIsIdle: false },
    mgr' = tickMgr(mgr),
    procs' = procs,
    emittedEvents' = emittedEvents,
    workers' = workers,
    wakingWorkers' = wakingWorkers,
    workerStartingSession' = workerStartingSession,
    workerBlockedOnBash' = workerBlockedOnBash,
    pendingProcEvents' = pendingProcEvents,
    pendingWakeSeq' = pendingWakeSeq,
    deliveredProcEvents' = deliveredProcEvents,
    microtasks' = microtasks,
    board' = board
  }

  // Coordinator calls read_board (full view, or partial with limit).
  action coordReadBoard(readAll: bool): bool = {
    val bHead = board.length()
    val nextRead = if (readAll) bHead else if (bHead > coord.lastReadSeq) coord.lastReadSeq + 1 else coord.lastReadSeq
    all {
      not(mgr.disposed),
      coord.state == CWorking,
      coord' = { ...coord, lastReadSeq: maxSeq(coord.lastReadSeq, nextRead) },
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board
    }
  }

  // Coordinator calls swarm_wait.
  action coordRequestWait(mentionsOnly: bool): bool = {
    val mode = if (mentionsOnly) ModeMentions else ModeAnything
    val hasMatch = board.select(m => m.seq > coord.lastReadSeq and msgWakesCoord(m, { ...coord, wakeMode: mode })).length() > 0
    all {
      not(mgr.disposed),
      coord.state == CWorking,
      not(hasMatch),
      coord' = { ...coord, wakeMode: mode, waitSince: coord.lastReadSeq, explicitWait: true },
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board
    }
  }

  // Coordinator agent_settled (extensions/index.ts:392-401 + src/runtime.ts:775-806):
  // Transitions to CWaiting, hostIsIdle = true, flushes pending wake once without double delivery.
  action coordSettled: bool = {
    val nextMode = if (coord.explicitWait) coord.wakeMode else ModeMentions
    val nextWaitSince = if (coord.explicitWait) coord.waitSince else coord.lastReadSeq
    val pending = maxSeq(coord.runtimePendingWake, coord.extPendingWake)
    val shouldDeliver = pending > 0 and coord.lastReadSeq < pending
    all {
      not(mgr.disposed),
      coord.state == CWorking,
      coord' = {
        ...coord,
        state: CWaiting,
        hostIsIdle: true,
        wakeMode: nextMode,
        waitSince: nextWaitSince,
        explicitWait: false,
        runtimePendingWake: 0,
        extPendingWake: 0,
        sentWakeSeqs: if (shouldDeliver) coord.sentWakeSeqs.append(pending) else coord.sentWakeSeqs
      },
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board
    }
  }

  // agent_end / session_compact while coord.state == CWaiting -> hostIsIdle becomes true & flushes wake.
  action coordHostIdleFlush: bool = {
    val pending = maxSeq(coord.runtimePendingWake, coord.extPendingWake)
    val shouldDeliver = pending > 0 and coord.lastReadSeq < pending
    all {
      not(mgr.disposed),
      coord.state == CWaiting,
      not(coord.hostIsIdle),
      coord' = {
        ...coord,
        hostIsIdle: true,
        runtimePendingWake: 0,
        extPendingWake: 0,
        sentWakeSeqs: if (shouldDeliver) coord.sentWakeSeqs.append(pending) else coord.sentWakeSeqs
      },
      mgr' = tickMgr(mgr),
      procs' = procs,
      emittedEvents' = emittedEvents,
      workers' = workers,
      wakingWorkers' = wakingWorkers,
      workerStartingSession' = workerStartingSession,
      workerBlockedOnBash' = workerBlockedOnBash,
      pendingProcEvents' = pendingProcEvents,
      pendingWakeSeq' = pendingWakeSeq,
      deliveredProcEvents' = deliveredProcEvents,
      microtasks' = microtasks,
      board' = board
    }
  }

  // --- Next-state relation ---

  action step = {
    nondet w = WORKERS.oneOf()
    nondet caller = Set("coordinator", "w1", "w2").oneOf()
    nondet b1 = Set(true, false).oneOf()
    nondet b2 = Set(true, false).oneOf()
    nondet b3 = Set(true, false).oneOf()
    val knownTids = procs.keys()
    nondet tid = (if (knownTids.size() > 0) knownTids else Set(0)).oneOf()
    any {
      runWorkerBashStart(w, b1),
      finishProcessSpawn(tid),
      processSyncExit(tid),
      promoteToBackground(tid),
      processOutput(tid),
      fireReminder(tid),
      processNaturalExit(tid),
      processChildError(tid),
      processFinalizeAfterKill(tid),
      manageProcessOp(w, tid, b1),
      workerFinishSessionStart(w),
      workerTurnEndError(w),
      workerRequestWait(w, b1),
      workerReadBoard(w),
      workerSettled(w),
      runMicrotask,
      switchWorkerModel(w),
      killWorkerTarget(w),
      stopAllStart,
      stopAllFinish,
      disposeManager,
      postBoardMessage(caller, b1, b2, b3),
      coordStartTurn,
      coordHostBusy,
      coordReadBoard(b1),
      coordRequestWait(b1),
      coordSettled,
      coordHostIdleFlush,
    }
  }

  // --- Safety invariants ---

  val noOrphanProcessAfterWorkerKill: bool =
    WORKERS.forall(w =>
      workers.get(w).status == WKilled implies
        procs.keys().forall(tid => {
          val p = procs.get(tid)
          p.owner == w implies p.state != ProcRunning
        })
    )

  val noOrphanProcessAfterDispose: bool =
    mgr.disposed implies
      procs.keys().forall(tid => procs.get(tid).state != ProcRunning)

  val noExitWakeAfterManualKill: bool =
    procs.keys().forall(tid =>
      procs.get(tid).manuallyKilled implies
        emittedEvents.select(ev => ev.taskId == tid and ev.kind == EvProcessExit).length() == 0
    )

  val noReminderForDaemon: bool =
    procs.keys().forall(tid =>
      procs.get(tid).isDaemon implies
        emittedEvents.select(ev => ev.taskId == tid and ev.kind == EvProcessStillRunning).length() == 0
    )

  val noCrossWorkerAccess: bool =
    procs.keys().forall(tid => procs.get(tid).lastAccessedBy == procs.get(tid).owner)

  val noLostProcessEventWhileAlive: bool =
    (not(mgr.disposed) and not(mgr.stopping) and not(mgr.stoppedAll)) implies
      emittedEvents.indices().forall(i => {
        val ev = emittedEvents.nth(i)
        val wr = workers.get(ev.owner)
        (not(ev.beforeStopAll) and wr.status != WKilled and wr.status != WStopped) implies (
          listContainsEvent(deliveredProcEvents.get(ev.owner), ev) or
          listContainsEvent(pendingProcEvents.get(ev.owner), ev) or
          microtasksContainEvent(microtasks, ev.owner, ev)
        )
      })

  val noLostCoordinatorWake: bool =
    (not(mgr.disposed) and not(mgr.stopping) and not(mgr.stoppedAll) and coord.wakeRequiredSeq > coord.lastReadSeq) implies (
      coord.runtimePendingWake >= coord.wakeRequiredSeq or
      coord.extPendingWake >= coord.wakeRequiredSeq or
      coord.sentWakeSeqs.select(s => s >= coord.wakeRequiredSeq).length() > 0
    )

  val noBlockedWorkerOnLongCommand: bool =
    procs.keys().forall(tid => {
      val p = procs.get(tid)
      p.promoted implies (
        p.runSettled and
        not(p.owner.in(workerBlockedOnBash.keys()) and workerBlockedOnBash.get(p.owner) == tid)
      )
    })

  val noActiveSessionAfterKillOrDispose: bool =
    WORKERS.forall(w =>
      (mgr.disposed or workers.get(w).status == WKilled) implies
        not(workers.get(w).hasActiveSession)
    )

  val allInvariants: bool = and {
    noOrphanProcessAfterWorkerKill,
    noOrphanProcessAfterDispose,
    noExitWakeAfterManualKill,
    noReminderForDaemon,
    noCrossWorkerAccess,
    noLostProcessEventWhileAlive,
    noLostCoordinatorWake,
    noBlockedWorkerOnLongCommand,
    noActiveSessionAfterKillOrDispose,
  }

  // --- Deterministic end-to-end scenario tests ---

  run fastSyncExitTest =
    init
      .then(runWorkerBashStart("w1", false))
      .then(finishProcessSpawn(1))
      .then(processSyncExit(1))
      .expect(and {
        procs.get(1).state == ProcExited,
        not(procs.get(1).promoted),
        emittedEvents.length() == 0,
        not("w1".in(workerBlockedOnBash.keys())),
        allInvariants
      })

  run asyncPromotionOutputReminderExitTest =
    init
      .then(runWorkerBashStart("w1", false))
      .then(finishProcessSpawn(1))
      .then(promoteToBackground(1))
      .expect(and {
        procs.get(1).promoted,
        not("w1".in(workerBlockedOnBash.keys())),
        noBlockedWorkerOnLongCommand
      })
      .then(processOutput(1))
      .expect(procs.get(1).lastOutputAt > procs.get(1).startedAt)
      .then(fireReminder(1))
      .expect(emittedEvents.length() == 1 and emittedEvents.nth(0).kind == EvProcessStillRunning)
      .then(processNaturalExit(1))
      .expect(and {
        emittedEvents.length() == 2,
        emittedEvents.nth(1).kind == EvProcessExit,
        pendingProcEvents.get("w1").length() == 2
      })
      .then(workerSettled("w1"))
      .then(runMicrotask)
      .expect(and {
        deliveredProcEvents.get("w1").length() == 2,
        pendingProcEvents.get("w1").length() == 0,
        allInvariants
      })

  run daemonReminderDisabledTest =
    init
      .then(runWorkerBashStart("w1", true))
      .then(finishProcessSpawn(1))
      .then(promoteToBackground(1))
      .then(fireReminder(1).fail())

  run daemonNoReminderManualKillTest =
    init
      .then(runWorkerBashStart("w1", true))
      .then(finishProcessSpawn(1))
      .then(promoteToBackground(1))
      .then(manageProcessOp("w1", 1, true))
      .then(processFinalizeAfterKill(1))
      .expect(and {
        procs.get(1).state == ProcKilled,
        procs.get(1).exiting,
        emittedEvents.length() == 0,
        allInvariants
      })

  run crossWorkerIsolationTest =
    init
      .then(runWorkerBashStart("w1", false))
      .then(finishProcessSpawn(1))
      .then(promoteToBackground(1))
      .then(postBoardMessage("w1", false, false, true))
      .then(runMicrotask)
      .then(manageProcessOp("w2", 1, true))
      .expect(and {
        procs.get(1).state == ProcRunning,
        procs.get(1).lastAccessedBy == "w1",
        not(procs.get(1).manuallyKilled),
        allInvariants
      })

  run errorPreservesProcessEventAndSwitchModelTest =
    init
      .then(runWorkerBashStart("w1", false))
      .then(finishProcessSpawn(1))
      .then(promoteToBackground(1))
      .then(workerTurnEndError("w1"))
      .then(workerSettled("w1"))
      .expect(workers.get("w1").lastError and workers.get("w1").lastTurnErrored)
      .then(processNaturalExit(1))
      .expect(and {
        workers.get("w1").status == WWaiting,
        pendingProcEvents.get("w1").length() == 1,
        deliveredProcEvents.get("w1").length() == 0
      })
      .then(switchWorkerModel("w1"))
      .expect(and {
        not(workers.get("w1").lastError),
        pendingProcEvents.get("w1").length() == 1
      })
      .then(runMicrotask)
      .then(workerSettled("w1"))
      .then(runMicrotask)
      .expect(and {
        deliveredProcEvents.get("w1").length() == 1,
        pendingProcEvents.get("w1").length() == 0,
        allInvariants
      })

  run coordinatorBusyMultiMessageWakeTest =
    init
      .then(coordStartTurn)
      .then(postBoardMessage("w1", true, false, false))
      .then(postBoardMessage("w1", true, false, false))
      .expect(coord.runtimePendingWake == 2 and coord.sentWakeSeqs.length() == 0)
      .then(coordSettled)
      .expect(coord.sentWakeSeqs == List(2) and coord.runtimePendingWake == 0)
      .then(coordStartTurn)
      .then(coordReadBoard(true))
      .then(coordSettled)
      .expect(coord.lastReadSeq == 2 and coord.sentWakeSeqs == List(2) and allInvariants)

  run fsAccessCancelOnDisposeFixedTest =
    init
      .then(runWorkerBashStart("w1", false))
      .then(disposeManager)
      .then(finishProcessSpawn(1))
      .expect(and {
        procs.get(1).state == ProcCancelled,
        not("w1".in(workerBlockedOnBash.keys())),
        allInvariants
      })

  run fsAccessCancelOnWorkerKillFixedTest =
    init
      .then(runWorkerBashStart("w1", false))
      .then(killWorkerTarget("w1"))
      .then(finishProcessSpawn(1))
      .expect(and {
        procs.get(1).state == ProcCancelled,
        workers.get("w1").status == WKilled,
        not("w1".in(workerBlockedOnBash.keys())),
        allInvariants
      })

  run childErrorAfterManualKillFixedTest =
    init
      .then(runWorkerBashStart("w1", false))
      .then(finishProcessSpawn(1))
      .then(promoteToBackground(1))
      .then(manageProcessOp("w1", 1, true))
      .then(processChildError(1))
      .expect(and {
        procs.get(1).state == ProcKilled,
        procs.get(1).exiting,
        emittedEvents.length() == 0,
        allInvariants
      })

  run workerKillDuringSessionStartupFixedTest =
    init
      .then(coordStartTurn)
      .then(postBoardMessage("coordinator", false, false, true))
      .then(runMicrotask)
      .expect("w2".in(workerStartingSession))
      .then(killWorkerTarget("w2"))
      .then(workerFinishSessionStart("w2"))
      .expect(and {
        workers.get("w2").status == WKilled,
        not(workers.get("w2").hasActiveSession),
        not("w2".in(workerStartingSession)),
        allInvariants
      })
}
