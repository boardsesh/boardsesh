using Toybox.Timer;
using Toybox.System;
using Toybox.Lang;

// Foreground polling loop for /api/session/state.
//
// Owned by ClimbView: start() in onShow, stop() in onHide/onStop. Real-time
// control is foreground-only (Garmin = plain HTTPS via the phone, no WebSocket),
// so we poll every POLL_INTERVAL_MS while the view is up.
//
// Behaviour:
//   * skip a redraw when `sequence` is unchanged (nothing moved),
//   * exponential backoff on error (3 -> 6 -> 12 -> ... capped 30s), reset on
//     success,
//   * generation-gated callbacks so pre-navigation responses cannot win,
//   * authoritative post-navigation adoption before input is unblocked.
class PollController {
    private var _timer as Timer.Timer;
    private var _notify;                 // Method() -> redraw request
    private var _sessionId as Lang.String or Null;
    private var _intervalMs as Lang.Number;
    private var _lastSequence;           // Lang.Number or Null
    private var _running as Lang.Boolean;

    function initialize(notifyMethod) {
        _notify = notifyMethod;
        _timer = new Timer.Timer();
        _intervalMs = BuildConfig.POLL_INTERVAL_MS;
        _lastSequence = null;
        _running = false;
    }

    function start(sessionId as Lang.String) as Void {
        _sessionId = sessionId;
        _running = true;
        _intervalMs = BuildConfig.POLL_INTERVAL_MS;
        _tick();   // fetch immediately, then self-reschedule per response
    }

    function stop() as Void {
        _running = false;
        _timer.stop();
    }

    function _tick() as Void {
        if (!_running || _sessionId == null) {
            return;
        }
        // The navigate POST must be accepted before a GET can represent its
        // resulting climb. A direct refresh gets first chance; polling retries
        // it on the normal/backoff cadence if that request fails.
        if (AppState.navigationPending &&
                (!AppState.navigationAccepted || AppState.navigationRefreshInFlight)) {
            _arm();
            return;
        }
        if (AppState.navigationPending) {
            AppState.beginNavigationRefresh();
        }
        var response = new PollStateResponse(self, AppState.stateGeneration);
        Services.client.fetchState(_sessionId, response.method(:onResult));
    }

    private function _arm() as Void {
        if (!_running) {
            return;
        }
        // Non-repeating timer, re-armed each cycle so the interval can vary
        // with backoff.
        _timer.start(method(:_tick), _intervalMs, false);
    }

    // Exponential backoff on poll errors: double the interval, capped.
    // (3s -> 6s -> 12s -> 24s -> 30s). Reset to POLL_INTERVAL_MS on success.
    private function _backoff() as Void {
        var next = _intervalMs * 2;
        if (next > BuildConfig.POLL_BACKOFF_CAP_MS) {
            next = BuildConfig.POLL_BACKOFF_CAP_MS;
        }
        _intervalMs = next;
    }

    function onStateForGeneration(generation as Lang.Number, code as Lang.Number, data) as Void {
        if (!_running) {
            // A late response after stop() (view hidden): ignore it.
            return;
        }
        if (!AppState.acceptsStateGeneration(generation)) {
            // The response was requested for the climb shown before a navigation
            // or session switch. It must not replace the authoritative refresh.
            _arm();
            return;
        }
        if (AppState.navigationPending) {
            AppState.endNavigationRefresh();
        }
        if (code == 401) {
            // BsClient owns token refresh + routing. If a refresh FAILED it
            // routes to pairing and ClimbView.onHide() stops us (so a late 401
            // is caught by the _running guard above). If we're still running,
            // the retry was simply exhausted — keep polling at the normal
            // cadence so the next cycle triggers a fresh refresh attempt rather
            // than soft-locking the loop.
            _arm();
            return;
        }
        if (code == 410) {
            // Session ended upstream.
            _running = false;
            Router.toNoSession();
            return;
        }
        if (code < 200 || code >= 300 || data == null) {
            AppState.online = false;
            _backoff();
            _arm();
            _notify.invoke();   // redraw to surface the offline banner
            return;
        }

        var wasOnline = AppState.online;
        AppState.online = true;
        _intervalMs = BuildConfig.POLL_INTERVAL_MS;   // reset backoff

        var changed = false;
        if (AppState.navigationPending) {
            AppState.completeNavigation(data);
            _lastSequence = data["sequence"];
            changed = true;
        } else {
            changed = _reconcile(data);
        }
        _arm();
        if (PollLogic.shouldNotify(changed, wasOnline)) {
            _notify.invoke();
        }
    }

    // Adopt the polled state, honouring the optimistic-nav window. Returns
    // whether the visible state changed (so we should redraw).
    private function _reconcile(newState as Lang.Dictionary) as Lang.Boolean {
        var now = System.getTimer();
        var polledIndex = newState["currentIndex"];
        if (polledIndex == null) { polledIndex = 0; }

        var accept = AppState.acceptPollIndex(
            AppState.optimisticUntilMs, AppState.optimisticIndex, polledIndex, now
        );
        if (accept) {
            AppState.clearOptimistic();
        } else {
            // Keep our optimistic index; the rest of the payload is still fresh.
            newState["currentIndex"] = AppState.optimisticIndex;
        }

        var newSeq = newState["sequence"];
        var seqChanged = (_lastSequence == null) || (newSeq == null) || !_seqEquals(newSeq, _lastSequence);
        _lastSequence = newSeq;

        AppState.state = newState;

        // Redraw if the sequence moved OR we just overrode the index (so the
        // i/N counter reflects the optimistic move even on a stale sequence).
        return seqChanged || !accept;
    }

    private function _seqEquals(a, b) as Lang.Boolean {
        return a == b;
    }
}

module PollLogic {
    // PURE: returning online removes the offline banner even if the session
    // sequence and climb payload did not change.
    function shouldNotify(stateChanged as Lang.Boolean, wasOnline as Lang.Boolean) as Lang.Boolean {
        return stateChanged || !wasOnline;
    }
}

// One object per request captures the generation at dispatch time. Bound method
// callbacks otherwise carry no request context in Monkey C.
class PollStateResponse {
    private var _controller as PollController;
    private var _generation as Lang.Number;

    function initialize(controller as PollController, generation as Lang.Number) {
        _controller = controller;
        _generation = generation;
    }

    function onResult(code as Lang.Number, data) as Void {
        _controller.onStateForGeneration(_generation, code, data);
    }
}
