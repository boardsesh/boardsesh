using Toybox.WatchUi;
using Toybox.Lang;

// Handles ONE logged tick's async save result. One instance per press, so rapid
// one-press logs never clobber a shared field. The instance stays alive until
// the saveTick callback fires (the bound Method retains it — the same pattern as
// TickFlusher).
//
// The FIT lap, haptics, and counters are applied by the CALLER on press
// (optimistic, decoupled from the network); this class only reacts to the save
// outcome via the SAME classifier the offline flusher uses:
//   * :success -> already celebrated on press; nothing to do.
//   * :retry   -> offline / 5xx / 429: queue the tick for a later flush.
//   * :drop    -> a permanent 4xx / GraphQL rejection: surface the failure.
class TickLogger {
    private var _input as Lang.Dictionary;

    function initialize(input as Lang.Dictionary) {
        _input = input;
    }

    function submit() as Void {
        Services.client.saveTick(_input, method(:onResult));
    }

    function onResult(code as Lang.Number, data) as Void {
        var outcome = TickQueue.classifyFlushResult(code, data != null);
        if (outcome == :retry) {
            TickQueue.enqueue(_input);
            Feedback.offlineQueued();
            Toast.show(WatchUi.loadResource(Rez.Strings.QueuedOffline));
        } else if (outcome == :drop) {
            Feedback.error();
            Toast.show(WatchUi.loadResource(Rez.Strings.LogFailed));
        }
    }
}
