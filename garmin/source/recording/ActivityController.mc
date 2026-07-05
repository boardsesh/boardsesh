using Toybox.ActivityRecording;
using Toybox.Activity;
using Toybox.FitContributor;
using Toybox.System;
using Toybox.Lang;

// FIT sub_sport = bouldering. Activity.SUB_SPORT_BOULDERING (== 69) only resolves
// on SDK/API 4.1.6+, and an undefined symbol fails the BUILD even behind a `has`
// guard (guards gate runtime, not symbol resolution) at our minApiLevel 3.2.0.
// A numeric literal always compiles and writes the same FIT sub_sport byte, which
// Garmin Connect maps to "Bouldering" server-side — so every target device gets
// the right activity type with no per-product conditionals and no dropped devices.
const SUBSPORT_BOULDERING = 69;

// Owns the FIT activity recording for a Boardsesh climbing session.
//
// Lifecycle: startIfNeeded() when ClimbView appears; recordAttempt(...) on every
// logged attempt/send/flash (one FIT lap each, carrying grade/result/attempt/
// angle developer fields); stopAndSave()/stopAndDiscard() on exit, writing the
// session-summary developer fields (sends/attempts/problems) from SessionLog.
//
// Deliberately DECOUPLED from tick saving: a saveTick failure must never touch
// the FIT, and vice versa. recordAttempt() is a best-effort no-op if recording
// isn't running, and every developer-field call is null-guarded so the app
// degrades cleanly to plain laps when FitContributor is unavailable.
class ActivityController {
    private var _session;                 // ActivityRecording.Session or Null
    private var _started as Lang.Boolean;
    private var _startMs as Lang.Number;
    private var _hasFit as Lang.Boolean;
    // LAP-scope developer fields (one row per logged effort in Garmin Connect).
    private var _fGrade;
    private var _fResult;
    private var _fAttempt;
    private var _fAngle;
    // SESSION-scope developer fields (activity summary).
    private var _fSends;
    private var _fAttempts;
    private var _fProblems;

    function initialize() {
        _session = null;
        _started = false;
        _startMs = 0;
        _hasFit = false;
        _clearFields();
    }

    function isRecording() as Lang.Boolean {
        return _started;
    }

    function elapsedMs() as Lang.Number {
        if (!_started) {
            return 0;
        }
        return System.getTimer() - _startMs;
    }

    function startIfNeeded() as Void {
        if (_started) {
            return;
        }
        // Some products/simulators may not expose recording; degrade quietly.
        if (!(Toybox has :ActivityRecording)) {
            return;
        }

        // A new recording is a fresh session: clear the per-climb log so its
        // lifetime matches the FIT activity (see AppState.attachSession). Done
        // here, gated by the _started guard above, so it runs once per recording
        // and never wipes the log when ClimbView is merely re-shown.
        SessionLog.reset();

        _session = ActivityRecording.createSession({
            :name => "Boardsesh",
            :sport => Activity.SPORT_ROCK_CLIMBING,
            // The :subSport option is typed Activity.SubSport; assert our numeric
            // literal to that type. The *type* resolves at 3.2.0 even though the
            // SUB_SPORT_BOULDERING *constant* does not (see the note above).
            :subSport => (SUBSPORT_BOULDERING as Activity.SubSport)
        });

        _createFitFields();

        _session.start();
        _startMs = System.getTimer();
        _started = true;
        Feedback.sessionStart();
    }

