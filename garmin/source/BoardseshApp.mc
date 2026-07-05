using Toybox.Application;
using Toybox.WatchUi;
using Toybox.Lang;

// Application entry point.
//
// Boot sequence (getInitialView):
//   * create the shared BsClient (auth-lost -> route to pairing),
//   * no tokens          -> PairingView,
//   * tokens present     -> LoadingView, which resolves the active session and
//                           routes to ClimbView / SessionPickerView / NoSessionView.
class BoardseshApp extends Application.AppBase {

    function initialize() {
        AppBase.initialize();
    }

    function onStart(state as Lang.Dictionary or Null) as Void {
    }

    // Last-chance save. Any exit that ISN'T the ExitConfirm menu (a 410
    // session-ended, auth-lost, or a system-initiated exit) lands here with the
    // recording still running — default to SAVING rather than silently losing
    // the whole activity. The ExitConfirm Save/Discard paths already stopped the
    // session, so isRecording() is false by the time we get here: no double
    // save/discard.
    function onStop(state as Lang.Dictionary or Null) as Void {
        if (Services.activity != null && Services.activity.isRecording()) {
            Services.activity.stopAndSave();
        }
    }

    function getInitialView() {
        Services.client = new BsClient(BuildConfig.baseUrl(), method(:onAuthLost));
        Services.activity = new ActivityController();

        if (!TokenStore.hasTokens()) {
            var pairing = new PairingView();
            return [ pairing, new PairingDelegate(pairing) ];
        }
        return [ new LoadingView(), new LoadingDelegate() ];
    }

    // Fired by BsClient when a token refresh fails: drop back to pairing.
    function onAuthLost() as Void {
        Router.toPairing();
    }
}
