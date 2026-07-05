using Toybox.WatchUi;
using Toybox.Lang;

// Synchronous view transitions.
//
// These are plain module functions (no callbacks), so they can be called from
// anywhere. Async work that decides WHERE to go (session resolution) lives in
// LoadingView, which can bind `method(...)` callbacks to itself.
module Router {

    function toPairing() as Void {
        var view = new PairingView();
        WatchUi.switchToView(view, new PairingDelegate(view), WatchUi.SLIDE_IMMEDIATE);
    }

    // Transient splash that (re)resolves the active session then routes on.
    function toLoading() as Void {
        WatchUi.switchToView(new LoadingView(), new LoadingDelegate(), WatchUi.SLIDE_IMMEDIATE);
    }

    function toClimb() as Void {
        var view = new ClimbView();
        WatchUi.switchToView(view, new ClimbDelegate(view), WatchUi.SLIDE_IMMEDIATE);
    }

    function toNoSession() as Void {
        WatchUi.switchToView(new NoSessionView(), new NoSessionDelegate(), WatchUi.SLIDE_IMMEDIATE);
    }

    function toSessionPicker(sessions as Lang.Array) as Void {
        // A Menu2 is shown with pushView, NOT switchToView (switchToView's view
        // param is a plain View; Menu2 is a separate type). onSelect then
        // switchToView(ClimbView) replaces the picker; exit is always System.exit
        // from ExitConfirm, so the view left underneath is never reached.
        var view = new SessionPickerView(sessions);
        WatchUi.pushView(view, new SessionPickerDelegate(view), WatchUi.SLIDE_IMMEDIATE);
    }
}
