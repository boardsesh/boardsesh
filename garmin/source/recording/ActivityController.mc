using Toybox.ActivityRecording;
using Toybox.Activity;
using Toybox.Lang;

// Owns the FIT activity recording for a Boardsesh climbing session.
//
// Lifecycle: startIfNeeded() when ClimbView appears; lapOnSend() on a
// successful send/flash tick (NOT on attempts); stopAndSave()/stopAndDiscard()
// on exit.
//
// Deliberately DECOUPLED from tick saving: a saveTick failure must never touch
// the FIT, and vice versa. lapOnSend() is a best-effort no-op if recording
// isn't running.
class ActivityController {
    private var _session;                 // ActivityRecording.Session or Null
    private var _started as Lang.Boolean;

    function initialize() {
        _session = null;
        _started = false;
    }

    function isRecording() as Lang.Boolean {
        return _started;
    }

    function startIfNeeded() as Void {
        if (_started) {
            return;
        }
        // Some products/simulators may not expose recording; degrade quietly.
        if (!(Toybox has :ActivityRecording)) {
            return;
        }

        _session = ActivityRecording.createSession({
            :name => "Boardsesh",
            // FIT sport = rock_climbing. `SPORT_ROCK_CLIMBING` is long-standing in
            // Toybox.Activity. We intentionally omit `:subSport`: the bouldering
            // sub-sport constant isn't exposed on every SDK/API level, and an
            // undefined symbol fails the build even behind a runtime `has` guard
            // (guards gate runtime, not symbol resolution). If your SDK defines it,
            // add `:subSport => Activity.SUB_SPORT_BOULDERING` here.
            :sport => Activity.SPORT_ROCK_CLIMBING
        });
        _session.start();
        _started = true;
    }

    // Mark a lap for a completed send/flash.
    function lapOnSend() as Void {
        if (_started && _session != null) {
            _session.addLap();
        }
    }

    function stopAndSave() as Void {
        if (_started && _session != null) {
            _session.stop();
            _session.save();
        }
        _reset();
    }

    function stopAndDiscard() as Void {
        if (_started && _session != null) {
            _session.stop();
            _session.discard();
        }
        _reset();
    }

    private function _reset() as Void {
        _session = null;
        _started = false;
    }
}
