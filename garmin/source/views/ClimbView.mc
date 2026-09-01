using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.System;
using Toybox.Lang;

// Main screen: the current climb + queue position, with an offline banner.
//
// Owns the PollController (foreground polling). FIT recording lives in the
// process-wide Services.activity singleton (started idempotently on show, kept
// running across view transitions). Inputs are handled by ClimbDelegate.
class ClimbView extends WatchUi.View {
    private var _poller as PollController;

    function initialize() {
        View.initialize();
        _poller = new PollController(method(:onStateChanged));
    }

    function onLayout(dc as Graphics.Dc) as Void {
    }

    function onShow() as Void {
        // Idempotent: the singleton's _started guard prevents a second recording
        // when ClimbView is re-entered (switch session / 410 -> retry).
        Services.activity.startIfNeeded();
        _poller.start(AppState.sessionId);
    }

    function onHide() as Void {
        // Only the poll loop stops here; the recording keeps running across view
        // transitions and is only stopped on a real exit.
        _poller.stop();
    }

    // Invoked by PollController when the visible state changed.
    function onStateChanged() as Void {
        WatchUi.requestUpdate();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        Theme.ensure(dc);
        dc.setColor(Theme.TEXT, Theme.BG);
        dc.clear();

        var state = AppState.state;
        if (state == null) {
            Theme.centerMsg(dc, WatchUi.loadResource(Rez.Strings.Loading));
            _offline(dc);
            return;
        }

        var climb = state["climb"];
        if (climb == null) {
            Theme.centerMsg(dc, WatchUi.loadResource(Rez.Strings.EmptyQueue));
            Theme.counter(dc, AppState.currentIndex() + 1, AppState.queueLength());
            _offline(dc);
            return;
        }

        var w = Theme.w;
        var h = Theme.h;
        var cx = Theme.cx;
        var uuid = climb["climbUuid"];

        // ---- name row: [star] name [MIR] ----
        var rawName = climb["name"];
        var name = (rawName == null)
            ? WatchUi.loadResource(Rez.Strings.UnknownClimb).toString()
            : rawName.toString();
        name = Theme.clip(dc, name, Theme.nameFont(), w * 68 / 100);
        var nameY = h * 30 / 100;
        Theme.textC(dc, cx, nameY, Theme.nameFont(), Theme.TEXT, name);
        var halfName = Theme.tw(dc, name, Theme.nameFont()) / 2;
        if (climb["isBenchmark"] == true) {
            Theme.star(dc, cx - halfName - w * 5 / 100, nameY, w * 3 / 100, Theme.BENCH);
        }
        if (climb["mirrored"] == true) {
            Theme.textC(dc, cx + halfName + w * 6 / 100, nameY, Theme.metaFont(), Theme.DIM,
                WatchUi.loadResource(Rez.Strings.MirrorShort));
        }

        // ---- grade (dominant; turns green once sent this session) ----
        var gradeColor = SessionLog.isSent(uuid) ? Theme.SEND : Theme.gradeColor();
        Theme.gradeText(dc, cx, h * 49 / 100, _gradeText(climb), gradeColor);

        // ---- angle ----
        var angle = _angleText(state);
        if (!angle.equals("")) {
            Theme.textC(dc, cx, h * 66 / 100, Theme.metaFont(), Theme.DIM, angle);
        }

        // ---- status line: SENT / FLASH / attempt pips ----
        _drawStatus(dc, uuid, h * 77 / 100);

        // ---- counter (+ optional progress arc) ----
        Theme.counter(dc, AppState.currentIndex() + 1, AppState.queueLength());
        if (Theme.showArc()) {
            Theme.progressArc(dc, AppState.currentIndex() + 1, AppState.queueLength());
        }
        _offline(dc);
    }

    private function _offline(dc as Graphics.Dc) as Void {
        if (!AppState.online) {
            Theme.offlineBanner(dc);
        }
    }

