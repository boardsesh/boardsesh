using Toybox.Attention;
using Toybox.Lang;

// Differentiated haptic + tone feedback for logging + session events.
//
// Haptics carry the critical confirmation (a loud gym mutes tones); tones are a
// bonus. Every call is capability-gated (`Attention has :vibrate` / `:playTone`)
// so devices/simulators without a vibrator or speaker degrade to a silent
// no-op. VibeProfile is constructed INSIDE the guard so a no-vibrator device
// never touches the symbol (mirrors the proven pattern in Toast.mc).
module Feedback {

    // `pairs` is an Array of [dutyCyclePercent, durationMs] pairs (≤8).
    function _vibe(pairs as Lang.Array<Lang.Array<Lang.Number>>) as Void {
        if (Attention has :vibrate) {
            var profiles = [] as Lang.Array<Attention.VibeProfile>;
            for (var i = 0; i < pairs.size(); i += 1) {
                var p = pairs[i];
                profiles.add(new Attention.VibeProfile(p[0], p[1]));
            }
            Attention.vibrate(profiles);
        }
    }

    function _tone(tone as Attention.Tone) as Void {
        if (Attention has :playTone) {
            Attention.playTone(tone);
        }
    }

    // One crisp punch — the frequent "logged an attempt" tick. Silent (no tone)
    // so repeated attempts don't fatigue in a quiet gym.
    function attempt() as Void {
        _vibe([ [100, 90] ]);
    }

    // Rising triple ending in a long buzz + success tone — a logged send.
    function send() as Void {
        _vibe([ [60, 120], [0, 70], [80, 150], [0, 70], [100, 320] ]);
        _tone(Attention.TONE_SUCCESS);
    }

    // Even more emphatic than a send — a flash (first-go send).
    function flash() as Void {
        _vibe([ [100, 110], [0, 60], [100, 110], [0, 60], [100, 110], [0, 60], [100, 380] ]);
        _tone(Attention.TONE_SUCCESS);
    }

    // Double long "uh-oh" + failure tone — a permanent log rejection.
    function error() as Void {
        _vibe([ [100, 260], [0, 120], [100, 260] ]);
        _tone(Attention.TONE_FAILURE);
    }

    // Subtle low double — a tick held in the offline queue ("saved, not lost").
    function offlineQueued() as Void {
        _vibe([ [35, 140], [0, 110], [35, 140] ]);
    }

    // Tiny bump — an ignored press at a queue boundary.
    function boundary() as Void {
        _vibe([ [20, 45] ]);
    }

    function sessionStart() as Void {
        _vibe([ [75, 160] ]);
        _tone(Attention.TONE_START);
    }

    function sessionStop() as Void {
        _vibe([ [75, 160] ]);
        _tone(Attention.TONE_STOP);
    }
}
