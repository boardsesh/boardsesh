using Toybox.Lang;

// Credentials, verified owner, scope and revision are ONE storage value.
// Application.Storage is plaintext, not a secure enclave. Keep watch access
// private. Storage failure never publishes a new token in memory.
module TokenStore {
    const KEY = "bs.auth.v2";
    const KEY_JWT = "bs.jwt";
    const KEY_REFRESH = "bs.refresh";
    const KEY_EXP = "bs.exp";
    var _blocked = false;

    function snapshot() {
        if (_blocked) { return null; }
        try {
            var stored = WatchStore.read(KEY);
            if (stored != null) { return AuthState.valid(stored) ? stored : null; }
            var migrated = AuthState.bootstrap(WatchStore.read(KEY_JWT),
                WatchStore.read(KEY_REFRESH), WatchStore.read(KEY_EXP));
            // Once V2 exists, legacy keys are NEVER consulted again. Legacy
            // queue ownership is deliberately unrelated to this migration.
            WatchStore.write(KEY, migrated);
            return migrated;
        } catch (exception) {
            return null;
        }
    }

    function current(captured) as Lang.Boolean {
        return AuthState.sameScope(captured, snapshot());
    }

    function currentRevision(captured) as Lang.Boolean {
        return AuthState.sameRevision(captured, snapshot());
    }

    function replace(captured, next) as Lang.Boolean {
        if (!AuthState.valid(next) || !currentRevision(captured)) { return false; }
        try {
            WatchStore.write(KEY, next);
            return true;
        } catch (exception) {
            return false;
        }
    }

    function jwt() as Lang.String or Null {
        var state = snapshot();
        return AuthState.canUseAccess(state) ? state["jwt"] : null;
    }

    function refreshToken() as Lang.String or Null {
        var state = snapshot();
        return state != null && (AuthState.statusIs(state, "active") || AuthState.statusIs(state, "bootstrap")) ? state["refresh"] : null;
    }

    function expiresAt() as Lang.String or Null {
        var state = snapshot();
        return state != null ? state["expires"] : null;
    }

    function hasTokens() as Lang.Boolean {
        var state = snapshot();
        return AuthState.canUseAccess(state) || AuthState.statusIs(state, "bootstrap");
    }

    // Persist the tombstone even when already signed out. Failure blocks this
    // process; a restart sees either the previous complete envelope or tombstone.
    function clear() as Lang.Boolean {
        var state = snapshot();
        var next = AuthState.clear(state);
        if (replace(state, next)) { return true; }
        _blocked = true;
        return false;
    }

    // Pair attempts invalidate every prior login/request before network I/O.
    function beginPairing() {
        if (!clear()) { return null; }
        return snapshot();
    }

    function acceptPair(captured, response) as Lang.Boolean {
        return replace(captured, AuthState.accept(captured, response, true));
    }

    function beginRotation(captured) {
        var pending = AuthState.beginRotation(captured);
        return replace(captured, pending) ? pending : null;
    }

    function acceptRotation(captured, response) as Lang.Boolean {
        return replace(captured, AuthState.accept(captured, response, false));
    }
}
