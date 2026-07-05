using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.System;
using Toybox.Lang;

// Shown when there is no active Boardsesh session to attach to.
// START = retry (re-query mySessions via LoadingView); BACK = exit.
class NoSessionView extends WatchUi.View {

    function initialize() {
        View.initialize();
    }

    function onLayout(dc as Graphics.Dc) as Void {
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        var cx = dc.getWidth() / 2;
        var cy = dc.getHeight() / 2;

        dc.drawText(cx, cy - 40, Graphics.FONT_SMALL,
            WatchUi.loadResource(Rez.Strings.NoSessionTitle),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, cy - 2, Graphics.FONT_XTINY,
            WatchUi.loadResource(Rez.Strings.StartOnPhone),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, dc.getHeight() - 30, Graphics.FONT_XTINY,
            WatchUi.loadResource(Rez.Strings.Retry),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }
}

class NoSessionDelegate extends WatchUi.BehaviorDelegate {
    function initialize() {
        BehaviorDelegate.initialize();
    }

    function onSelect() as Lang.Boolean {   // START -> retry
        Router.toLoading();
        return true;
    }

    function onBack() as Lang.Boolean {     // BACK -> exit
        // System.exit() does not return, so no `return` follows (it'd be dead code).
        System.exit();
    }
}
