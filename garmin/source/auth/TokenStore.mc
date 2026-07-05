using Toybox.Application;
using Toybox.Lang;

// Persisted auth tokens for the mobile JWT flow.
//
// NOTE: Application.Storage is NOT a secure enclave — values sit in the app's
// object store in plaintext. That is an accepted trade-off here: the token is a
// short-lived (~7 day) climb-logging JWT scoped to session mutation, not a
// password or a long-lived credential. Refresh tokens are single-use and
// rotated on every refresh (see BsClient), which limits replay value.
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
    function store(jwtValue, refreshValue, expValue) as Void {
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
