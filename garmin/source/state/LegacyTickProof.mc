using Toybox.Lang;

// What the last pre-G2 build left behind can prove about its queued ticks.
//
// Pre-G2 builds kept one access token in `bs.jwt` and wrote it FIRST on every
// pairing and refresh, before the refresh token, the expiry and (on pairing)
// the queue clear. Every request, tick saves included, was signed with that
// token. So from the moment the final `bs.jwt` was issued until the update,
// every tick the old app logged was logged while it was signed in as that
// token's subject. No later build writes `bs.jwt`.
//
// Nothing proves who logged a tick queued BEFORE that token was issued: an
// interrupted pairing could leave the previous account's ticks beside new
// credentials. Those stay quarantined.
//
// Only the subject and issue time are read; no signature is checked. The
// value is this app's own storage, written from the server's pairing/refresh
// response, and the subject must also equal an owner the server verified.
module LegacyTickProof {
    const MAX_SEGMENT = 2048;

    // { "owner" => subject, "issuedAt" => epoch seconds (Long) } or null.
    function fromJwt(jwt) {
        if (!(jwt instanceof Lang.String) || jwt.length() > 4096) { return null; }
        var firstDot = jwt.find(".");
        if (firstDot == null || firstDot == 0) { return null; }
        var rest = jwt.substring(firstDot + 1, jwt.length());
        var secondDot = rest.find(".");
        if (secondDot == null || secondDot == 0) { return null; }
        var payload = _decodeSegment(rest.substring(0, secondDot));
        if (payload == null) { return null; }
        var owner = _stringClaim(payload, "sub");
        var issuedAt = _numberClaim(payload, "iat");
        if (owner == null || issuedAt == null) { return null; }
        return { "owner" => owner, "issuedAt" => issuedAt };
    }

    // base64url alphabet value of one character code, or -1.
    function _sextet(code as Lang.Number) as Lang.Number {
        if (code >= 65 && code <= 90) { return code - 65; }
        if (code >= 97 && code <= 122) { return code - 71; }
        if (code >= 48 && code <= 57) { return code + 4; }
        if (code == 45) { return 62; }
        if (code == 95) { return 63; }
        return -1;
    }

    // base64url (RFC 7515, unpadded) to printable-ASCII JSON text, or null.
    // Decoded here rather than with StringUtil.convertEncodedString, which
    // raises an uncatchable VM error on malformed input. The server's payload
    // is compact ASCII JSON, so any other byte refuses.
    function _decodeSegment(segment as Lang.String) {
        var length = segment.length();
        if (length == 0 || length > MAX_SEGMENT || length % 4 == 1) { return null; }
        var chars = segment.toCharArray();
        var text = "";
        var buffer = 0;
        var bits = 0;
        for (var index = 0; index < length; index += 1) {
            var sextet = _sextet(chars[index].toNumber());
            if (sextet < 0) { return null; }
            buffer = ((buffer << 6) | sextet) & 0xFFFF;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                var octet = (buffer >> bits) & 0xFF;
                if (octet < 32 || octet > 126) { return null; }
                text = text + octet.toChar().toString();
            }
        }
        return text;
    }

    // Index just past `key`, or null when the key is absent or repeated.
    function _claimStart(payload as Lang.String, key as Lang.String) {
        var found = payload.find(key);
        if (found == null) { return null; }
        var start = found + key.length();
        var rest = payload.substring(start, payload.length());
        return rest.find(key) == null ? start : null;
    }

    // The server signs compact JSON (no spaces), so `"sub":"<id>"` is exact.
    function _stringClaim(payload as Lang.String, name as Lang.String) {
        var start = _claimStart(payload, "\"" + name + "\":\"");
        if (start == null) { return null; }
        var rest = payload.substring(start, payload.length());
        var end = rest.find("\"");
        if (end == null || end == 0 || end > 256) { return null; }
        var value = rest.substring(0, end);
        // An escaped character means this is not a plain account id.
        return value.find("\\") == null ? value : null;
    }

    function _numberClaim(payload as Lang.String, name as Lang.String) {
        var start = _claimStart(payload, "\"" + name + "\":");
        if (start == null) { return null; }
        var chars = payload.substring(start, payload.length()).toCharArray();
        var value = 0l;
        var digits = 0;
        while (digits < chars.size() && digits < 11) {
            var code = chars[digits].toNumber();
            if (code < 48 || code > 57) { break; }
            value = value * 10l + (code - 48);
            digits += 1;
        }
        if (digits == 0 || digits > 10) { return null; }
        // A plain integer claim ends at ',' or '}'; "1.7e9" must not read as 1.
        if (digits < chars.size()) {
            var next = chars[digits].toNumber();
            if (next != 44 && next != 125) { return null; }
        }
        return value;
    }
}
