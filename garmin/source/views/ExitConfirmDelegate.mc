using Toybox.WatchUi;
using Toybox.System;
using Toybox.Lang;

// Handles the exit-confirmation menu:
//   * Save       -> stop + save the FIT, flush queued ticks, exit
//   * Discard    -> stop + discard the FIT, flush queued ticks, exit
//   * Keep going -> dismiss
//
// ClimbView is the root view, so leaving it exits the app. We flush any pending
// ticks first (best-effort) and exit when the flush settles.
class ExitConfirmDelegate extends WatchUi.Menu2InputDelegate {
    private var _flusher as TickFlusher or Null;
    // Set once we start the async flush. Blocks a second Save/Discard (which
    // would spawn a duplicate TickFlusher — double saveTick + double popFront)
    // and a Back-out while the app is on its way to exiting.
    private var _submitting as Lang.Boolean;

    function initialize() {
        Menu2InputDelegate.initialize();
        _flusher = null;
        _submitting = false;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        if (_submitting) {
            return;   // a flush is already running; ignore repeat selects
        }

        var id = item.getId();

        if (id == :keep) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            return;
        }

        if (id == :save) {
            Services.activity.stopAndSave();
        } else if (id == :discard) {
            Services.activity.stopAndDiscard();
        }

        // Drain any queued offline ticks, then exit.
        _submitting = true;
        _flusher = new TickFlusher(Services.client);
        _flusher.start(method(:onFlushed));
    }

    function onFlushed() as Void {
        System.exit();
    }

    function onBack() as Void {
        if (_submitting) {
            return;   // committing/exiting; swallow the back press
        }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}
