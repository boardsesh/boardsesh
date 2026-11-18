using Toybox.WatchUi;
using Toybox.Lang;

// The refused-ticks list (Session menu -> Refused ticks), signed-in owner only:
//   * Retry all  -> moves the refused ticks back to the end of the outbox,
//                   same UUIDs, and starts a drain. A tick the server refuses
//                   again comes back to this list; one it already saved is
//                   answered with the stored tick, never saved twice.
//   * Delete all -> asks first, then drops them. They are not in the logbook.
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
