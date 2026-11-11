using Toybox.WatchUi;
using Toybox.Lang;

// Handles the session-actions menu:
//   * Re-send to board  -> POST /api/session/take-control (repaints the board)
//   * Switch session    -> re-query mySessions and show the picker
//   * End activity      -> ExitConfirm
class SessionActionsDelegate extends WatchUi.Menu2InputDelegate {
    private var _context;

    function initialize() {
        Menu2InputDelegate.initialize();
        _context = TokenStore.snapshot();
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        if (!TokenStore.current(_context)) { return; }
        var id = item.getId();

        if (id == :resend) {
            if (AppState.sessionId != null) {
                Services.client.takeControl(AppState.sessionId, method(:onResend));
            }
            WatchUi.popView(WatchUi.SLIDE_DOWN);

        } else if (id == :switchSession) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            Services.client.fetchMySessions(method(:onSessions));

        } else if (id == :end) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            // Show the session summary first; START there opens Save/Discard.
            WatchUi.pushView(new SessionSummaryView(), new SessionSummaryDelegate(), WatchUi.SLIDE_UP);
        }
    }

    function onResend(code as Lang.Number, data, origin) as Void {
        if (code == BsResponse.STALE || !TokenStore.current(origin)) { return; }
        if (code >= 200 && code < 300) {
            Toast.show(WatchUi.loadResource(Rez.Strings.Resent));
        } else {
            Toast.show(WatchUi.loadResource(Rez.Strings.NavFailed));
        }
    }

    function onSessions(code as Lang.Number, data, origin) as Void {
        if (code == BsResponse.STALE || !TokenStore.current(origin)) { return; }
        if (code == 401) {
            return;
        }
        if (code < 200 || code >= 300 || data == null) {
            Router.toNoSession();
            return;
        }
        AppState.authContext = origin;
        var active = AppState.activeSessions(data);
        if (active.size() == 0) {
            Router.toNoSession();
        } else {
            // Always show the picker for an explicit switch, even with one.
            Router.toSessionPicker(active);
        }
    }

    function onBack() as Void {
        if (!TokenStore.current(_context)) { return; }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}
