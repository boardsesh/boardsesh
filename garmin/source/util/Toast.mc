using Toybox.WatchUi;
using Toybox.Attention;
using Toybox.Lang;

// Lightweight transient feedback.
//
// Prefers WatchUi.showToast where available; falls back to a short vibration so
// pre-3.4 devices still get feedback.
module Toast {
    function show(text as Lang.String) as Void {
        // VERIFY: WatchUi.showToast was added around Connect IQ 3.4.0. minApiLevel
        // here is 3.2.0, so we feature-gate with `has` and fall back below.
        if (WatchUi has :showToast) {
            WatchUi.showToast(text, null);
            return;
        }
        if ((Attention has :vibrate)) {
            // VERIFY: Attention.VibeProfile(dutyCyclePercent, durationMs).
            Attention.vibrate([ new Attention.VibeProfile(50, 200) ]);
        }
    }
}
