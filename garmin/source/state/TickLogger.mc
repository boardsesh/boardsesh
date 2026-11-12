using Toybox.WatchUi;
using Toybox.Lang;

// One durable tick, one owner/scope, one exact request lease.
class TickLogger {
    private var _input;
    private var _context;
    private var _lease = null;
    function initialize(input) { _input = input; _context = TokenStore.snapshot(); }

    // Caller must check acceptance BEFORE FIT, counters or success feedback.
    function submit() as Lang.Boolean {
        if (!TickQueue.enqueue(_input, _context)) { return false; }
        _lease = TickQueue.acquire(_context, _input["uuid"]);
        if (_lease != null) { Services.client.saveTick(_input, method(:onResult)); }
        return true;
    }
    function onResult(code as Lang.Number, response, origin) as Void {
        var completed = _lease;
        _lease = null;
        if (!TickQueue.release(completed)) { return; }
        if (!AuthState.sameScope(_context, origin) || !TickQueue.activeContext(_context)) { return; }
        if (TickQueue.exactAck(code, response, _input["uuid"]) && TickQueue.acknowledge(_context, _input["uuid"])) { return; }
        Feedback.offlineQueued();
        Toast.show(WatchUi.loadResource(Rez.Strings.QueuedOffline));
    }
}
