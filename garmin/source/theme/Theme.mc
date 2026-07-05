using Toybox.Graphics;
using Toybox.System;
using Toybox.WatchUi;
using Toybox.Math;
using Toybox.Lang;

// Central visual system: palette, cached device capabilities, and font choices.
// The one place colors and fonts are decided, so individual views stop
// hardcoding Graphics.COLOR_* and font constants.
//
// Device capabilities (screen shape, AMOLED burn-in, touch) are read ONCE and
// cached; the drawable size (w/h/cx/cy) refreshes from the Dc on every ensure()
// call because the drawable region is authoritative.
//
// NOTE on the grade/pairing-code font: we deliberately use an ALPHANUMERIC
// built-in font (FONT_LARGE / FONT_MEDIUM), never FONT_NUMBER_*. The number
// fonts are numerals-only and drop the letters and slash in grades like
// "7a/V6". Vector fonts (Graphics.getVectorFont) would scale nicer but are
// @since API 4.2.1 — above this app's minApiLevel 3.2.0 — so they can't be used
// without dropping older target devices.
module Theme {
    // ---- palette (all Graphics.COLOR_* are Numbers) ----------------------
    var BG    as Lang.Number = Graphics.COLOR_BLACK;
    var TEXT  as Lang.Number = Graphics.COLOR_WHITE;
    var DIM   as Lang.Number = Graphics.COLOR_LT_GRAY;
    var SEND  as Lang.Number = Graphics.COLOR_GREEN;    // sends / flashes
    var BENCH as Lang.Number = Graphics.COLOR_YELLOW;   // benchmark (gold)
    var WARN  as Lang.Number = Graphics.COLOR_ORANGE;   // offline / attempt pips
    var ERROR as Lang.Number = Graphics.COLOR_RED;      // pairing failure

    // ---- cached device caps + per-draw dims ------------------------------
    var w as Lang.Number = 260;
    var h as Lang.Number = 260;
    var cx as Lang.Number = 130;
    var cy as Lang.Number = 130;
    var round as Lang.Boolean = true;
    var amoled as Lang.Boolean = false;
    var touch as Lang.Boolean = false;
    var _capsRead as Lang.Boolean = false;

    // Call at the top of every onUpdate before using the helpers below.
    function ensure(dc as Graphics.Dc) as Void {
        w = dc.getWidth();
        h = dc.getHeight();
        cx = w / 2;
        cy = h / 2;
        if (_capsRead) {
            return;
        }
        var settings = System.getDeviceSettings();
        round  = (settings.screenShape == System.SCREEN_SHAPE_ROUND);
        amoled = settings.requiresBurnInProtection;
        touch  = settings.isTouchScreen;
        _capsRead = true;
    }

    // Big text (grade / pairing code): light-gray on AMOLED for battery +
    // burn-in headroom; white on MIP/transflective for sunlight legibility.
    function gradeColor() as Lang.Number {
        return amoled ? DIM : TEXT;
    }

    // ---- font choices (step down one tier on small/MIP screens) ----------
    function gradeFont() as Graphics.FontDefinition {
        return (w < 320) ? Graphics.FONT_MEDIUM : Graphics.FONT_LARGE;
    }

    function nameFont() as Graphics.FontDefinition {
        return (w < 320) ? Graphics.FONT_XTINY : Graphics.FONT_SMALL;
    }

    function metaFont() as Graphics.FontDefinition {
        return Graphics.FONT_XTINY;
    }

