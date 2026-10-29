const FILE_SCHEME = 'file://';

/**
 * Undo the percent-encoding in a `file://` URI (or in a scheme-less path cut
 * from one), keeping the scheme if it had one.
 *
 * Android's `Uri.fromFile(file).toString()` encodes every character outside
 * `A-Z a-z 0-9 _-!.~'()*` and `/`, so expo-file-system lists a cached overlay
 * named `…_moonboard_2_1_1,2,3_ab.png` as `…_1%2C2%2C3_ab.png` (issue #7026).
 * expo-image and expo-file-system decode that on the way in. A native consumer
 * that only strips `file://` and opens the rest as a path
 * (`BitmapFactory.decodeFile` in the session notification) asks for a file whose
 * name really contains `%2C`, and gets nothing.
 *
 * A string with a malformed escape is returned unchanged: it cannot be a URI we
 * produced, and guessing would hand native a different wrong path.
 */
export function decodeFileUri(uriOrPath: string): string {
  const hasScheme = uriOrPath.startsWith(FILE_SCHEME);
  const encodedPath = hasScheme ? uriOrPath.slice(FILE_SCHEME.length) : uriOrPath;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(encodedPath);
  } catch {
    return uriOrPath;
  }
  return hasScheme ? `${FILE_SCHEME}${decodedPath}` : decodedPath;
}
