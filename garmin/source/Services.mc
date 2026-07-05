// Process-wide service locator. Holds the single shared BsClient instance so
// views/delegates can reach it without threading it through constructors.
// Populated once in BoardseshApp.getInitialView().
module Services {
    // The single shared BsClient. Set once in BoardseshApp.getInitialView()
    // before any view runs, so callers treat it as always-present. Typed
    // nullable (it defaults to null until startup) so the type checker is happy.
    var client as BsClient or Null;
}
