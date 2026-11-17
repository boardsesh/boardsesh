using Toybox.WatchUi;
using Toybox.Lang;

// The refused-ticks list (Session menu -> Refused ticks), signed-in owner only:
//   * Retry all  -> moves the refused ticks back to the end of the outbox,
//                   same UUIDs, and starts a drain. A tick the server refuses
//                   again comes back to this list; one it already saved is
//                   answered with the stored tick, never saved twice.
//   * Delete all -> asks first, then drops them. They are not in the logbook.
//   * Delete others' ticks -> only while the store is full: asks first, then
//                   drops other accounts' refused ticks (#7636 decision 2).
//                   The owner's entries and every queued tick stay.
//   * an entry   -> nothing; the rows are for reading.
class RefusedTicksDelegate extends WatchUi.Menu2InputDelegate {
    private var _context;

    function initialize() {
        Menu2InputDelegate.initialize();
        _context = TokenStore.snapshot();
    }

    function onSelect(item as WatchUi.MenuItem) as Void {
        if (!TokenStore.current(_context)) { return; }
        var id = item.getId();
        if (id == :retry) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            if (TickQueue.retryRefused(_context) > 0) {
                // The drain is kept alive by its request callbacks; nothing
                // waits on it. Leases keep a later exit drain from sending
                // the same UUID twice.
                new TickFlusher(Services.client).start(null);
                Toast.show(WatchUi.loadResource(Rez.Strings.RefusedRetrying) as Lang.String);
            } else {
                Toast.show(WatchUi.loadResource(Rez.Strings.RefusedRetryFailed) as Lang.String);
            }
        } else if (id == :delete) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            WatchUi.pushView(
                new WatchUi.Confirmation(WatchUi.loadResource(Rez.Strings.RefusedDeleteConfirm) as Lang.String),
                new RefusedDeleteConfirmDelegate(_context),
                WatchUi.SLIDE_UP
            );
        } else if (id == :deleteOthers) {
            WatchUi.popView(WatchUi.SLIDE_DOWN);
            WatchUi.pushView(
                new WatchUi.Confirmation(WatchUi.loadResource(Rez.Strings.RefusedDeleteOthersConfirm) as Lang.String),
                new RefusedDeleteOthersConfirmDelegate(_context),
                WatchUi.SLIDE_UP
            );
        }
    }

    function onBack() as Void {
        if (!TokenStore.current(_context)) { return; }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}

// Yes deletes the signed-in owner's refused ticks; No keeps them.
class RefusedDeleteConfirmDelegate extends WatchUi.ConfirmationDelegate {
    private var _context;

    function initialize(context) {
        ConfirmationDelegate.initialize();
        _context = context;
    }

    function onResponse(response as WatchUi.Confirm) as Lang.Boolean {
        if (response == WatchUi.CONFIRM_YES && TokenStore.current(_context) &&
                TickQueue.clearRefused(_context) > 0) {
            Toast.show(WatchUi.loadResource(Rez.Strings.RefusedDeleted) as Lang.String);
        }
        return true;
    }
}

// Yes deletes other accounts' refused ticks, and only while the store is full
// (TickQueue re-checks at press time); No keeps them. The signed-in owner's
// entries and every account's queued ticks are never touched.
class RefusedDeleteOthersConfirmDelegate extends WatchUi.ConfirmationDelegate {
    private var _context;

    function initialize(context) {
        ConfirmationDelegate.initialize();
        _context = context;
    }

    function onResponse(response as WatchUi.Confirm) as Lang.Boolean {
        if (response == WatchUi.CONFIRM_YES && TokenStore.current(_context) &&
                TickQueue.clearOtherOwnersRefused(_context) > 0) {
            Toast.show(WatchUi.loadResource(Rez.Strings.RefusedOthersDeleted) as Lang.String);
        }
        return true;
    }
}