    // Glanceable log state for the current climb: SENT / FLASH once sent, else
    // attempt pips (or "xN" past five), drawn from SessionLog.
    private function _drawStatus(dc as Graphics.Dc, uuid as Lang.Object or Null, y as Lang.Number) as Void {
        if (SessionLog.isSent(uuid)) {
            var label = SessionLog.isFlash(uuid)
                ? WatchUi.loadResource(Rez.Strings.StatusFlash)
                : WatchUi.loadResource(Rez.Strings.StatusSent);
            Theme.textC(dc, Theme.cx, y, Theme.metaFont(), Theme.SEND, label);
            return;
        }
        var attempts = SessionLog.attemptsFor(uuid);
        if (attempts <= 0) {
            return;
        }
        if (attempts <= 5) {
            Theme.pips(dc, Theme.cx, y, attempts, Theme.WARN);
        } else {
            Theme.textC(dc, Theme.cx, y, Theme.metaFont(), Theme.WARN, "x" + attempts.toString());
        }
    }

    // climb["difficulty"] is already a display grade string (e.g. "V4" / "6c"):
    // the backend Climb resolver labels it via getGradeLabel(displayDifficulty)
    // before it ever reaches the queue/state payload, so we render it verbatim.
    private function _gradeText(climb as Lang.Dictionary) as Lang.String {
        var difficulty = climb["difficulty"];
        if (difficulty == null) {
            return "--";
        }
        return difficulty.toString();
    }

    private function _angleText(state as Lang.Dictionary) as Lang.String {
        var angle = state["angle"];
        if (angle == null) {
            return "";
        }
        return angle.toString() + WatchUi.loadResource(Rez.Strings.DegreeSuffix);
    }
}

class ClimbDelegate extends WatchUi.BehaviorDelegate {
    // Per-verb debounce timestamps (ms). BACK=attempt is a twitchy button;
    // guard against accidental double-logs.
    private var _lastAttemptMs as Lang.Number = 0;
    private var _lastSendMs as Lang.Number = 0;

    function initialize() {
        BehaviorDelegate.initialize();
    }

    // UP button / swipe-up = previous.
    function onPreviousPage() as Lang.Boolean {
        _navigate("previous");
        return true;
    }

    // DOWN button / swipe-down = next.
    function onNextPage() as Lang.Boolean {
        _navigate("next");
        return true;
    }

    function onSwipe(evt as WatchUi.SwipeEvent) as Lang.Boolean {
        var dir = evt.getDirection();
        if (dir == WatchUi.SWIPE_UP) {
            _navigate("previous");
            return true;
        }
        if (dir == WatchUi.SWIPE_DOWN) {
            _navigate("next");
            return true;
        }
        return false;
    }

    // START = log a SEND (one press, celebrated). First go with no prior
    // attempts this session logs a FLASH; otherwise a SEND carrying the real
    // cumulative attempt count.
    function onSelect() as Lang.Boolean {
        _log("send");
        return true;
    }

    // MENU / long-press = session actions (Re-send / Switch / End).
    function onMenu() as Lang.Boolean {
        WatchUi.pushView(Menus.buildActionsMenu(), new SessionActionsDelegate(), WatchUi.SLIDE_UP);
        return true;
    }

    // BACK / LAP = log an ATTEMPT (+1). Mirrors the native "mark a lap" reflex;
    // ending the activity moves to MENU -> Session -> End.
    function onBack() as Lang.Boolean {
        _log("attempt");
        return true;
    }

