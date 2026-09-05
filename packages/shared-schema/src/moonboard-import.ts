// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export type MoonBoardExportUser = {
  firstName?: string;
  lastName?: string;
  setterName?: string;
  username?: string;
  city?: string;
  country?: string;
};

export type MoonBoardExportLogRow = {
  lineNumber: number;
  problemId: number;
  grade: string;
  tries: string;
  attempts: number;
  rating: number | null;
  date: string;
};

export type StrippedMoonBoardExportData = {
  user: MoonBoardExportUser;
  logs: MoonBoardExportLogRow[];
};

export type MoonBoardExportPreview = {
  username: string;
  rows: number;
  sends: number;
  flashes: number;
  attempts: number;
  projects: number;
  fails: number;
  angle: 40;
};

export type ParsedMoonBoardExportResult = {
  data: StrippedMoonBoardExportData;
  preview: MoonBoardExportPreview;
};

export type MoonBoardLogRowClassification =
  | { status: 'flash'; attemptCount: 1 }
  | { status: 'send'; attemptCount: number }
  | { status: 'attempt'; attemptCount: number };

export type MoonBoardImportCounts = {
  imported: number;
  skipped: number;
  failed: number;
};

export type MoonBoardImportResult = {
  ticks: MoonBoardImportCounts;
  ascents: MoonBoardImportCounts;
  attempts: MoonBoardImportCounts;
  unresolvedClimbs: string[];
  unresolvedAscentClimbs: string[];
  unresolvedAttemptClimbs: string[];
  partialError?: string;
};

export type MoonBoardImportProgressEvent =
  | { type: 'progress'; step: 'resolving'; current: number; total: number }
  | { type: 'progress'; step: 'importing'; current: number; total: number }
  | { type: 'progress'; step: 'recomputing'; message: string }
  | { type: 'complete'; results: MoonBoardImportResult }
  | { type: 'error'; error: string };

const HEADER_NAMES = ['problemid', 'grade', 'tries', 'attempts', 'rating', 'date'] as const;

const USER_METADATA_KEYS: Record<string, keyof MoonBoardExportUser> = {
  firstname: 'firstName',
  lastname: 'lastName',
  settername: 'setterName',
  username: 'username',
  city: 'city',
  country: 'country',
};

function normalizeHeaderCell(cell: string): string {
  return cell.trim().replace(/\s+/g, '').toLowerCase();
}

function normalizeMetadataKey(cell: string): string {
  return cell.trim().replace(/\s+/g, '').toLowerCase();
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const nextChar = csv[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== '') || rows.length === 0) rows.push(row);
  return rows;
}

function isMoonBoardHeader(row: string[]): boolean {
  return HEADER_NAMES.every((name, index) => normalizeHeaderCell(row[index] ?? '') === name);
}

function parseRequiredInteger(value: string, field: string, lineNumber: number): number {
  const trimmedValue = value.trim();
  if (!/^\d+$/.test(trimmedValue)) {
    throw new Error(`invalid_${field}_line_${lineNumber}`);
  }
  return Number(trimmedValue);
}

function parseOptionalRating(value: string, lineNumber: number): number | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;
  const rating = parseRequiredInteger(trimmedValue, 'rating', lineNumber);
  if (rating === 0) return null;
  if (rating < 1 || rating > 5) {
    throw new Error(`invalid_rating_line_${lineNumber}`);
  }
  return rating;
}

function normalizeTriesLabel(tries: string): string {
  return tries.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function classifyMoonBoardLogRow(row: MoonBoardExportLogRow): MoonBoardLogRowClassification {
  const label = normalizeTriesLabel(row.tries);
  if (label === 'flashed') {
    return { status: 'flash', attemptCount: 1 };
  }
  if (label === 'session flash') {
    return { status: 'send', attemptCount: 1 };
  }

  const tryMatch = label.match(/^(\d+)(?:st|nd|rd|th)? try$/);
  if (tryMatch) {
    const attemptCount = Number(tryMatch[1]);
    return attemptCount <= 1 ? { status: 'flash', attemptCount: 1 } : { status: 'send', attemptCount };
  }

  if (label === 'more than 3 tries') {
    return { status: 'send', attemptCount: Math.max(row.attempts, 4) };
  }

  if (label === 'project' || label === 'fail') {
    return { status: 'attempt', attemptCount: Math.max(row.attempts, 1) };
  }

  throw new Error(`unsupported_tries_line_${row.lineNumber}`);
}

function buildPreview(data: StrippedMoonBoardExportData): MoonBoardExportPreview {
  let sends = 0;
  let flashes = 0;
  let attempts = 0;
  let projects = 0;
  let fails = 0;

  for (const row of data.logs) {
    const classification = classifyMoonBoardLogRow(row);
    const triesLabel = normalizeTriesLabel(row.tries);
    if (classification.status === 'attempt') {
      attempts += 1;
      if (triesLabel === 'project') projects += 1;
      if (triesLabel === 'fail') fails += 1;
    } else {
      sends += 1;
      if (classification.status === 'flash') flashes += 1;
    }
  }

  return {
    username: data.user.username ?? data.user.setterName ?? '',
    rows: data.logs.length,
    sends,
    flashes,
    attempts,
    projects,
    fails,
    angle: 40,
  };
}

export function parseMoonBoardExportCsv(csv: string): ParsedMoonBoardExportResult {
  const rows = parseCsvRows(csv.replace(/^\uFEFF/, ''));
  const headerIndex = rows.findIndex(isMoonBoardHeader);
  if (headerIndex === -1) {
    throw new Error('missing_moonboard_log_header');
  }

  const user: MoonBoardExportUser = {};
  for (const row of rows.slice(0, headerIndex)) {
    const mappedKey = USER_METADATA_KEYS[normalizeMetadataKey(row[0] ?? '')];
    const value = (row[1] ?? '').trim();
    if (mappedKey && value && value.toLowerCase() !== 'null' && value !== '-') {
      user[mappedKey] = value;
    }
  }

  const logs: MoonBoardExportLogRow[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.every((value) => value.trim() === '')) continue;

    const lineNumber = rowIndex + 1;
    const problemId = parseRequiredInteger(row[0] ?? '', 'problem_id', lineNumber);
    const grade = (row[1] ?? '').trim().toUpperCase();
    const tries = (row[2] ?? '').trim();
    const attempts = parseRequiredInteger(row[3] ?? '', 'attempts', lineNumber);
    const rating = parseOptionalRating(row[4] ?? '', lineNumber);
    const date = (row[5] ?? '').trim();

    if (!grade) throw new Error(`missing_grade_line_${lineNumber}`);
    if (!tries) throw new Error(`missing_tries_line_${lineNumber}`);
    if (!date) throw new Error(`missing_date_line_${lineNumber}`);

    logs.push({
      lineNumber,
      problemId,
      grade,
      tries,
      attempts,
      rating,
      date,
    });
  }

  const data: StrippedMoonBoardExportData = { user, logs };
  return {
    data,
    preview: buildPreview(data),
  };
}
