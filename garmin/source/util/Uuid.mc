using Toybox.Cryptography;
using Toybox.Lang;

// RFC 4122 version-4 identifiers for idempotent SaveTickInput mutations.
// Cryptography.randomBytes is available from API 3.0; this app targets 3.2.
module Uuid {
    function generate() as Lang.String {
        return formatV4(Cryptography.randomBytes(16));
    }

    // PURE formatter kept separate so version/variant bits and layout are
    // deterministic under unit test.
    function formatV4(bytes as Lang.Array or Lang.ByteArray) as Lang.String {
        var result = "";
        for (var index = 0; index < 16; index += 1) {
            if (index == 4 || index == 6 || index == 8 || index == 10) {
                result += "-";
            }
            // ByteArray elements may be signed. Mask before hexadecimal format
            // so 0xff never expands to a sign-extended eight-digit value.
            var byteValue = bytes[index] & 0xff;
            if (index == 6) {
                byteValue = (byteValue & 0x0f) | 0x40;
            } else if (index == 8) {
                byteValue = (byteValue & 0x3f) | 0x80;
            }
            result += byteValue.format("%02x");
        }
        return result;
    }
}
