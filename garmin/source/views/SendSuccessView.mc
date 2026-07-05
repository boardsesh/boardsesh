using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.Timer;
using Toybox.Lang;

// Brief celebratory confirmation shown over ClimbView after a send/flash.
//
// Pushed OPTIMISTICALLY on the log press; ClimbView underneath already reflects
// the send. Auto-dismisses after ~1.2s (any button also dismisses early). Drawn
// on a black background with a green accent — a rewarding beat that stays
// battery/burn-in friendly on AMOLED because it's transient, not persistent.
class SendSuccessView extends WatchUi.View {
    private var _grade as Lang.String;
    private var _flash as Lang.Boolean;
    private var _timer as Timer.Timer or Null;
    private var _done as Lang.Boolean;

    function initialize(grade as Lang.String, isFlash as Lang.Boolean) {
        View.initialize();
        _grade = grade;
        _flash = isFlash;
        _timer = null;
        _done = false;
    }

    function onLayout(dc as Graphics.Dc) as Void {
    }

    function onShow() as Void {
        _timer = new Timer.Timer();
        _timer.start(method(:dismiss), 1200, false);
    }

    function onUpdate(dc as Graphics.Dc) as Void {
        Theme.ensure(dc);
        dc.setColor(Theme.TEXT, Theme.BG);
        dc.clear();

        var cx = Theme.cx;
        var h = Theme.h;

        // Big label: SEND! / FLASH! in the send accent.
        dc.setColor(Theme.SEND, Graphics.COLOR_TRANSPARENT);
        var label = WatchUi.loadResource(_flash ? Rez.Strings.FlashBang : Rez.Strings.SendBang);
        dc.drawText(cx, h * 42 / 100, Theme.gradeFont(), label,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);

        // The grade, dimmed, below.
        dc.setColor(Theme.DIM, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, h * 64 / 100, Theme.metaFont(), _grade,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    function dismiss() as Void {
        if (_done) {
            return;
        }
        _done = true;
        if (_timer != null) {
            _timer.stop();
            _timer = null;
        }
        WatchUi.popView(WatchUi.SLIDE_DOWN);
    }
}

class SendSuccessDelegate extends WatchUi.BehaviorDelegate {
    private var _view as SendSuccessView;

    function initialize(view as SendSuccessView) {
        BehaviorDelegate.initialize();
        _view = view;
    }

    function onSelect() as Lang.Boolean {
        _view.dismiss();
        return true;
    }

    function onBack() as Lang.Boolean {
        _view.dismiss();
        return true;
    }

    // Any other key (UP/DOWN/...) also dismisses the transient celebration.
    function onKey(evt as WatchUi.KeyEvent) as Lang.Boolean {
        _view.dismiss();
        return true;
    }

    // A screen tap dismisses it too, on touch devices.
    function onTap(evt as WatchUi.ClickEvent) as Lang.Boolean {
        _view.dismiss();
        return true;
    }
}
