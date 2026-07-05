using Toybox.WatchUi;

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
}
