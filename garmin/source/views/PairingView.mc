using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.System;
using Toybox.Lang;

// 8-character pairing-code entry.
//
// The code is minted in the Boardsesh phone/web app; the climber types it here.
// A char picker: UP/DOWN (or swipe) change the candidate character, START
// confirms it and advances, BACK deletes the last char (or exits when empty).
// Confirming the 8th character submits.
//
// This View owns the entry state + the submit call; PairingDelegate just
// forwards input events to it.
class PairingView extends WatchUi.View {

    // Exactly the 30-char alphabet the backend mints pairing codes from
    // (WATCH_PAIR_CODE_ALPHABET in native-auth.ts): uppercase A-Z minus the
    // ambiguous I/L/O/U, plus digits 2-9 (no 0/1). Matching it means the char
    // wheel only cycles through glyphs a real code can actually contain — faster,
    // unambiguous entry.
    const CHARSET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
    const CODE_LEN = 8;

    private var _entered as Lang.String;
    private var _index as Lang.Number;          // candidate index into CHARSET
    private var _submitting as Lang.Boolean;
    private var _error as Lang.Boolean;

    function initialize() {
        View.initialize();
        _entered = "";
        _index = 0;
        _submitting = false;
        _error = false;
    }

    function onLayout(dc as Graphics.Dc) as Void {
    }

    // ---- Input handlers (called by PairingDelegate) -------------------------

    function charUp() as Void {
        if (_submitting) { return; }
        _index = (_index + CHARSET.length() - 1) % CHARSET.length();
        WatchUi.requestUpdate();
    }

    function charDown() as Void {
        if (_submitting) { return; }
        _index = (_index + 1) % CHARSET.length();
        WatchUi.requestUpdate();
    }

    function confirm() as Void {
        if (_submitting) { return; }
        _error = false;
        _entered = _entered + _candidate();
        _index = 0;
        if (_entered.length() >= CODE_LEN) {
            _submit();
        }
        WatchUi.requestUpdate();
    }

    function deleteOrExit() as Void {
        if (_submitting) { return; }
        if (_entered.length() > 0) {
            _entered = _entered.substring(0, _entered.length() - 1);
            _error = false;
            WatchUi.requestUpdate();
        } else {
            System.exit();
        }
    }

    // ---- Submit -------------------------------------------------------------

    private function _submit() as Void {
        _submitting = true;
        Services.client.pair(_entered, method(:onPairResult));
    }

    function onPairResult(code as Lang.Number, data) as Void {
        if (code >= 200 && code < 300 && data != null && data["jwt"] != null) {
            TokenStore.store(data["jwt"], data["refreshToken"], data["expiresAt"]);
            // A fresh pairing may be a DIFFERENT account than the one whose ticks
            // are still queued locally (shared / re-paired watch). Drop them so
            // account A's ticks can't be flushed under account B's JWT, and clear
            // the per-climb log so account A's pips/summary don't bleed through.
            TickQueue.clear();
            SessionLog.reset();
            Router.toLoading();
            return;
        }
        // Invalid / expired code or a transport error: reset for another try.
        _submitting = false;
        _error = true;
        _entered = "";
        _index = 0;
        WatchUi.requestUpdate();
    }

    private function _candidate() as Lang.String {
        return CHARSET.substring(_index, _index + 1);
    }

    // ---- Rendering ----------------------------------------------------------

    function onUpdate(dc as Graphics.Dc) as Void {
        Theme.ensure(dc);
        dc.setColor(Theme.TEXT, Theme.BG);
        dc.clear();
        var cx = Theme.cx;
        var cy = Theme.cy;

        Theme.textC(dc, cx, cy - 52, Theme.metaFont(), Theme.DIM,
            WatchUi.loadResource(Rez.Strings.EnterCode));

        if (_submitting) {
            Theme.textC(dc, cx, cy, Theme.nameFont(), Theme.TEXT,
                WatchUi.loadResource(Rez.Strings.Pairing));
            return;
        }

        // Row: confirmed chars + the highlighted candidate + placeholders.
        var display = _entered;
        if (_entered.length() < CODE_LEN) {
            display = display + _candidate();
        }
        while (display.length() < CODE_LEN) {
            display = display + "_";
        }
        var codeY = cy - 6;
        // Alphanumeric font via Theme: the code contains letters, which
        // FONT_NUMBER_* would drop.
        Theme.gradeText(dc, cx, codeY, display, Theme.TEXT);
        _underlineCandidate(dc, display, cx, codeY);

        // Position indicator "n / 8".
        var filled = _entered.length();
        if (filled < CODE_LEN) { filled = filled + 1; }
        Theme.textC(dc, cx, cy + 34, Theme.metaFont(), Theme.DIM,
            filled.toString() + " / " + CODE_LEN.toString());

        if (_error) {
            Theme.textC(dc, cx, cy + 56, Theme.metaFont(), Theme.ERROR,
                WatchUi.loadResource(Rez.Strings.PairFailed));
        } else {
            Theme.textC(dc, cx, cy + 56, Theme.metaFont(), Theme.DIM,
                WatchUi.loadResource(Rez.Strings.GetCode));
        }
    }

    // A gold underline under the active candidate character (the one UP/DOWN
    // rotates), so the char picker reads as editable.
    private function _underlineCandidate(dc as Graphics.Dc, display as Lang.String,
                                         cx as Lang.Number, codeY as Lang.Number) as Void {
        var candIdx = _entered.length();
        if (candIdx >= CODE_LEN) {
            return;
        }
        var font = Theme.gradeFont();
        var fullW = dc.getTextWidthInPixels(display, font);
        var leftEdge = cx - fullW / 2;
        var prefixW = dc.getTextWidthInPixels(display.substring(0, candIdx), font);
        var candW = dc.getTextWidthInPixels(display.substring(candIdx, candIdx + 1), font);
        var y = codeY + dc.getFontHeight(font) / 2 + 2;
        dc.setColor(Theme.BENCH, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(3);
        dc.drawLine(leftEdge + prefixW, y, leftEdge + prefixW + candW, y);
        dc.setPenWidth(1);
    }
}

class PairingDelegate extends WatchUi.BehaviorDelegate {
    private var _view as PairingView;

    function initialize(view as PairingView) {
        BehaviorDelegate.initialize();
        _view = view;
    }

    function onPreviousPage() as Lang.Boolean {   // UP button
        _view.charUp();
        return true;
    }

    function onNextPage() as Lang.Boolean {        // DOWN button
        _view.charDown();
        return true;
    }

    function onSelect() as Lang.Boolean {          // START/ENTER
        _view.confirm();
        return true;
    }

    function onBack() as Lang.Boolean {            // BACK
        _view.deleteOrExit();
        return true;
    }

    // Touch devices: swipe up/down to change the candidate.
    function onSwipe(evt as WatchUi.SwipeEvent) as Lang.Boolean {
        var dir = evt.getDirection();
        if (dir == WatchUi.SWIPE_UP) {
            _view.charUp();
            return true;
        }
        if (dir == WatchUi.SWIPE_DOWN) {
            _view.charDown();
            return true;
        }
        return false;
    }
}
