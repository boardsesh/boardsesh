/** The hosted Boardsesh API. Override with EXPO_PUBLIC_BACKEND_URL for a local backend. */
export const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? 'https://ws.boardsesh.com';

/** The Boardsesh website, which also serves the board photos. */
export const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://www.boardsesh.com';
