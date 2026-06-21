import { AURORA_BOARDS } from './types/board-config';

export type AuroraExportPreview = {
  ascents: number;
  attempts: number;
  circuits: number;
  climbs: number;
  username: string;
};

export type StrippedAuroraExportData = {
  user: { username: string; email_address?: string; created_at?: string };
  ascents: unknown[];
  attempts: unknown[];
  circuits: unknown[];
  climbs: unknown[];
};

export type ParsedAuroraExportResult = {
  data: StrippedAuroraExportData;
  preview: AuroraExportPreview;
  boardMismatchLayoutName?: string;
};

export type ImportCounts = {
  imported: number;
  skipped: number;
  failed: number;
};

export type ImportResult = {
  ascents: ImportCounts;
  attempts: ImportCounts;
  circuits: ImportCounts;
  climbs: ImportCounts;
  unresolvedClimbs: string[];
  unresolvedAscentClimbs: string[];
  unresolvedAttemptClimbs: string[];
  unresolvedCircuitClimbs: string[];
  partialError?: string;
};

export type ImportProgressEvent =
  | { type: 'progress'; step: 'climbs'; current: number; total: number }
  | { type: 'progress'; step: 'resolving'; message: string }
  | { type: 'progress'; step: 'dedup'; message: string }
  | { type: 'progress'; step: 'ascents'; current: number; total: number }
  | { type: 'progress'; step: 'attempts'; current: number; total: number }
  | { type: 'progress'; step: 'circuits'; current: number; total: number }
  | { type: 'complete'; results: ImportResult }
  | { type: 'error'; error: string };

const BOARD_LAYOUT_KEYWORDS: Record<(typeof AURORA_BOARDS)[number], string[]> = {
  kilter: ['kilter'],
  tension: ['tension'],
  decoy: ['decoy'],
  touchstone: ['touchstone'],
  grasshopper: ['grasshopper'],
  soill: ['soill', 'so ill'],
};

function readStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record[property] === 'string' ? record[property] : undefined;
}

function detectBoardFromLayoutName(layoutName: string): string | null {
  const normalizedLayoutName = layoutName.toLowerCase();
  for (const boardType of AURORA_BOARDS) {
    if (BOARD_LAYOUT_KEYWORDS[boardType].some((keyword) => normalizedLayoutName.includes(keyword))) {
      return boardType;
    }
  }
  return null;
}

export function parseAuroraExportJson(json: Record<string, unknown>, boardType: string): ParsedAuroraExportResult {
  const user = json.user;
  const username = readStringProperty(user, 'username');
  if (!username) {
    throw new Error('missing_user');
  }

  const ascents = Array.isArray(json.ascents) ? json.ascents : [];
  const attempts = Array.isArray(json.attempts) ? json.attempts : [];
  const circuits = Array.isArray(json.circuits) ? json.circuits : [];
  const climbs = Array.isArray(json.climbs) ? json.climbs : [];

  let boardMismatchLayoutName: string | undefined;
  if (climbs.length > 0) {
    const layoutName = readStringProperty(climbs[0], 'layout');
    const layoutBoard = layoutName ? detectBoardFromLayoutName(layoutName) : null;
    if (layoutName && layoutBoard && layoutBoard !== boardType) {
      boardMismatchLayoutName = layoutName;
    }
  }

  const emailAddress = readStringProperty(user, 'email_address');
  const createdAt = readStringProperty(user, 'created_at');

  return {
    data: {
      user: {
        username,
        ...(emailAddress ? { email_address: emailAddress } : {}),
        ...(createdAt ? { created_at: createdAt } : {}),
      },
      ascents,
      attempts,
      circuits,
      climbs,
    },
    preview: {
      ascents: ascents.length,
      attempts: attempts.length,
      circuits: circuits.length,
      climbs: climbs.length,
      username,
    },
    ...(boardMismatchLayoutName ? { boardMismatchLayoutName } : {}),
  };
}
