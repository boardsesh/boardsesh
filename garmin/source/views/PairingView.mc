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
            // account A's ticks can't be flushed under account B's JWT.
            TickQueue.clear();
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
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();
        var cx = dc.getWidth() / 2;
        var cy = dc.getHeight() / 2;

        dc.drawText(cx, cy - 52, Graphics.FONT_XTINY,
            WatchUi.loadResource(Rez.Strings.EnterCode),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        if (_submitting) {
            dc.drawText(cx, cy, Graphics.FONT_MEDIUM,
                WatchUi.loadResource(Rez.Strings.Pairing),
                Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
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
        dc.drawText(cx, cy - 6, Graphics.FONT_NUMBER_MEDIUM, display,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        // Position indicator "n / 8".
        var filled = _entered.length();
        if (filled < CODE_LEN) { filled = filled + 1; }
        dc.drawText(cx, cy + 34, Graphics.FONT_XTINY,
            filled.toString() + " / " + CODE_LEN.toString(),
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        if (_error) {
            dc.setColor(Graphics.COLOR_RED, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, cy + 56, Graphics.FONT_XTINY,
                WatchUi.loadResource(Rez.Strings.PairFailed),
                Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        } else {
            dc.setColor(Graphics.COLOR_LT_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, cy + 56, Graphics.FONT_XTINY,
                WatchUi.loadResource(Rez.Strings.GetCode),
                Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
        }
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
