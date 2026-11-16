using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.Lang;

// End-of-session summary, shown before Save/Discard: duration, sends, attempts,
// and problems from SessionLog, plus one line counting ticks kept on the watch
// (server-refused, or held from an older build) when there are any.
// START -> the exit confirm (Save / Discard /
// Keep going); BACK -> back to the climb screen. A read-only surface — it does
// not stop the recording (ExitConfirm does).
class SessionSummaryView extends WatchUi.View {
    // Ticks kept on the watch: [refused by the server, held from older builds,
    // refused store full].
    private var _kept as Lang.Array = [0, 0, false];

    function initialize() {
        View.initialize();
    }

    function onLayout(dc as Graphics.Dc) as Void {
    }

    // Read once per showing, not per frame: it reads two storage values.
    function onShow() as Void {
        _kept = TickQueue.surfaceCounts();
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        Theme.ensure(dc);
        dc.setColor(Theme.TEXT, Theme.BG);
        dc.clear();

        var cx = Theme.cx;
        var h = Theme.h;
        var notice = _keptNotice();
        // Tighten the rows only when the kept-ticks line needs the space.
        var rowTop = notice == null ? 48 : 44;
        var rowStep = notice == null ? 12 : 10;

        Theme.textC(dc, cx, h * 15 / 100, Theme.metaFont(), Theme.DIM,
            WatchUi.loadResource(Rez.Strings.SummaryTitle));

        // Elapsed time, prominent.
        Theme.textC(dc, cx, h * 30 / 100, Theme.gradeFont(), Theme.TEXT, _duration());

        // Stat rows: value + label, colour-coded.
        _stat(dc, cx, h * rowTop / 100, SessionLog.sends(),
            WatchUi.loadResource(Rez.Strings.SummarySends), Theme.SEND);
        _stat(dc, cx, h * (rowTop + rowStep) / 100, SessionLog.attempts(),
            WatchUi.loadResource(Rez.Strings.SummaryAttempts), Theme.WARN);
        _stat(dc, cx, h * (rowTop + rowStep * 2) / 100, SessionLog.problems(),
            WatchUi.loadResource(Rez.Strings.SummaryProblems), Theme.TEXT);
        if (notice != null) {
            Theme.textC(dc, cx, h * (rowTop + rowStep * 3) / 100, Theme.metaFont(), Theme.WARN, notice);
        }

        Theme.textC(dc, cx, h * 88 / 100, Theme.metaFont(), Theme.DIM,
            WatchUi.loadResource(Rez.Strings.SummaryHint));
    }

    private function _stat(dc as Graphics.Dc, cx as Lang.Number, y as Lang.Number,
                           value as Lang.Number, label as Lang.String, color as Lang.Number) as Void {
        Theme.textC(dc, cx, y, Theme.metaFont(), color, value.toString() + "  " + label);
    }

    // "2 refused  3 on hold", or "25 refused, full  3 on hold" once the refused
    // store is full (the next refusal then stays queued and stops the save).
    // Each part only when it applies; null when nothing does.
    private function _keptNotice() as Lang.String or Null {
        var refused = _kept[0];
        var held = _kept[1];
        var full = _kept[2];
        var parts = "";
        if (refused > 0 || full) {
            parts = refused.toString() + " " + WatchUi.loadResource(
                full ? Rez.Strings.SummaryRefusedFull : Rez.Strings.SummaryRefused);
        }
        if (held > 0) {
            if (parts.length() > 0) { parts = parts + "  "; }
            parts = parts + held.toString() + " " + WatchUi.loadResource(Rez.Strings.SummaryHeld);
        }
        return parts.length() > 0 ? parts : null;
    }

    // Elapsed time as m:ss at the most recent redraw.
    private function _duration() as Lang.String {
        var totalSec = Services.activity.elapsedMs() / 1000;
        var minutes = totalSec / 60;
        var seconds = totalSec % 60;
        var secStr = (seconds < 10) ? ("0" + seconds.toString()) : seconds.toString();
        return minutes.toString() + ":" + secStr;
    }
}

class SessionSummaryDelegate extends WatchUi.BehaviorDelegate {
    private var _context;

    function initialize() {
        BehaviorDelegate.initialize();
        _context = TokenStore.snapshot();
    }

    // START = commit: open the Save / Discard / Keep-going confirm.
    function onSelect() as Lang.Boolean {
        if (!TokenStore.current(_context)) { return true; }
        WatchUi.pushView(Menus.buildExitConfirm(), new ExitConfirmDelegate(), WatchUi.SLIDE_UP);
        return true;
    }

    // BACK = back to the climb screen (keep recording).
    function onBack() as Lang.Boolean {
        if (!TokenStore.current(_context)) { return true; }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
        return true;
    }
}
