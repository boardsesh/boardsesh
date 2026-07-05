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
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();

        var cx = dc.getWidth() / 2;
        var cy = dc.getHeight() / 2;

        var state = AppState.state;
        if (state == null) {
            dc.drawText(cx, cy, Graphics.FONT_SMALL,
                WatchUi.loadResource(Rez.Strings.Loading),
                Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            _drawOfflineBanner(dc, cx);
            return;
        }

        var climb = state["climb"];
        if (climb == null) {
            dc.drawText(cx, cy, Graphics.FONT_SMALL,
                WatchUi.loadResource(Rez.Strings.EmptyQueue),
                Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
            _drawCounter(dc, cx, dc.getHeight());
            _drawOfflineBanner(dc, cx);
            return;
        }

        // Climb name (top-centre).
        var name = climb["name"];
        if (name == null) { name = WatchUi.loadResource(Rez.Strings.UnknownClimb); }
        dc.drawText(cx, cy - 46, Graphics.FONT_SMALL, name,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        // Grade (large, centre).
        dc.drawText(cx, cy, Graphics.FONT_NUMBER_MEDIUM, _gradeText(climb),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        // Angle + optional mirror flag (below grade).
        var meta = _angleText(state);
        if (climb["mirrored"] == true) {
            meta = meta + "  " + WatchUi.loadResource(Rez.Strings.Mirror);
        }
        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, cy + 42, Graphics.FONT_XTINY, meta,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        _drawCounter(dc, cx, dc.getHeight());
        _drawOfflineBanner(dc, cx);
    }

    // "i / N" position counter near the bottom.
    private function _drawCounter(dc as Graphics.Dc, cx as Lang.Number, height as Lang.Number) as Void {
        var pos = (AppState.currentIndex() + 1).toString() + " / " + AppState.queueLength().toString();
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, height - 26, Graphics.FONT_XTINY, pos,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    private function _drawOfflineBanner(dc as Graphics.Dc, cx as Lang.Number) as Void {
        if (AppState.online) {
            return;
        }
        dc.setColor(Graphics.COLOR_YELLOW, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, 18, Graphics.FONT_XTINY,
            WatchUi.loadResource(Rez.Strings.Offline),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
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
    private var _view as ClimbView;

    function initialize(view as ClimbView) {
        BehaviorDelegate.initialize();
        _view = view;
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

    // START = log a tick.
    function onSelect() as Lang.Boolean {
        WatchUi.pushView(Menus.buildLogMenu(), new LogTickDelegate(_view), WatchUi.SLIDE_UP);
        return true;
    }

    // MENU / long-press = session actions.
    function onMenu() as Lang.Boolean {
        WatchUi.pushView(Menus.buildActionsMenu(), new SessionActionsDelegate(_view), WatchUi.SLIDE_UP);
        return true;
    }

    // BACK = confirm exit.
    function onBack() as Lang.Boolean {
        WatchUi.pushView(Menus.buildExitConfirm(), new ExitConfirmDelegate(_view), WatchUi.SLIDE_UP);
        return true;
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
            return;   // at a boundary; nothing to do
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