    private function _createFitFields() as Void {
        _hasFit = (Toybox has :FitContributor) && (_session has :createField);
        if (!_hasFit) {
            return;
        }
        _fGrade   = _session.createField("grade",   0, FitContributor.DATA_TYPE_STRING,
                        { :mesgType => FitContributor.MESG_TYPE_LAP, :count => 8 });
        _fResult  = _session.createField("result",  1, FitContributor.DATA_TYPE_UINT8,
                        { :mesgType => FitContributor.MESG_TYPE_LAP });
        _fAttempt = _session.createField("attempt", 2, FitContributor.DATA_TYPE_UINT8,
                        { :mesgType => FitContributor.MESG_TYPE_LAP });
        _fAngle   = _session.createField("angle",   3, FitContributor.DATA_TYPE_UINT8,
                        { :mesgType => FitContributor.MESG_TYPE_LAP, :units => "deg" });
        _fSends    = _session.createField("sends",    10, FitContributor.DATA_TYPE_UINT16,
                        { :mesgType => FitContributor.MESG_TYPE_SESSION });
        _fAttempts = _session.createField("attempts", 11, FitContributor.DATA_TYPE_UINT16,
                        { :mesgType => FitContributor.MESG_TYPE_SESSION });
        _fProblems = _session.createField("problems", 12, FitContributor.DATA_TYPE_UINT16,
                        { :mesgType => FitContributor.MESG_TYPE_SESSION });
    }

    // Record ONE logged attempt/send/flash as a FIT lap. Sets the LAP developer
    // fields for this effort, THEN closes the lap so the values attach to it.
    // Called on press, decoupled from tick-save success. `status` is
    // "attempt" | "send" | "flash".
    function recordAttempt(status as Lang.String, gradeLabel as Lang.String or Null,
                           angle as Lang.Object or Null, attemptNum as Lang.Number) as Void {
        if (!_started || _session == null) {
            return;
        }
        if (_hasFit) {
            if (_fGrade != null && gradeLabel != null) { _fGrade.setData(_truncate8(gradeLabel)); }
            if (_fResult != null) { _fResult.setData(_statusCode(status)); }
            if (_fAttempt != null) { _fAttempt.setData(_clampByte(attemptNum)); }
            // `angle` is a raw dict value; only write it if it's actually numeric
            // (the `as Lang.Number` is compile-time only and wouldn't convert a
            // stray String, which would then crash the clamp arithmetic).
            if (_fAngle != null && angle instanceof Lang.Number) { _fAngle.setData(_clampByte(angle)); }
        }
        _session.addLap();
    }

    function stopAndSave() as Void {
        if (_started && _session != null) {
            _writeSessionFields();
            _session.stop();
            _session.save();
            Feedback.sessionStop();
        }
        _reset();
    }

    function stopAndDiscard() as Void {
        if (_started && _session != null) {
            _session.stop();
            _session.discard();
            Feedback.sessionStop();
        }
        _reset();
    }

    private function _writeSessionFields() as Void {
        if (!_hasFit) {
            return;
        }
        if (_fSends != null)    { _fSends.setData(_clampU16(SessionLog.sends())); }
        if (_fAttempts != null) { _fAttempts.setData(_clampU16(SessionLog.attempts())); }
        if (_fProblems != null) { _fProblems.setData(_clampU16(SessionLog.problems())); }
    }

    private function _statusCode(status as Lang.String) as Lang.Number {
        if (status.equals("flash")) { return 2; }
        if (status.equals("send")) { return 1; }
        return 0;
    }

    private function _clampByte(n as Lang.Number) as Lang.Number {
        if (n < 0) { return 0; }
        if (n > 255) { return 255; }
        return n;
    }

    private function _clampU16(n as Lang.Number) as Lang.Number {
        if (n < 0) { return 0; }
        if (n > 65535) { return 65535; }
        return n;
    }

    private function _truncate8(text as Lang.String) as Lang.String {
        return (text.length() > 8) ? text.substring(0, 8) : text;
    }

    private function _clearFields() as Void {
        _fGrade = null;
        _fResult = null;
        _fAttempt = null;
        _fAngle = null;
        _fSends = null;
        _fAttempts = null;
        _fProblems = null;
    }

    private function _reset() as Void {
        _session = null;
        _started = false;
        _startMs = 0;
        _hasFit = false;
        _clearFields();
    }
}