    // Draw a large ALPHANUMERIC string (grade / code), center-justified at (x,y).
    function gradeText(dc as Graphics.Dc, x as Lang.Number, y as Lang.Number,
                       text as Lang.String, color as Lang.Number) as Void {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x, y, gradeFont(), text,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    // ---- shared draw helpers ---------------------------------------------

    const ELLIPSIS = "...";

    // Center-justified text in `color` at (x,y).
    function textC(dc as Graphics.Dc, x as Lang.Number, y as Lang.Number,
                   font as Graphics.FontDefinition, color as Lang.Number, text as Lang.String) as Void {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x, y, font, text,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    // A single centered message (loading / empty states).
    function centerMsg(dc as Graphics.Dc, text as Lang.String) as Void {
        textC(dc, cx, cy, nameFont(), TEXT, text);
    }

    function tw(dc as Graphics.Dc, text as Lang.String, font as Graphics.FontDefinition) as Lang.Number {
        return dc.getTextWidthInPixels(text, font);
    }

    // Truncate `text` with an ellipsis so it fits within maxW at `font`.
    function clip(dc as Graphics.Dc, text as Lang.String, font as Graphics.FontDefinition, maxW as Lang.Number) as Lang.String {
        if (dc.getTextWidthInPixels(text, font) <= maxW) {
            return text;
        }
        var shortened = text;
        while (shortened.length() > 1 &&
               dc.getTextWidthInPixels(shortened + ELLIPSIS, font) > maxW) {
            shortened = shortened.substring(0, shortened.length() - 1);
        }
        return shortened + ELLIPSIS;
    }

    // "i / N" position counter, near the bottom.
    function counter(dc as Graphics.Dc, pos as Lang.Number, total as Lang.Number) as Void {
        textC(dc, cx, h * 87 / 100, metaFont(), DIM, pos.toString() + " / " + total.toString());
    }

    // OFFLINE banner near the top (caller decides when to draw it).
    function offlineBanner(dc as Graphics.Dc) as Void {
        textC(dc, cx, h * 14 / 100, metaFont(), WARN, WatchUi.loadResource(Rez.Strings.Offline));
    }

    // A filled 5-point star (benchmark marker).
    function star(dc as Graphics.Dc, x as Lang.Number, y as Lang.Number, r as Lang.Number, color as Lang.Number) as Void {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        var points = [] as Lang.Array;
        for (var i = 0; i < 10; i += 1) {
            var radius = (i % 2 == 0) ? r.toFloat() : r.toFloat() * 0.42;
            var angle = -Math.PI / 2.0 + i * Math.PI / 5.0;   // start at the top
            points.add([ x + radius * Math.cos(angle), y + radius * Math.sin(angle) ]);
        }
        dc.fillPolygon(points);
    }

    // Up to 5 filled dots (attempt pips), centered at (x,y).
    function pips(dc as Graphics.Dc, x as Lang.Number, y as Lang.Number, count as Lang.Number, color as Lang.Number) as Void {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        var shown = (count > 5) ? 5 : count;
        var gap = w * 4 / 100;
        var dot = w * 12 / 1000;   // ~1.2% of width
        if (dot < 2) { dot = 2; }
        var startX = x - (shown - 1) * gap / 2;
        for (var i = 0; i < shown; i += 1) {
            dc.fillCircle(startX + i * gap, y, dot);
        }
    }

    // Whether the bottom progress arc should render (round + AMOLED + hi-res).
    function showArc() as Lang.Boolean {
        return round && amoled && w >= 390;
    }

    // A short bottom arc showing queue position: a dim track with a bright fill.
    function progressArc(dc as Graphics.Dc, pos as Lang.Number, total as Lang.Number) as Void {
        if (total <= 0) {
            return;
        }
        var radius = w / 2 - 6;
        var startDeg = 240;   // lower-left; sweeps CCW through 270 (bottom) to 300
        var endDeg = 300;
        dc.setPenWidth(4);
        dc.setColor(DIM, Graphics.COLOR_TRANSPARENT);
        dc.drawArc(cx, cy, radius, Graphics.ARC_COUNTER_CLOCKWISE, startDeg, endDeg);

        var frac = pos.toFloat() / total.toFloat();
        if (frac > 1.0) { frac = 1.0; }
        if (frac < 0.0) { frac = 0.0; }
        var fillEnd = startDeg + ((endDeg - startDeg) * frac).toNumber();
        if (fillEnd > startDeg) {
            dc.setColor(TEXT, Graphics.COLOR_TRANSPARENT);
            dc.drawArc(cx, cy, radius, Graphics.ARC_COUNTER_CLOCKWISE, startDeg, fillEnd);
        }
        dc.setPenWidth(1);
    }
}
