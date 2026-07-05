using Toybox.Lang;

// One climb's log state for the current session.
class ClimbLogEntry {
    var attempts as Lang.Number;
    var sent as Lang.Boolean;
    var flash as Lang.Boolean;

    function initialize() {
        attempts = 0;
        sent = false;
        flash = false;
    }
}

// In-memory record of what the climber has logged during the CURRENT session,
// keyed by climbUuid. The single source of truth for:
//   * the climb-screen badge (attempt pips / send check),
//   * the real attemptCount that flows into a saved tick,
//   * the FIT SESSION summary + the end-of-session summary screen.
//
// Reset when a DIFFERENT session is attached (LoadingView / SessionPicker). Not
// persisted — a session's per-climb log is meaningful only while it's live.
// Keying by climbUuid means navigating away and back PRESERVES the count.
module SessionLog {
    var _byClimb as Lang.Dictionary = {};
    var _sends as Lang.Number = 0;         // sends + flashes (distinct climbs)
    var _attempts as Lang.Number = 0;      // attempt-only logs (falls/tries)
    var _problems as Lang.Number = 0;      // distinct climbs logged
    var _lastSendGrade as Lang.String or Null = null;

    function reset() as Void {
        _byClimb = {};
        _sends = 0;
        _attempts = 0;
        _problems = 0;
        _lastSendGrade = null;
    }

    // Get-or-create the entry for a climb; creating one counts a new problem.
    // `uuid` is the opaque climbUuid straight from the state dict (used only as a
    // key + null-checked), so it's typed permissively as Object.
    function _entry(uuid as Lang.Object) as ClimbLogEntry {
        var existing = _byClimb[uuid];
        if (existing == null) {
            var fresh = new ClimbLogEntry();
            _byClimb[uuid] = fresh;
            _problems += 1;
            return fresh;
        }
        return existing as ClimbLogEntry;
    }

    function attemptsFor(uuid as Lang.Object or Null) as Lang.Number {
        if (uuid == null) { return 0; }
        var existing = _byClimb[uuid];
        if (existing == null) { return 0; }
        return (existing as ClimbLogEntry).attempts;
    }

    function isSent(uuid as Lang.Object or Null) as Lang.Boolean {
        if (uuid == null) { return false; }
        var existing = _byClimb[uuid];
        if (existing == null) { return false; }
        return (existing as ClimbLogEntry).sent;
    }

    function isFlash(uuid as Lang.Object or Null) as Lang.Boolean {
        if (uuid == null) { return false; }
        var existing = _byClimb[uuid];
        if (existing == null) { return false; }
        return (existing as ClimbLogEntry).flash;
    }

    // A send counts as a flash only when it's the FIRST thing logged on this
    // climb this session (no prior attempts, not already sent).
    function isFlashEligible(uuid as Lang.Object or Null) as Lang.Boolean {
        if (uuid == null) { return false; }
        var existing = _byClimb[uuid];
        if (existing == null) { return true; }
        var entry = existing as ClimbLogEntry;
        return entry.attempts == 0 && !entry.sent;
    }

    function incAttempt(uuid as Lang.Object or Null) as Void {
        if (uuid == null) { return; }
        var entry = _entry(uuid);
        entry.attempts = entry.attempts + 1;
        _attempts += 1;
    }

    // Record a send/flash. `grade` is the display label (for the summary).
    function markSend(uuid as Lang.Object or Null, flash as Lang.Boolean, grade as Lang.String or Null) as Void {
        if (uuid == null) { return; }
        var entry = _entry(uuid);
        if (!entry.sent) {
            _sends += 1;   // count a climb's first send only
        }
        entry.sent = true;
        if (flash) { entry.flash = true; }
        if (grade != null) { _lastSendGrade = grade; }
    }

    function sends() as Lang.Number { return _sends; }
    function attempts() as Lang.Number { return _attempts; }
    function problems() as Lang.Number { return _problems; }
    function lastSendGrade() as Lang.String or Null { return _lastSendGrade; }
}
