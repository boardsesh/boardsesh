using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.Lang;

// End-of-session summary, shown before Save/Discard: duration, sends, attempts,
// and problems from SessionLog. START -> the exit confirm (Save / Discard /
// Keep going); BACK -> back to the climb screen. A read-only surface — it does
// not stop the recording (ExitConfirm does).
class SessionSummaryView extends WatchUi.View {

    function initialize() {
        View.initialize();
    }

    function onLayout(dc as Graphics.Dc) as Void {
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        Theme.ensure(dc);
        dc.setColor(Theme.TEXT, Theme.BG);
        dc.clear();

        var cx = Theme.cx;
        var h = Theme.h;

        Theme.textC(dc, cx, h * 15 / 100, Theme.metaFont(), Theme.DIM,
            WatchUi.loadResource(Rez.Strings.SummaryTitle));

        // Elapsed time, prominent.
        Theme.textC(dc, cx, h * 30 / 100, Theme.gradeFont(), Theme.TEXT, _duration());

        // Stat rows: value + label, colour-coded.
        _stat(dc, cx, h * 48 / 100, SessionLog.sends(),
            WatchUi.loadResource(Rez.Strings.SummarySends), Theme.SEND);
        _stat(dc, cx, h * 60 / 100, SessionLog.attempts(),
            WatchUi.loadResource(Rez.Strings.SummaryAttempts), Theme.WARN);
        _stat(dc, cx, h * 72 / 100, SessionLog.problems(),
            WatchUi.loadResource(Rez.Strings.SummaryProblems), Theme.TEXT);

        Theme.textC(dc, cx, h * 88 / 100, Theme.metaFont(), Theme.DIM,
            WatchUi.loadResource(Rez.Strings.SummaryHint));
    }

    private function _stat(dc as Graphics.Dc, cx as Lang.Number, y as Lang.Number,
                           value as Lang.Number, label as Lang.String, color as Lang.Number) as Void {
        Theme.textC(dc, cx, y, Theme.metaFont(), color, value.toString() + "  " + label);
    }

    // Elapsed time as m:ss (frozen at the value when the summary opened).
    private function _duration() as Lang.String {
        var totalSec = Services.activity.elapsedMs() / 1000;
        var minutes = totalSec / 60;
        var seconds = totalSec % 60;
        var secStr = (seconds < 10) ? ("0" + seconds.toString()) : seconds.toString();
        return minutes.toString() + ":" + secStr;
    }
}

class SessionSummaryDelegate extends WatchUi.BehaviorDelegate {

    function initialize() {
        BehaviorDelegate.initialize();
    }

    // START = commit: open the Save / Discard / Keep-going confirm.
    function onSelect() as Lang.Boolean {
        WatchUi.pushView(Menus.buildExitConfirm(), new ExitConfirmDelegate(), WatchUi.SLIDE_UP);
        return true;
    }

    // BACK = back to the climb screen (keep recording).
    function onBack() as Lang.Boolean {
        WatchUi.popView(WatchUi.SLIDE_DOWN);
        return true;
    }
}
