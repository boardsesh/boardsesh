/**
 * Shared vocabulary for QR entry attribution. TV setup describes anonymous
 * kiosk setup or reinstallation, rather than climber acquisition.
 */
export const QR_ENTRY_SOURCES = [
  'gym-poster',
  'board-poster',
  'kiosk',
  'board-share',
  'session-invite',
  'embedded-session',
  'app-share',
  'tv-setup',
] as const;

export type QrEntrySource = (typeof QR_ENTRY_SOURCES)[number];
