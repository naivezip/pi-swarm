// Formal specification of pi-swarm full-screen Worker View, Overlay navigation,
// direct private chat queueing, single-worker abort isolation, and concurrency races.
// Models actual control flow in:
//   - src/runtime.ts (SwarmManager)
//   - src/ui.ts (SwarmOverlayComponent, openSwarmOverlay)
//   - src/worker-view.ts (SwarmWorkerViewComponent)
//   - src/worker-view-commands.ts (slash commands, WorkerModelPickerComponent)
module swarm_worker_view {
  pure val WORKERS: Set[str] = Set("w1", "w2")
  pure val MODELS: Set[str] = Set("p/a", "p/b")

  type WorkerStatus = WWaiting | WWorking | WStopped | WKilled
  type CoordStatus = CWaiting | CWorking
  type OverlayTab = TabOverview | TabBoard | TabWorkers
  type WorkerModal = WModalNone | WModalConfirmKill | WModalModelPicker

  type WorkerRecord = {
    status: WorkerStatus,
    model: str,
    hasActiveSession: bool,
    turnActive: bool,
    resuming: bool,
    waking: bool,
    abortRequestedBeforeSession: bool,
    abortRequestedByUser: bool,
    lastTurnErrored: bool,
    steerQueue: List[str],
    followUpQueue: List[str],
    inFlightSteer: List[str],
    inFlightFollowUp: List[str],
    inFlightSetModel: str,
    pendingDrainNext: str,
    abortCount: int
  }

  type OverlayState = {
    tab: OverlayTab,
    overviewSelected: str,
    overviewScroll: int,
    workerIdx: int
  }

  type WorkerViewState = {
    worker: str,
    returnTab: OverlayTab,
    modal: WorkerModal,
    autocomplete: bool,
    readOnly: bool,
    lastStatusError: bool
  }

  type UiScreen =
    | UiCoordinator
    | UiOverlay(OverlayState)
    | UiWorkerView(WorkerViewState)

  type SysState = {
    coordStatus: CoordStatus,
    coordAbortCount: int,
    boardSeq: int,
    publicBoardSeq: int,
    stopping: bool,
    hasPlan: bool,
    planTasks: List[str],
    lastDirectRejected: bool,
    lastAbortedResult: bool
  }

  var workers: str -> WorkerRecord
  var ui: UiScreen
  var sys: SysState

  pure def listRemoveFirst(lst: List[str], target: str): List[str] =
    lst.foldl({ removed: false, acc: List() }, (st, el) =>
      if (not(st.removed) and el == target) { removed: true, acc: st.acc }
      else { removed: st.removed, acc: st.acc.append(el) }
    ).acc

  pure def listContains(lst: List[str], target: str): bool =
    lst.select(x => x == target).length() > 0

  pure def selectableOverview(ws: str -> WorkerRecord, planActive: bool, pTasks: List[str]): List[str] =
    if (planActive) {
      val fromThreads = pTasks.select(n => n.in(ws.keys()))
      val extras = ws.keys().fold(List(), (acc, n) =>
        if (listContains(fromThreads, n)) acc else acc.append(n)
      )
      fromThreads.concat(extras)
    } else {
      ws.keys().fold(List(), (acc, n) => acc.append(n))
    }

  pure def workerListOrder(ws: str -> WorkerRecord): List[str] =
    List("w1", "w2").select(n => n.in(ws.keys()))

  pure def indexOfStr(lst: List[str], target: str): int =
    0.to(lst.length() - 1).fold(-1, (acc, i) => if (acc >= 0) acc else if (lst.nth(i) == target) i else -1)

  pure def isOverlay(s: UiScreen): bool = match s { | UiOverlay(_) => true | _ => false }
  pure def asOverlay(s: UiScreen): OverlayState = match s {
    | UiOverlay(o) => o
    | _ => { tab: TabOverview, overviewSelected: "", overviewScroll: 0, workerIdx: 0 }
  }

  pure def isWorkerView(s: UiScreen): bool = match s { | UiWorkerView(_) => true | _ => false }
  pure def asWorkerView(s: UiScreen): WorkerViewState = match s {
    | UiWorkerView(v) => v
    | _ => { worker: "", returnTab: TabOverview, modal: WModalNone, autocomplete: false, readOnly: true, lastStatusError: false }
  }

