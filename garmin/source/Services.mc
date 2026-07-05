// Process-wide service locator. Holds the single shared BsClient and
// ActivityController instances so views/delegates can reach them without
// threading them through constructors. Populated once in
// BoardseshApp.getInitialView().
module Services {
    // The single shared BsClient, set once in BoardseshApp.getInitialView()
    // before any view runs. Nullable because a module var can't be a non-null
    // type without an initializer (the compiler rejects "may not be initialized
    // but does not accept Null"); the "set once before any use" contract means
    // callers treat it as always-present.
    var client as BsClient?;

    // The single shared ActivityController (FIT recording), also set once in
    // getInitialView(). A process-wide singleton means only one recording exists
    // at a time no matter how many times ClimbView is re-entered.
    var activity as ActivityController?;
}
