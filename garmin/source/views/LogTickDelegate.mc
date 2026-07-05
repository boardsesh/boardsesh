using Toybox.WatchUi;
using Toybox.Lang;

// Handles the Log menu (Attempt / Send / Flash / Cancel).
//
// On select it builds a SaveTickInput (climbedAt captured NOW) and saves it.
// The result is routed through the SAME classifier the offline flusher uses
// (TickQueue.classifyFlushResult): :success marks a FIT lap on a send/flash,
// :retry queues the tick for a later flush, and :drop (a permanent 4xx / GraphQL
// rejection) surfaces a real failure without queuing a poison tick. The menu is
// popped immediately after firing so the save proceeds in the background — this
// delegate stays alive because the saveTick callback Method retains it.
class LogTickDelegate extends WatchUi.Menu2InputDelegate {
    private var _view as ClimbView;
    private var _pendingStatus as Lang.String;
    private var _pendingInput as Lang.Dictionary or Null;

    function initialize(view as ClimbView) {
        Menu2InputDelegate.initialize();
        _view = view;
        _pendingStatus = "";
        _pendingInput = null;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId();
        if (id == :cancel) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            return;
        }

        var state = AppState.state;
        if (state == null || state["climb"] == null || AppState.sessionId == null) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            return;
        }

        var status = "attempt";
        var attemptCount = 1;
        if (id == :send) {
            status = "send";
        } else if (id == :flash) {
            status = "flash";
            attemptCount = 1;   // flash => one attempt
        }

        var iso = TimeUtil.nowIso();
        _pendingStatus = status;
        _pendingInput = BsEndpoints.saveTickInput(state, AppState.sessionId, status, attemptCount, iso);

        Services.client.saveTick(_pendingInput, method(:onSaveResult));
        WatchUi.popView(WatchUi.SLIDE_DOWN);   // back to ClimbView; save runs async
    }

    function onSaveResult(code as Lang.Number, data) as Void {
        var outcome = TickQueue.classifyFlushResult(code, data != null);
        if (outcome == :success) {
            if (_pendingStatus.equals("send") || _pendingStatus.equals("flash")) {
                Services.activity.lapOnSend();
            }
            Toast.show(WatchUi.loadResource(Rez.Strings.Logged));
        } else if (outcome == :retry) {
            // Retryable (offline / 5xx / 429): keep it for a later flush.
            if (_pendingInput != null) {
                TickQueue.enqueue(_pendingInput);
            }
            Toast.show(WatchUi.loadResource(Rez.Strings.QueuedOffline));
        } else {
            // :drop — a permanent rejection (4xx or a GraphQL error). Queuing it
            // would only get it dropped at flush time, so surface the failure.
            Toast.show(WatchUi.loadResource(Rez.Strings.LogFailed));
        }
    }

    function onBack() as Void {
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}
