using Toybox.WatchUi;
using Toybox.Lang;

// Menu2 list of active sessions (used when more than one is active, or for an
// explicit "Switch session"). Selecting one attaches it and opens ClimbView.
//
// Each MenuItem's identifier is the session's index into the backing array, so
// the delegate can look the full session dict back up.
class SessionPickerView extends WatchUi.Menu2 {
    private var _sessions as Lang.Array;

    function initialize(sessions as Lang.Array) {
        Menu2.initialize({ :title => WatchUi.loadResource(Rez.Strings.PickSession) });
        _sessions = sessions;
        for (var i = 0; i < sessions.size(); i += 1) {
            var session = sessions[i];
            var subLabel = session["boardPath"];
            addItem(new WatchUi.MenuItem(session["name"], subLabel, i, null));
        }
    }

    function sessionAt(index as Lang.Number) as Lang.Dictionary {
        return _sessions[index];
    }
}

class SessionPickerDelegate extends WatchUi.Menu2InputDelegate {
    private var _view as SessionPickerView;

    function initialize(view as SessionPickerView) {
        Menu2InputDelegate.initialize();
        _view = view;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var session = _view.sessionAt(item.getId());
        AppState.sessionId = session["id"];
        AppState.sessionName = session["name"];
        Router.toClimb();
    }

    function onBack() as Void {
        // Back out of the picker to the splash (which re-resolves).
        Router.toLoading();
    }
}
