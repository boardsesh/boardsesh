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
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        var cx = dc.getWidth() / 2;
        var cy = dc.getHeight() / 2;
        dc.drawText(cx, cy - 18, Graphics.FONT_MEDIUM,
            WatchUi.loadResource(Rez.Strings.AppName),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        dc.drawText(cx, cy + 18, Graphics.FONT_XTINY,
            WatchUi.loadResource(Rez.Strings.Loading),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
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
        AppState.sessionId = session["id"];
        AppState.sessionName = session["name"];
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
        System.exit();
        return true;
    }
}
