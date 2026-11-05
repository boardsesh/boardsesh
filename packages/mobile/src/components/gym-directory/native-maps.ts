// Older native builds may not include expo-maps. Keep that failure outside the
// component so the finder can still offer its gym list and place search.
let nativeMaps: typeof import('expo-maps') | null = null;
try {
  nativeMaps = require('expo-maps');
} catch {
  nativeMaps = null;
}

export { nativeMaps };
