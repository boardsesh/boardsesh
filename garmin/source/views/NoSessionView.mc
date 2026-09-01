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
        Theme.ensure(dc);
        dc.setColor(Theme.TEXT, Theme.BG);
        dc.clear();
        var cx = Theme.cx;
        var h = Theme.h;
        var w = Theme.w;

        // A little board glyph up top.
        _drawBoard(dc, cx, h * 26 / 100, w * 16 / 100);

        Theme.textC(dc, cx, h * 50 / 100, Theme.nameFont(), Theme.TEXT,
            WatchUi.loadResource(Rez.Strings.NoSessionTitle));
        Theme.textC(dc, cx, h * 62 / 100, Theme.metaFont(), Theme.DIM,
            WatchUi.loadResource(Rez.Strings.StartOnPhone));

        // Retry, styled as a button pill (press START).
        _drawPill(dc, cx, h * 80 / 100, WatchUi.loadResource(Rez.Strings.Retry));
    }

    // A rounded board outline with a few coloured holds — a geometric mark, no
    // bitmap, so it scales cleanly on every screen.
    private function _drawBoard(dc as Graphics.Dc, cx as Lang.Number, cy as Lang.Number, size as Lang.Number) as Void {
        var half = size / 2;
        dc.setColor(Theme.DIM, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(3);
        dc.drawRoundedRectangle(cx - half, cy - half, size, size, size / 6);
        dc.setPenWidth(1);
        var dot = size / 12;
        if (dot < 2) { dot = 2; }
        dc.setColor(Theme.SEND, Graphics.COLOR_TRANSPARENT);
        dc.fillCircle(cx - size * 20 / 100, cy - size * 15 / 100, dot);
        dc.setColor(Theme.BENCH, Graphics.COLOR_TRANSPARENT);
        dc.fillCircle(cx + size * 15 / 100, cy + size * 5 / 100, dot);
        dc.setColor(Theme.WARN, Graphics.COLOR_TRANSPARENT);
        dc.fillCircle(cx - size * 5 / 100, cy + size * 22 / 100, dot);
    }

    private function _drawPill(dc as Graphics.Dc, cx as Lang.Number, cy as Lang.Number, text as Lang.String) as Void {
        var font = Theme.metaFont();
        var textW = dc.getTextWidthInPixels(text, font);
        var padX = Theme.w * 6 / 100;
        var padY = Theme.h * 3 / 100;
        var pillW = textW + padX * 2;
        var pillH = dc.getFontHeight(font) + padY * 2;
        dc.setColor(Theme.DIM, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(2);
        dc.drawRoundedRectangle(cx - pillW / 2, cy - pillH / 2, pillW, pillH, pillH / 2);
        dc.setPenWidth(1);
        Theme.textC(dc, cx, cy, font, Theme.TEXT, text);
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