    // One-press logging. The FIT lap (added in Phase 4), haptics, and counters
    // are applied optimistically here on press — decoupled from the network,
    // like navigation. TickLogger reacts to the async save result (offline
    // queue on a retryable failure, a toast on a permanent rejection).
    private function _log(kind as Lang.String) as Void {
        var state = AppState.state;
        if (state == null || state["climb"] == null || AppState.sessionId == null) {
            Feedback.boundary();   // nothing to log
            return;
        }

        // Per-verb debounce. Treat a negative delta (a System.getTimer() wrap,
        // ~24.8 days) as "elapsed" so a wrap can't soft-lock the verb.
        var now = System.getTimer();
        if (kind.equals("attempt")) {
            var sinceAttempt = now - _lastAttemptMs;
            if (sinceAttempt >= 0 && sinceAttempt < 600) { return; }
            _lastAttemptMs = now;
        } else {
            var sinceSend = now - _lastSendMs;
            if (sinceSend >= 0 && sinceSend < 600) { return; }
            _lastSendMs = now;
        }

        var climb = state["climb"];
        var uuid = climb["climbUuid"];
        var gradeVal = climb["difficulty"];
        var gradeLabel = (gradeVal == null) ? null : gradeVal.toString();

        var status = "attempt";
        if (kind.equals("attempt")) {
            SessionLog.incAttempt(uuid);
            Feedback.attempt();
        } else {
            var flashEligible = SessionLog.isFlashEligible(uuid);
            if (flashEligible) {
                status = "flash";
                Feedback.flash();
            } else {
                status = "send";
                Feedback.send();
            }
            SessionLog.markSend(uuid, flashEligible, gradeLabel);
            // Optimistic celebration over ClimbView; it auto-dismisses.
            var shown = (gradeLabel == null) ? "" : gradeLabel;
            var successView = new SendSuccessView(shown, flashEligible);
            WatchUi.pushView(successView, new SendSuccessDelegate(successView), WatchUi.SLIDE_UP);
        }

        // FIT lap for this effort (decoupled from the network save). The lap's
        // attempt number is the cumulative count on this climb: the post-increment
        // count for an attempt, or attempts-so-far + 1 for a send/flash.
        var attemptNum = kind.equals("attempt")
            ? SessionLog.attemptsFor(uuid)
            : SessionLog.attemptsFor(uuid) + 1;
        Services.activity.recordAttempt(status, gradeLabel, state["angle"], attemptNum);

        // Each tick carries attemptCount = 1 (one logged effort). The per-climb
        // effort total lives in SessionLog + the FIT lap fields; keeping the tick
        // at 1 preserves the existing backend saveTick contract (each attempt/send
        // press is its own tick, exactly as the previous log menu sent them).
        var input = BsEndpoints.saveTickInput(
            state, AppState.sessionId, status, 1, TimeUtil.nowIso());
        new TickLogger(input).submit();
        WatchUi.requestUpdate();
    }

    private function _navigate(action as Lang.String) as Void {
        var state = AppState.state;
        if (state == null || AppState.sessionId == null) {
            return;
        }

        var qlen = AppState.queueLength();
        var idx = AppState.currentIndex();
        var newIndex = action.equals("next") ? (idx + 1) : (idx - 1);

        if (newIndex < 0) { newIndex = 0; }
        if (qlen > 0 && newIndex > qlen - 1) { newIndex = qlen - 1; }
        if (newIndex == idx) {
            Feedback.boundary();   // at a queue boundary; acknowledge the press
            return;
        }

        AppState.beginOptimistic(newIndex, System.getTimer());
        WatchUi.requestUpdate();
        Services.client.navigate(AppState.sessionId, action, method(:onNavResult));
    }

    function onNavResult(code as Lang.Number, data) as Void {
        if (code == 401) {
            return;   // BsClient is refreshing / routing
        }
        if (code == 410) {
            Toast.show(WatchUi.loadResource(Rez.Strings.SessionEnded));
            Router.toNoSession();
            return;
        }
        if (code >= 200 && code < 300) {
            return;   // accepted; the next poll reconciles the authoritative index
        }
        // 403 / 409 / 429 / 5xx: drop the optimism and let the server win.
        AppState.clearOptimistic();
        Toast.show(WatchUi.loadResource(Rez.Strings.NavFailed));
        WatchUi.requestUpdate();
    }
}
