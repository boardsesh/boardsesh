using Toybox.WatchUi;
using Toybox.Lang;
using Toybox.Time;
using Toybox.Time.Gregorian;

// Menu2 builders. Kept separate from the delegates so the same menu can be
// opened from more than one place (e.g. ExitConfirm from both ClimbDelegate and
// SessionActionsDelegate). Construction only — no callbacks here.
//
// Logging is no longer a menu: it's one-press (START = send, BACK = attempt)
// handled directly in ClimbDelegate.
module Menus {

    function buildActionsMenu() as WatchUi.Menu2 {
        var menu = new WatchUi.Menu2({ :title => WatchUi.loadResource(Rez.Strings.ActionsTitle) });
        menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.ReSend), null, :resend, null));
        menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.SwitchSession), null, :switchSession, null));
        // Only when the signed-in owner has refused ticks to retry or delete,
        // or the store is full with other accounts' entries (the list then
        // offers deleting those, even when the owner has none).
        var counts = TickQueue.surfaceCounts();
        if (TickQueue.refusedMenuShown(counts)) {
            var refused = counts[0];
            var subLabel = refused.toString();
            if (refused == 0) { subLabel = othersSubLabel(counts[3]); }
            menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.RefusedTitle),
                subLabel, :refused, null));
        }
        menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.EndActivity), null, :end, null));
        return menu;
    }

    function buildExitConfirm() as WatchUi.Menu2 {
        var menu = new WatchUi.Menu2({ :title => WatchUi.loadResource(Rez.Strings.ExitTitle) });
        menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.Save), null, :save, null));
        menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.Discard), null, :discard, null));
        menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.KeepGoing), null, :keep, null));
        return menu;
    }

    // Retry all and Delete all (when the signed-in owner has entries), then
    // "Delete others' ticks" (only while the store is full and other accounts
    // hold entries: `othersCount` is 0 otherwise), then one read-only row per
    // refused tick of the owner, oldest first: what was logged and when, and
    // why the server refused it.
    function buildRefusedMenu(entries as Lang.Array, othersCount as Lang.Number) as WatchUi.Menu2 {
        var menu = new WatchUi.Menu2({ :title => WatchUi.loadResource(Rez.Strings.RefusedTitle) });
        if (entries.size() > 0) {
            menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.RefusedRetry), null, :retry, null));
            menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.RefusedDelete), null, :delete, null));
        }
        if (othersCount > 0) {
            menu.addItem(new WatchUi.MenuItem(WatchUi.loadResource(Rez.Strings.RefusedDeleteOthers),
                othersSubLabel(othersCount), :deleteOthers, null));
        }
        for (var index = 0; index < entries.size(); index += 1) {
            var entry = entries[index];
            menu.addItem(new WatchUi.MenuItem(refusedTitle(entry["tick"]), refusedReason(entry["reason"]),
                :entry, null));
        }
        return menu;
    }

    // "SENT 11/16 18:05" in the watch's local time, or the status alone when
    // climbedAt is not the exact form the app writes.
    function refusedTitle(tick) as Lang.String {
        var status = tick["status"];
        var word = WatchUi.loadResource(Rez.Strings.StatusSent) as Lang.String;
        if ("flash".equals(status)) { word = WatchUi.loadResource(Rez.Strings.StatusFlash) as Lang.String; }
        else if ("attempt".equals(status)) { word = WatchUi.loadResource(Rez.Strings.StatusAttempt) as Lang.String; }
        var seconds = TimeUtil.parseIsoUtc(tick["climbedAt"]);
        if (seconds == null) { return word; }
        var local = Gregorian.info(new Time.Moment(seconds.toNumber()), Time.FORMAT_SHORT);
        return word + " " + local.month.format("%d") + "/" + local.day.format("%d") + " " +
            local.hour.format("%02d") + ":" + local.min.format("%02d");
    }

    // "25 from other accounts"
    function othersSubLabel(count) as Lang.String {
        return count.toString() + " " + (WatchUi.loadResource(Rez.Strings.RefusedOthersCount) as Lang.String);
    }

    function refusedReason(reason) as Lang.String {
        if ("CLIMB_NOT_FOUND".equals(reason)) { return WatchUi.loadResource(Rez.Strings.RefusedClimbGone) as Lang.String; }
        if ("TICK_UUID_CONFLICT".equals(reason)) { return WatchUi.loadResource(Rez.Strings.RefusedConflict) as Lang.String; }
        if ("INVALID_INPUT".equals(reason)) { return WatchUi.loadResource(Rez.Strings.RefusedInvalid) as Lang.String; }
        if ("NULL_STATE_FIELD".equals(reason)) { return WatchUi.loadResource(Rez.Strings.RefusedMissingData) as Lang.String; }
        return WatchUi.loadResource(Rez.Strings.RefusedOther) as Lang.String;
    }
}
