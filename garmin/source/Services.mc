// Process-wide service locator. Holds the single shared BsClient and
// ActivityController instances so views/delegates can reach them without
// threading them through constructors. Populated once in
// BoardseshApp.getInitialView().
module Services {
    // The single shared BsClient. Set once in BoardseshApp.getInitialView()
    // before any view runs, so callers treat it as always-present. Typed
    // non-null (module vars default to null at runtime, but the declared
    // non-null type keeps the ~7 deref sites clean for the type checker; the
    // "set once before any use" contract holds).
    var client as BsClient;

    // The single shared ActivityController (FIT recording). Also set once in
    // BoardseshApp.getInitialView(). Same non-null contract as `client`; a
    // process-wide singleton means only one recording exists at a time no
    // matter how many times ClimbView is re-entered.
    var activity as ActivityController;
}
