using Toybox.Application;
using Toybox.Lang;

// Persisted auth tokens for the mobile JWT flow.
//
// NOTE: Application.Storage is NOT a secure enclave — values sit in the app's
// object store in plaintext. These are native-session credentials, not a
// watch-only permission scope. Treat a paired watch as signed into the account.
// Refresh tokens are single-use and rotated on refresh; see the shared-watch
// security notes in README.md.
module TokenStore {
    const KEY_JWT     = "bs.jwt";
    const KEY_REFRESH = "bs.refresh";
    const KEY_EXP     = "bs.exp";

    function jwt() as Lang.String or Null {
        return Application.Storage.getValue(KEY_JWT);
    }

    function refreshToken() as Lang.String or Null {
        return Application.Storage.getValue(KEY_REFRESH);
    }

    function expiresAt() as Lang.String or Null {
        return Application.Storage.getValue(KEY_EXP);
    }

    function hasTokens() as Lang.Boolean {
        return Application.Storage.getValue(KEY_JWT) != null;
    }

    // Persist a fresh token triple. Callers MUST store the rotated pair BEFORE
    // issuing another request that could 401 again (single-use refresh tokens).
    function store(jwtValue as Lang.String, refreshValue as Lang.String, expValue as Lang.String) as Void {
        Application.Storage.setValue(KEY_JWT, jwtValue);
        Application.Storage.setValue(KEY_REFRESH, refreshValue);
        Application.Storage.setValue(KEY_EXP, expValue);
    }

    function clear() as Void {
        Application.Storage.deleteValue(KEY_JWT);
        Application.Storage.deleteValue(KEY_REFRESH);
        Application.Storage.deleteValue(KEY_EXP);
    }
}
