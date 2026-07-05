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
    private var _view as ClimbView;
    private var _flusher as TickFlusher or Null;

    function initialize(view as ClimbView) {
        Menu2InputDelegate.initialize();
        _view = view;
        _flusher = null;
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        var id = item.getId();

        if (id == :keep) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            return;
        }

        if (id == :save) {
            _view.activity().stopAndSave();
        } else if (id == :discard) {
            _view.activity().stopAndDiscard();
        }

        // Drain any queued offline ticks, then exit.
        _flusher = new TickFlusher(Services.client);
        _flusher.start(method(:onFlushed));
    }

    function onFlushed() as Void {
        System.exit();
    }

    function onBack() as Void {
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}
