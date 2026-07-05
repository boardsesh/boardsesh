using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.System;
using Toybox.Lang;

// Transient splash. On show it queries the active sessions and routes:
//   * 0 active   -> NoSessionView
//   * 1 active   -> attach + ClimbView (auto-skip the picker)
//   * >1 active  -> SessionPickerView
class LoadingView extends WatchUi.View {

    function initialize() {
        View.initialize();
    }

    function onLayout(dc as Graphics.Dc) as Void {
    }

    function onShow() as Void {
        Services.client.fetchMySessions(method(:onSessions));
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        Theme.ensure(dc);
        dc.setColor(Theme.TEXT, Theme.BG);
        dc.clear();
        var cx = Theme.cx;
        var cy = Theme.cy;
        Theme.textC(dc, cx, cy - 18, Theme.nameFont(), Theme.TEXT,
            WatchUi.loadResource(Rez.Strings.AppName));
        Theme.textC(dc, cx, cy + 18, Theme.metaFont(), Theme.DIM,
            WatchUi.loadResource(Rez.Strings.Loading));
    }

    function onSessions(code as Lang.Number, data) as Void {
        if (code == 401) {
            // BsClient is refreshing / routing to pairing.
            return;
        }
        if (code < 200 || code >= 300 || data == null) {
            // Treat any error as "no session"; NoSessionView offers Retry.
            Router.toNoSession();
            return;
        }

        var active = _activeSessions(data);
        if (active.size() == 0) {
            Router.toNoSession();
        } else if (active.size() == 1) {
            _attach(active[0]);
            Router.toClimb();
        } else {
            Router.toSessionPicker(active);
        }
    }

    private function _attach(session as Lang.Dictionary) as Void {
        AppState.attachSession(session["id"], session["name"]);
    }

    // Filter mySessions to isActive == true.
    private function _activeSessions(sessions as Lang.Array) as Lang.Array {
        var out = [];
        for (var i = 0; i < sessions.size(); i += 1) {
            var session = sessions[i];
            if (session != null && session["isActive"] == true) {
                out.add(session);
            }
        }
        return out;
    }
}

class LoadingDelegate extends WatchUi.BehaviorDelegate {
    function initialize() {
        BehaviorDelegate.initialize();
    }

    function onBack() as Lang.Boolean {
        // System.exit() does not return, so no `return` follows (it'd be dead code).
        System.exit();
    }
}
