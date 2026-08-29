// GENERATED FILE - DO NOT EDIT.
// Run `vp run generate:board-render-version` to refresh it.
//
// Cache version for /api/internal/board-render URLs. Derived from the shipped board
// catalogue plus the compiled renderer and sharp pipeline, so a change that alters
// what the route draws mints new URLs and the old ones age out of Cloudflare instead
// of being served for a year (#4773).
//
// Deliberately import-free: this module is reachable from web's client bundle
// through buildBoardRenderUrl, and must never drag sharp or the WASM glue with it.
export const BOARD_RENDER_VERSION = '66b0a2a9c6e0';