  pure def initWorker(st: WorkerStatus, active: bool): WorkerRecord = {
    status: st, model: "p/a", hasActiveSession: active, turnActive: st == WWorking,
    resuming: false, waking: false, abortRequestedBeforeSession: false,
    abortRequestedByUser: false, lastTurnErrored: false,
    steerQueue: List(), followUpQueue: List(),
    inFlightSteer: List(), inFlightFollowUp: List(),
    inFlightSetModel: "", pendingDrainNext: "", abortCount: 0
  }

  pure def syncUiForWorkers(screen: UiScreen, ws: str -> WorkerRecord): UiScreen =
    match screen {
      | UiWorkerView(v) => {
          val isKilled = not(v.worker.in(ws.keys())) or ws.get(v.worker).status == WKilled
          UiWorkerView({
            ...v,
            modal: if (isKilled) WModalNone else v.modal,
            autocomplete: if (isKilled) false else v.autocomplete,
            readOnly: isKilled
          })
        }
      | _ => screen
    }

  pure def clearWorkerRecordQueues(wr: WorkerRecord): WorkerRecord = {
    ...wr, steerQueue: List(), followUpQueue: List(), pendingDrainNext: ""
  }

  action init = all {
    workers' = Map("w1" -> initWorker(WWorking, true), "w2" -> initWorker(WStopped, false)),
    ui' = UiCoordinator,
    sys' = {
      coordStatus: CWaiting, coordAbortCount: 0, boardSeq: 1, publicBoardSeq: 1,
      stopping: false, hasPlan: true, planTasks: List("w1", "ghost", "w2"),
      lastDirectRejected: false, lastAbortedResult: false
    }
  }

  action coordToggleTurn = all {
    workers' = workers, ui' = ui,
    sys' = { ...sys, coordStatus: if (sys.coordStatus == CWaiting) CWorking else CWaiting }
  }

  action publicBoardPost = all {
    workers' = workers, ui' = ui,
    sys' = { ...sys, boardSeq: sys.boardSeq + 1, publicBoardSeq: sys.publicBoardSeq + 1 }
  }

  // --- Direct private messaging (src/runtime.ts sendDirectWorkerMessage) ---

  action startDirectMessage(w: str, isFollowUp: bool, text: str): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val canStart = w.in(workers.keys())
    if (not(canStart)) all { false, workers' = workers, ui' = ui, sys' = sys }
    else if (sys.stopping or wr.status == WKilled) all {
      workers' = workers, ui' = ui, sys' = { ...sys, lastDirectRejected: true }
    } else if (wr.status == WStopped and not(wr.hasActiveSession) and not(wr.resuming)) {
      val nextWr = { ...wr, status: WWorking, resuming: true, waking: true, lastTurnErrored: false, abortRequestedByUser: false, pendingDrainNext: text }
      val nextWs = workers.set(w, nextWr)
      all { workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = { ...sys, lastDirectRejected: false } }
    } else if ((wr.status == WWorking or wr.waking) and wr.hasActiveSession) {
      val nextWr = if (isFollowUp) {
        ...wr, followUpQueue: wr.followUpQueue.append(text), inFlightFollowUp: wr.inFlightFollowUp.append(text)
      } else {
        ...wr, steerQueue: wr.steerQueue.append(text), inFlightSteer: wr.inFlightSteer.append(text)
      }
      val nextWs = workers.set(w, nextWr)
      all { workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = { ...sys, lastDirectRejected: false } }
    } else if (wr.status == WWaiting and wr.hasActiveSession) {
      val nextWr = { ...wr, status: WWorking, turnActive: true, lastTurnErrored: false, abortRequestedByUser: false }
      val nextWs = workers.set(w, nextWr)
      all { workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = { ...sys, lastDirectRejected: false } }
    } else all {
      workers' = workers, ui' = ui, sys' = { ...sys, lastDirectRejected: true }
    }
  }

  action finishDirectResume(w: str, ok: bool): bool = {
    val okPre = w.in(workers.keys()) and workers.get(w).resuming
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val nextWr =
      if (wr.status == WKilled or sys.stopping) {
        ...wr, resuming: false, waking: false, hasActiveSession: false, turnActive: false, pendingDrainNext: "", abortRequestedBeforeSession: false
      } else if (wr.abortRequestedBeforeSession) {
        ...wr, status: WWaiting, resuming: false, waking: false, hasActiveSession: true, turnActive: false, pendingDrainNext: "", abortRequestedBeforeSession: false
      } else if (ok) {
        ...wr, status: WWorking, resuming: false, waking: false, hasActiveSession: true, turnActive: true, pendingDrainNext: "", lastTurnErrored: false, abortRequestedByUser: false
      } else {
        ...wr, status: WStopped, resuming: false, waking: false, hasActiveSession: false, turnActive: false, pendingDrainNext: "", lastTurnErrored: true
      }
    val nextWs = workers.set(w, nextWr)
    all { okPre, workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = sys }
  }

  action finishDirectQueue(w: str, isFollowUp: bool, ok: bool): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val hasInFlight = if (isFollowUp) wr.inFlightFollowUp.length() > 0 else wr.inFlightSteer.length() > 0
    val text = if (not(hasInFlight)) "" else if (isFollowUp) wr.inFlightFollowUp.head() else wr.inFlightSteer.head()
    val wrPopped = if (not(hasInFlight)) wr else if (isFollowUp) { ...wr, inFlightFollowUp: wr.inFlightFollowUp.tail() } else { ...wr, inFlightSteer: wr.inFlightSteer.tail() }
    val nextWr =
      if (wrPopped.status == WKilled) clearWorkerRecordQueues(wrPopped)
      else if (not(ok)) {
        if (isFollowUp) { ...wrPopped, followUpQueue: listRemoveFirst(wrPopped.followUpQueue, text) }
        else { ...wrPopped, steerQueue: listRemoveFirst(wrPopped.steerQueue, text) }
      } else if (wrPopped.abortRequestedByUser or wrPopped.status != WWorking) clearWorkerRecordQueues(wrPopped)
      else wrPopped
    val nextWs = workers.set(w, nextWr)
    all {
      w.in(workers.keys()), hasInFlight,
      workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs),
      sys' = { ...sys, lastDirectRejected: not(ok) or wrPopped.status == WKilled or wrPopped.status != WWorking }
    }
  }

  action consumeQueuedMsg(w: str): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val nextWr =
      if (wr.steerQueue.length() > 0) { ...wr, steerQueue: wr.steerQueue.tail() }
      else if (wr.followUpQueue.length() > 0) { ...wr, followUpQueue: wr.followUpQueue.tail() }
      else wr
    all {
      w.in(workers.keys()), wr.status == WWorking, wr.turnActive,
      wr.steerQueue.length() > 0 or wr.followUpQueue.length() > 0,
      workers' = workers.set(w, nextWr), ui' = ui, sys' = sys
    }
  }

  action workerSettled(w: str, aborted: bool, errored: bool): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val wasAborted = aborted or wr.abortRequestedByUser
    val nextWr =
      if (wasAborted) { ...clearWorkerRecordQueues(wr), status: WWaiting, turnActive: false, abortRequestedByUser: false, lastTurnErrored: false }
      else if (errored) { ...wr, status: WWaiting, turnActive: false, abortRequestedByUser: false, lastTurnErrored: true }
      else if (wr.steerQueue.length() > 0) { ...wr, status: WWaiting, turnActive: false, abortRequestedByUser: false, pendingDrainNext: wr.steerQueue.head(), steerQueue: wr.steerQueue.tail() }
      else if (wr.followUpQueue.length() > 0) { ...wr, status: WWaiting, turnActive: false, abortRequestedByUser: false, pendingDrainNext: wr.followUpQueue.head(), followUpQueue: wr.followUpQueue.tail() }
      else { ...wr, status: WWaiting, turnActive: false, abortRequestedByUser: false }
    val nextWs = workers.set(w, nextWr)
    all {
      w.in(workers.keys()), wr.status == WWorking and wr.hasActiveSession and wr.turnActive,
      workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = sys
    }
  }

  action runDrainMicrotask(w: str): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val nextWr =
      if (sys.stopping or wr.status != WWaiting or not(wr.hasActiveSession)) { ...wr, pendingDrainNext: "" }
      else { ...wr, status: WWorking, turnActive: true, lastTurnErrored: false, pendingDrainNext: "" }
    val nextWs = workers.set(w, nextWr)
    all {
      w.in(workers.keys()), wr.pendingDrainNext != "" and not(wr.resuming),
      workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = sys
    }
  }

  // --- Single-worker abort isolation (src/runtime.ts abortWorkerByUser) ---

  action abortWorkerByUser(w: str): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    if (not(w.in(workers.keys()))) all { false, workers' = workers, ui' = ui, sys' = sys }
    else if (wr.status != WWorking and not(wr.waking)) all {
      workers' = workers, ui' = ui, sys' = { ...sys, lastAbortedResult: false }
    } else if (not(wr.hasActiveSession) and wr.resuming) {
      val nextWr = { ...wr, abortRequestedBeforeSession: true, abortCount: wr.abortCount + 1 }
      all { workers' = workers.set(w, nextWr), ui' = ui, sys' = { ...sys, lastAbortedResult: true } }
    } else {
      val nextWr = { ...clearWorkerRecordQueues(wr), status: WWaiting, turnActive: false, abortRequestedByUser: false, lastTurnErrored: false, abortCount: wr.abortCount + 1 }
      val nextWs = workers.set(w, nextWr)
      all { workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = { ...sys, lastAbortedResult: true } }
    }
  }

  // --- Model switch, Kill, StopAll ---

  action startSwitchModel(w: str, m: str): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val nextWr = if (wr.hasActiveSession) { ...wr, inFlightSetModel: m } else { ...wr, model: m, lastTurnErrored: false }
    all {
      w.in(workers.keys()), m.in(MODELS),
      wr.status != WKilled and wr.status != WWorking and not(wr.waking) and wr.inFlightSetModel == "",
      workers' = workers.set(w, nextWr), ui' = ui, sys' = sys
    }
  }

  action finishSwitchModel(w: str): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val targetModel = wr.inFlightSetModel
    val nextWr =
      if (wr.status == WKilled) { ...wr, inFlightSetModel: "" }
      else { ...wr, model: targetModel, lastTurnErrored: false, inFlightSetModel: "" }
    all {
      w.in(workers.keys()), wr.inFlightSetModel != "",
      workers' = workers.set(w, nextWr), ui' = ui,
      sys' = { ...sys, lastDirectRejected: wr.status == WKilled }
    }
  }

  action killWorkerByUser(w: str): bool = {
    val wr = if (w.in(workers.keys())) workers.get(w) else initWorker(WKilled, false)
    val nextWr = {
      ...clearWorkerRecordQueues(wr),
      status: WKilled, hasActiveSession: false, turnActive: false,
      resuming: false, waking: false, abortRequestedBeforeSession: false, abortRequestedByUser: false
    }
    val nextWs = workers.set(w, nextWr)
    all {
      w.in(workers.keys()), wr.status != WKilled,
      workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = sys
    }
  }

  action stopAllWorkers: bool = {
    val nextWs = workers.keys().mapBy(w => {
      val wr = workers.get(w)
      if (wr.status == WKilled) wr
      else {
        ...clearWorkerRecordQueues(wr),
        status: if (wr.hasActiveSession) WWaiting else WStopped,
        turnActive: false, resuming: false, waking: false,
        abortRequestedBeforeSession: false, abortRequestedByUser: false
      }
    })
    all {
      not(sys.stopping),
      workers' = nextWs, ui' = syncUiForWorkers(ui, nextWs), sys' = sys
    }
  }

  // --- UI View-Stack: Coordinator <-> Overlay <-> WorkerView ---

  action uiOpenOverlay(tab: OverlayTab): bool = {
    val selList = selectableOverview(workers, sys.hasPlan, sys.planTasks)
    val firstSel = if (selList.length() > 0) selList.head() else ""
    all {
      ui == UiCoordinator,
      ui' = UiOverlay({ tab: tab, overviewSelected: firstSel, overviewScroll: 0, workerIdx: 0 }),
      workers' = workers, sys' = sys
    }
  }

  action uiOverlaySwitchTab(tab: OverlayTab): bool = {
    val o = asOverlay(ui)
    all {
      isOverlay(ui),
      ui' = UiOverlay({ ...o, tab: tab }),
      workers' = workers, sys' = sys
    }
  }

  action uiOverlayOverviewMove(stepVal: int): bool = {
    val o = asOverlay(ui)
    val sel = selectableOverview(workers, sys.hasPlan, sys.planTasks)
    val nextUi =
      if (sel.length() == 0) {
        val nextScroll = if (o.overviewScroll + stepVal < 0) 0 else o.overviewScroll + stepVal
        UiOverlay({ ...o, overviewSelected: "", overviewScroll: nextScroll })
      } else {
        val cur = indexOfStr(sel, o.overviewSelected)
        val baseIdx = if (cur >= 0) cur else 0
        val rawNext = baseIdx + stepVal
        val clamped = if (rawNext < 0) 0 else if (rawNext >= sel.length()) sel.length() - 1 else rawNext
        UiOverlay({ ...o, overviewSelected: sel.nth(clamped) })
      }
    all {
      isOverlay(ui), o.tab == TabOverview, stepVal == 1 or stepVal == -1,
      ui' = nextUi, workers' = workers, sys' = sys
    }
  }

  action uiOverlayEnterWorker: bool = {
    val o = asOverlay(ui)
    val target =
      if (o.tab == TabOverview) {
        val sel = selectableOverview(workers, sys.hasPlan, sys.planTasks)
        val idx = indexOfStr(sel, o.overviewSelected)
        if (idx >= 0) sel.nth(idx) else if (sel.length() > 0) sel.head() else ""
      } else {
        val wl = workerListOrder(workers)
        if (wl.length() == 0) ""
        else {
          val clamped = if (o.workerIdx < 0) 0 else if (o.workerIdx >= wl.length()) wl.length() - 1 else o.workerIdx
          wl.nth(clamped)
        }
      }
    val isKilled = not(target.in(workers.keys())) or workers.get(target).status == WKilled
    all {
      isOverlay(ui), o.tab == TabOverview or o.tab == TabWorkers, target != "",
      ui' = UiWorkerView({
        worker: target, returnTab: o.tab, modal: WModalNone,
        autocomplete: false, readOnly: isKilled, lastStatusError: false
      }),
      workers' = workers, sys' = sys
    }
  }

  action uiOverlayClose: bool = all {
    isOverlay(ui), ui' = UiCoordinator, workers' = workers, sys' = sys
  }

  action uiToggleEmptyOverviewPlan(onlyGhost: bool): bool = {
    val nextTasks = if (onlyGhost) List("ghost") else List("w1", "ghost", "w2")
    val nextWs = if (onlyGhost) Map() else workers
    val nextUi = if (isOverlay(ui)) {
      val o = asOverlay(ui)
      val sel = selectableOverview(nextWs, true, nextTasks)
      UiOverlay({ ...o, overviewSelected: if (sel.length() > 0) sel.head() else "" })
    } else ui
    all {
      workers' = nextWs, ui' = nextUi,
      sys' = { ...sys, hasPlan: true, planTasks: nextTasks }
    }
  }

  // --- WorkerView interactions (src/worker-view.ts & src/worker-view-commands.ts) ---

  action uiWorkerToggleAutocomplete(open: bool): bool = {
    val v = asWorkerView(ui)
    all {
      isWorkerView(ui), v.modal == WModalNone, not(v.readOnly),
      v.worker.in(workers.keys()), workers.get(v.worker).status != WKilled,
      ui' = UiWorkerView({ ...v, autocomplete: open }),
      workers' = workers, sys' = sys
    }
  }

  action uiWorkerEsc: bool = {
    val v = asWorkerView(ui)
    val isKilled = not(v.worker.in(workers.keys())) or workers.get(v.worker).status == WKilled
    if (not(isWorkerView(ui))) all { false, workers' = workers, ui' = ui, sys' = sys }
    else if (isKilled) all { ui' = UiCoordinator, workers' = workers, sys' = sys }
    else if (v.modal != WModalNone) all { ui' = UiWorkerView({ ...v, modal: WModalNone, lastStatusError: false }), workers' = workers, sys' = sys }
    else if (v.autocomplete) all { ui' = UiWorkerView({ ...v, autocomplete: false }), workers' = workers, sys' = sys }
    else if (workers.get(v.worker).status == WWorking or workers.get(v.worker).waking) abortWorkerByUser(v.worker)
    else all { ui' = UiCoordinator, workers' = workers, sys' = sys }
  }

  action uiWorkerCtrlD: bool = {
    val v = asWorkerView(ui)
    all { isWorkerView(ui), v.modal == WModalNone, ui' = UiCoordinator, workers' = workers, sys' = sys }
  }

  action uiWorkerAltS: bool = {
    val v = asWorkerView(ui)
    val sel = selectableOverview(workers, sys.hasPlan, sys.planTasks)
    all {
      isWorkerView(ui), v.modal == WModalNone,
      ui' = UiOverlay({ tab: v.returnTab, overviewSelected: if (sel.length() > 0) sel.head() else "", overviewScroll: 0, workerIdx: 0 }),
      workers' = workers, sys' = sys
    }
  }

  action uiWorkerSubmitChat(isFollowUp: bool, text: str): bool = {
    val v = asWorkerView(ui)
    if (not(isWorkerView(ui)) or v.modal != WModalNone or v.readOnly) all { false, workers' = workers, ui' = ui, sys' = sys }
    else startDirectMessage(v.worker, isFollowUp, text)
  }

  action uiWorkerSlashModel(hasArg: bool, m: str): bool = {
    val v = asWorkerView(ui)
    if (not(isWorkerView(ui)) or v.modal != WModalNone or v.readOnly or not(v.worker.in(workers.keys()))) all {
      false, workers' = workers, ui' = ui, sys' = sys
    } else {
      val wr = workers.get(v.worker)
      if (wr.status == WKilled or wr.status == WWorking or wr.waking) all {
        ui' = UiWorkerView({ ...v, lastStatusError: true }), workers' = workers, sys' = sys
      } else if (hasArg) startSwitchModel(v.worker, m)
      else all {
        ui' = UiWorkerView({ ...v, modal: WModalModelPicker, autocomplete: false, lastStatusError: false }),
        workers' = workers, sys' = sys
      }
    }
  }

  action uiWorkerModelPickerSelect(m: str): bool = {
    val v = asWorkerView(ui)
    val okBase = isWorkerView(ui) and v.modal == WModalModelPicker and m.in(MODELS) and v.worker.in(workers.keys())
    val wr = if (v.worker.in(workers.keys())) workers.get(v.worker) else initWorker(WKilled, false)
    val nextWr = if (wr.hasActiveSession) { ...wr, inFlightSetModel: m } else { ...wr, model: m, lastTurnErrored: false }
    all {
      okBase, wr.status != WKilled and wr.status != WWorking and not(wr.waking) and wr.inFlightSetModel == "",
      workers' = workers.set(v.worker, nextWr),
      ui' = UiWorkerView({ ...v, modal: WModalNone, lastStatusError: false }),
      sys' = sys
    }
  }

  action uiWorkerSlashAbort: bool = {
    val v = asWorkerView(ui)
    if (not(isWorkerView(ui)) or v.modal != WModalNone or v.readOnly or not(v.worker.in(workers.keys()))) all {
      false, workers' = workers, ui' = ui, sys' = sys
    } else abortWorkerByUser(v.worker)
  }

  action uiWorkerSlashKill: bool = {
    val v = asWorkerView(ui)
    all {
      isWorkerView(ui), v.modal == WModalNone, not(v.readOnly),
      v.worker.in(workers.keys()), workers.get(v.worker).status != WKilled,
      ui' = UiWorkerView({ ...v, modal: WModalConfirmKill, autocomplete: false, lastStatusError: false }),
      workers' = workers, sys' = sys
    }
  }

  action uiWorkerConfirmKill(confirm: bool): bool = {
    val v = asWorkerView(ui)
    if (not(isWorkerView(ui)) or v.modal != WModalConfirmKill or not(v.worker.in(workers.keys()))) all {
      false, workers' = workers, ui' = ui, sys' = sys
    } else if (confirm) killWorkerByUser(v.worker)
    else all {
      ui' = UiWorkerView({ ...v, modal: WModalNone, lastStatusError: false }),
      workers' = workers, sys' = sys
    }
  }

  action uiWorkerSlashExit: bool = {
    val v = asWorkerView(ui)
    all { isWorkerView(ui), v.modal == WModalNone, not(v.readOnly), ui' = UiCoordinator, workers' = workers, sys' = sys }
  }

  action uiWorkerSlashBoardOrUnknown: bool = {
    val v = asWorkerView(ui)
    all {
      isWorkerView(ui), v.modal == WModalNone, not(v.readOnly),
      ui' = UiWorkerView({ ...v, lastStatusError: true }), workers' = workers, sys' = sys
    }
  }

  action step = any {
    coordToggleTurn,
    publicBoardPost,
    nondet w = oneOf(WORKERS)
    nondet m = oneOf(MODELS)
    nondet deliv = oneOf(Set(false, true))
    nondet ok = oneOf(Set(false, true))
    any {
      startDirectMessage(w, deliv, "msg"),
      finishDirectResume(w, ok),
      finishDirectQueue(w, deliv, ok),
      consumeQueuedMsg(w),
      workerSettled(w, deliv, ok),
      runDrainMicrotask(w),
      abortWorkerByUser(w),
      startSwitchModel(w, m),
      finishSwitchModel(w),
      killWorkerByUser(w),
    },
    stopAllWorkers,
    nondet tab = oneOf(Set(TabOverview, TabBoard, TabWorkers))
    nondet dir = oneOf(Set(-1, 1))
    nondet b = oneOf(Set(false, true))
    nondet m2 = oneOf(MODELS)
    any {
      uiOpenOverlay(tab),
      uiOverlaySwitchTab(tab),
      uiOverlayOverviewMove(dir),
      uiOverlayEnterWorker,
      uiOverlayClose,
      uiWorkerToggleAutocomplete(b),
      uiWorkerEsc,
      uiWorkerCtrlD,
      uiWorkerAltS,
      uiWorkerSubmitChat(b, "chat"),
      uiWorkerSlashModel(b, m2),
      uiWorkerModelPickerSelect(m2),
      uiWorkerSlashAbort,
      uiWorkerSlashKill,
      uiWorkerConfirmKill(b),
      uiWorkerSlashExit,
      uiWorkerSlashBoardOrUnknown,
    }
  }

  // --- Safety Invariants ---

  val invZeroBoardPostsFromDirectChat: bool = sys.boardSeq == sys.publicBoardSeq
  val invCoordinatorNeverAborted: bool = sys.coordAbortCount == 0

  val invKilledWorkerClean: bool =
    workers.keys().forall(w => {
      val wr = workers.get(w)
      wr.status == WKilled implies and {
        not(wr.hasActiveSession), not(wr.turnActive), not(wr.resuming), not(wr.waking),
        not(wr.abortRequestedBeforeSession),
        wr.steerQueue.length() == 0, wr.followUpQueue.length() == 0, wr.pendingDrainNext == ""
      }
    })

  val invStoppedWorkerClean: bool =
    workers.keys().forall(w => {
      val wr = workers.get(w)
      wr.status == WStopped implies and {
        not(wr.hasActiveSession), not(wr.turnActive),
        wr.steerQueue.length() == 0, wr.followUpQueue.length() == 0, wr.pendingDrainNext == ""
      }
    })

  val invWaitingWorkerNoStrandedQueue: bool =
    workers.keys().forall(w => {
      val wr = workers.get(w)
      (wr.status == WWaiting and not(wr.turnActive) and not(wr.lastTurnErrored) and wr.pendingDrainNext == "") implies and {
        wr.steerQueue.length() == 0, wr.followUpQueue.length() == 0
      }
    })

  val invModalAndAutocompleteDismissedOnKill: bool = match ui {
    | UiWorkerView(v) => {
        val isKilled = not(v.worker.in(workers.keys())) or workers.get(v.worker).status == WKilled
        isKilled implies and { v.modal == WModalNone, not(v.autocomplete), v.readOnly }
      }
    | _ => true
  }

  val invOverviewNeverSelectsPlaceholder: bool = match ui {
    | UiOverlay(o) => {
        val sel = selectableOverview(workers, sys.hasPlan, sys.planTasks)
        o.overviewSelected == "" or listContains(sel, o.overviewSelected)
      }
    | _ => true
  }

  val allInvariants: bool = and {
    invZeroBoardPostsFromDirectChat,
    invCoordinatorNeverAborted,
    invKilledWorkerClean,
    invStoppedWorkerClean,
    invWaitingWorkerNoStrandedQueue,
    invModalAndAutocompleteDismissedOnKill,
    invOverviewNeverSelectsPlaceholder,
  }

  // --- Deterministic & Adversarial Scenario Tests ---

  run directChatZeroBoardPostsAndQueueDrainTest =
    init
      .then(uiOpenOverlay(TabOverview))
      .then(uiOverlayEnterWorker)
      .then(uiWorkerSubmitChat(false, "steer-1"))
      .then(uiWorkerSubmitChat(true, "follow-1"))
      .expect(workers.get("w1").steerQueue == List("steer-1") and workers.get("w1").followUpQueue == List("follow-1") and sys.boardSeq == 1)
      .then(finishDirectQueue("w1", false, true))
      .then(finishDirectQueue("w1", true, true))
      .then(consumeQueuedMsg("w1"))
      .expect(workers.get("w1").steerQueue == List() and workers.get("w1").followUpQueue == List("follow-1"))
      .then(workerSettled("w1", false, false))
      .expect(workers.get("w1").pendingDrainNext == "follow-1")
      .then(runDrainMicrotask("w1"))
      .expect(workers.get("w1").status == WWorking and workers.get("w1").turnActive and sys.boardSeq == 1 and allInvariants)

  run stoppedAutoResumeAndAbortBeforeSessionTest =
    init
      .then(startDirectMessage("w2", false, "wake up"))
      .expect(workers.get("w2").status == WWorking and workers.get("w2").resuming and sys.boardSeq == 1)
      .then(abortWorkerByUser("w2"))
      .expect(workers.get("w2").abortRequestedBeforeSession)
      .then(finishDirectResume("w2", true))
      .expect(workers.get("w2").status == WWaiting and workers.get("w2").hasActiveSession and not(workers.get("w2").turnActive) and sys.boardSeq == 1 and allInvariants)

  run singleWorkerAbortIsolationTest =
    init
      .then(coordToggleTurn)
      .then(startDirectMessage("w2", false, "w2 task"))
      .then(finishDirectResume("w2", true))
      .then(abortWorkerByUser("w1"))
      .expect(sys.lastAbortedResult and workers.get("w1").status == WWaiting and workers.get("w1").abortCount == 1 and workers.get("w2").status == WWorking and sys.coordStatus == CWorking and sys.coordAbortCount == 0 and allInvariants)
      .then(abortWorkerByUser("w1"))
      .expect(not(sys.lastAbortedResult) and workers.get("w1").abortCount == 1 and allInvariants)

  run escPrecedenceAndShortcutsTest =
    init
      .then(uiOpenOverlay(TabWorkers))
      .then(uiOverlayEnterWorker)
      .then(uiWorkerSlashKill)
      .then(uiWorkerEsc)
      .expect(workers.get("w1").status == WWorking and workers.get("w1").abortCount == 0)
      .then(uiWorkerToggleAutocomplete(true))
      .then(uiWorkerEsc)
      .expect(workers.get("w1").status == WWorking and workers.get("w1").abortCount == 0)
      .then(uiWorkerCtrlD)
      .expect(ui == UiCoordinator and workers.get("w1").status == WWorking)
      .then(uiOpenOverlay(TabWorkers))
      .then(uiOverlayEnterWorker)
      .then(uiWorkerAltS)
      .expect(match ui { | UiOverlay(o) => o.tab == TabWorkers and workers.get("w1").status == WWorking | _ => false })
      .then(uiOverlayEnterWorker)
      .then(uiWorkerEsc)
      .expect(workers.get("w1").status == WWaiting and workers.get("w1").abortCount == 1)
      .then(uiWorkerEsc)
      .expect(ui == UiCoordinator and allInvariants)

  run slashCommandsAndKillReadOnlyTest =
    init
      .then(uiOpenOverlay(TabOverview))
      .then(uiOverlayEnterWorker)
      .then(uiWorkerSlashBoardOrUnknown)
      .expect(sys.boardSeq == 1)
      .then(uiWorkerSlashModel(false, "p/b"))
      .expect(workers.get("w1").model == "p/a")
      .then(uiWorkerSlashAbort)
      .then(uiWorkerSlashModel(false, "p/b"))
      .then(uiWorkerModelPickerSelect("p/b"))
      .then(finishSwitchModel("w1"))
      .expect(workers.get("w1").model == "p/b")
      .then(uiWorkerSlashKill)
      .then(uiWorkerConfirmKill(false))
      .expect(workers.get("w1").status == WWaiting)
      .then(uiWorkerSlashKill)
      .then(uiWorkerConfirmKill(true))
      .expect(workers.get("w1").status == WKilled and match ui { | UiWorkerView(v) => v.readOnly and v.modal == WModalNone and not(v.autocomplete) | _ => false } and allInvariants)

  run concurrentKillDuringModelSwitchAndQueueRollbackTest =
    init
      .then(startDirectMessage("w1", false, "bad-steer"))
      .then(finishDirectQueue("w1", false, false))
      .expect(workers.get("w1").steerQueue == List())
      .then(workerSettled("w1", false, false))
      .then(startSwitchModel("w1", "p/b"))
      .expect(workers.get("w1").inFlightSetModel == "p/b")
      .then(killWorkerByUser("w1"))
      .then(finishSwitchModel("w1"))
      .expect(workers.get("w1").status == WKilled and workers.get("w1").model == "p/a" and sys.lastDirectRejected and allInvariants)

  run externalKillDismissesUiAndOverviewSkipsPlaceholderTest =
    init
      .then(uiOpenOverlay(TabOverview))
      .then(uiOverlayEnterWorker)
      .then(uiWorkerToggleAutocomplete(true))
      .then(killWorkerByUser("w1"))
      .expect(match ui { | UiWorkerView(v) => v.readOnly and not(v.autocomplete) and v.modal == WModalNone | _ => false })
      .then(uiWorkerEsc)
      .then(uiOpenOverlay(TabOverview))
      .then(uiOverlayOverviewMove(1))
      .expect(match ui { | UiOverlay(o) => o.overviewSelected == "w2" | _ => false })
      .then(uiToggleEmptyOverviewPlan(true))
      .then(uiOverlayOverviewMove(1))
      .expect(match ui { | UiOverlay(o) => o.overviewSelected == "" and o.overviewScroll == 1 and allInvariants | _ => false })
}
