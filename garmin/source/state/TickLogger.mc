using Toybox.WatchUi;
using Toybox.Lang;

// Handles ONE logged tick's async save result. One instance per press, so rapid
// one-press logs never clobber a shared field. The instance stays alive until
// the saveTick callback fires (the bound Method retains it — the same pattern as
// TickFlusher).
//
// The FIT lap, haptics, and counters are applied by the CALLER on press
// (optimistic, decoupled from the network); this class only reacts to the save
// outcome via the SAME classifier the offline flusher uses. submit() persists
// first, so a crash or exit between request and callback cannot lose the tick:
//   * :success -> remove its uuid from the outbox.
//   * :retry   -> leave it queued for a later flush.
//   * :drop    -> remove it and surface the permanent rejection.
class TickLogger {
    private var _input as Lang.Dictionary;

    function initialize(input as Lang.Dictionary) {
        _input = input;
    }

    function submit() as Void {
        TickQueue.enqueue(_input);
        Services.client.saveTick(_input, method(:onResult));
    }

    function onResult(code as Lang.Number, data) as Void {
        var outcome = TickQueue.classifyFlushResult(code, data != null);
        if (outcome == :retry) {
            Feedback.offlineQueued();
            Toast.show(WatchUi.loadResource(Rez.Strings.QueuedOffline));
        } else {
            var tickUuid = _input["uuid"];
            if (tickUuid instanceof Lang.String) {
                TickQueue.removeUuid(tickUuid);
            }
        }
        if (outcome == :drop) {
            Feedback.error();
            Toast.show(WatchUi.loadResource(Rez.Strings.LogFailed));
        }
    }
}
