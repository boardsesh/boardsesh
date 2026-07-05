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

    function onStop(state as Lang.Dictionary or Null) as Void {
    }

    function getInitialView() {
        Services.client = new BsClient(BuildConfig.baseUrl(), method(:onAuthLost));

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
