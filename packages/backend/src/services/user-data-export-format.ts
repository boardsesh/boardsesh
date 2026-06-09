import { HOLE_PLACEMENTS, LAYOUTS } from '@boardsesh/board-constants/product-sizes';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import { AURORA_BOARDS, type AuroraBoardName, type BoardName } from '@boardsesh/shared-schema';

export type AuroraJsonExport = {
  user: {
    username: string;
    email_address?: string;
    created_at?: string;
  };
  ascents: Array<{
    climb: string;
    angle: number;
    count: number;
    stars: number;
    climbed_at: string;
    created_at: string;
    grade: string;
  }>;
  attempts: Array<{
    climb: string;
    angle: number;
    count: number;
    climbed_at: string;
    created_at: string;
  }>;
  circuits: Array<{
    name: string;
    color: string;
    created_at: string;
    description?: string;
    is_private?: boolean;
    climbs: string[];
  }>;
  climbs: Array<{
    name: string;
    layout: string;
    created_at: string;
    is_draft?: boolean | null;
    holds: Array<{ x: number; y: number; role: string }>;
    description?: string;
  }>;
  likes: Array<{ climb: string; created_at: string }>;
};

export type ExportUserRow = {
  id: string;
  name: string | null;
  email: string | null;
  createdAt: Date | string | null;
};

export type ExportTickRow = {
  climbName: string | null;
  status: 'flash' | 'send' | 'attempt';
  angle: number;
  attemptCount: number | null;
  quality: number | null;
  difficulty: number | null;
  difficultyName: string | null;
  climbedAt: string | Date;
  createdAt: string | Date;
};

export type ExportFavoriteRow = {
  climbName: string | null;
  createdAt: string | Date;
};

export type ExportCircuitRow = {
  playlistId: bigint | number | string;
  name: string;
  color: string | null;
  createdAt: string | Date;
  description: string | null;
  isPublic: boolean | null;
  climbName: string | null;
  position: number | null;
};

export type ExportClimbRow = {
  uuid: string;
  name: string | null;
  layoutId: number;
  frames: string | null;
  createdAt: string | Date | null;
  isDraft: boolean | null;
  description: string | null;
};

export type IsoWeekPeriod = {
  year: number;
  week: number;
  label: string;
};

const ROLE_BY_HOLD_STATE: Record<string, string> = {
  STARTING: 'start',
  HAND: 'middle',
  FINISH: 'finish',
  FOOT: 'foot',
};

export function isAuroraBoardType(value: string | null | undefined): value is AuroraBoardName {
  return !!value && (AURORA_BOARDS as readonly string[]).includes(value);
}

export function getIsoWeekPeriod(date = new Date()): IsoWeekPeriod {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNumber);

  const year = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);

  return {
    year,
    week,
    label: `${year}-W${String(week).padStart(2, '0')}`,
  };
}

export function getUserDataExportS3Key(userId: string, boardType: AuroraBoardName, date = new Date()): string {
  const period = getIsoWeekPeriod(date);
  return `user-data-exports/${userId}/${boardType}/${period.label}.json`;
}

export function getUserDataExportFilename(boardType: AuroraBoardName, date = new Date()): string {
  const period = getIsoWeekPeriod(date);
  return `boardsesh-${boardType}-export-${period.label}.json`;
}

export function buildAuroraJsonExport(input: {
  boardType: AuroraBoardName;
  user: ExportUserRow | null;
  ticks: ExportTickRow[];
  favorites: ExportFavoriteRow[];
  circuitRows: ExportCircuitRow[];
  climbs: ExportClimbRow[];
}): AuroraJsonExport {
  const user = buildUserExport(input.user);
  const ascents: AuroraJsonExport['ascents'] = [];
  const attempts: AuroraJsonExport['attempts'] = [];

  for (const tick of input.ticks) {
    if (!tick.climbName) continue;

    if (tick.status === 'attempt') {
      attempts.push({
        climb: tick.climbName,
        angle: tick.angle,
        count: tick.attemptCount ?? 1,
        climbed_at: formatTimestamp(tick.climbedAt),
        created_at: formatTimestamp(tick.createdAt),
      });
      continue;
    }

    ascents.push({
      climb: tick.climbName,
      angle: tick.angle,
      count: tick.attemptCount ?? 1,
      stars: tick.quality ?? 0,
      climbed_at: formatTimestamp(tick.climbedAt),
      created_at: formatTimestamp(tick.createdAt),
      grade: tick.difficultyName ?? (tick.difficulty == null ? '' : String(tick.difficulty)),
    });
  }

  return {
    user,
    ascents,
    attempts,
    circuits: buildCircuitExports(input.circuitRows),
    climbs: buildClimbExports(input.boardType, input.climbs),
    likes: buildLikeExports(input.favorites),
  };
}

function buildUserExport(user: ExportUserRow | null): AuroraJsonExport['user'] {
  if (!user) {
    return { username: 'Boardsesh User' };
  }

  const username = user.name || user.email?.split('@')[0] || user.id;
  return {
    username,
    ...(user.email ? { email_address: user.email } : {}),
    ...(user.createdAt ? { created_at: formatTimestamp(user.createdAt) } : {}),
  };
}

function buildLikeExports(favorites: ExportFavoriteRow[]): AuroraJsonExport['likes'] {
  const seen = new Set<string>();
  const likes: AuroraJsonExport['likes'] = [];

  for (const favorite of favorites) {
    if (!favorite.climbName || seen.has(favorite.climbName)) continue;
    seen.add(favorite.climbName);
    likes.push({
      climb: favorite.climbName,
      created_at: formatTimestamp(favorite.createdAt),
    });
  }

  return likes;
}

function buildCircuitExports(rows: ExportCircuitRow[]): AuroraJsonExport['circuits'] {
  const circuits = new Map<
    string,
    {
      name: string;
      color: string;
      created_at: string;
      description?: string;
      is_private?: boolean;
      climbs: string[];
      climbNamesSeen: Set<string>;
    }
  >();

  for (const row of rows) {
    const key = String(row.playlistId);
    let circuit = circuits.get(key);

    if (!circuit) {
      circuit = {
        name: row.name,
        color: (row.color ?? '').replace(/^#/, ''),
        created_at: formatTimestamp(row.createdAt),
        ...(row.description ? { description: row.description } : {}),
        ...(row.isPublic == null ? {} : { is_private: !row.isPublic }),
        climbs: [],
        climbNamesSeen: new Set<string>(),
      };
      circuits.set(key, circuit);
    }

    if (row.climbName && !circuit.climbNamesSeen.has(row.climbName)) {
      circuit.climbNamesSeen.add(row.climbName);
      circuit.climbs.push(row.climbName);
    }
  }

  return [...circuits.values()].map(({ climbNamesSeen: _climbNamesSeen, ...circuit }) => circuit);
}

function buildClimbExports(boardType: AuroraBoardName, climbs: ExportClimbRow[]): AuroraJsonExport['climbs'] {
  return climbs.map((climb) => ({
    name: climb.name ?? climb.uuid,
    layout: getLayoutName(boardType, climb.layoutId),
    created_at: climb.createdAt ? formatTimestamp(climb.createdAt) : new Date(0).toISOString(),
    is_draft: climb.isDraft,
    holds: framesToExportHolds(boardType, climb.layoutId, climb.frames),
    ...(climb.description ? { description: climb.description } : {}),
  }));
}

export function framesToExportHolds(
  boardType: AuroraBoardName,
  layoutId: number,
  frames: string | null | undefined,
): Array<{ x: number; y: number; role: string }> {
  if (!frames) return [];

  const placementCoordinates = buildPlacementCoordinateMap(boardType, layoutId);
  const firstFrame = convertLitUpHoldsStringToMap(frames, boardType as BoardName)[0] ?? {};

  return Object.entries(firstFrame)
    .map(([holdId, hold]) => {
      const coordinates = placementCoordinates.get(Number(holdId));
      const role = ROLE_BY_HOLD_STATE[String(hold.state)];
      if (!coordinates || !role) return null;
      return { ...coordinates, role };
    })
    .filter((hold): hold is { x: number; y: number; role: string } => hold != null)
    .sort((a, b) => a.y - b.y || a.x - b.x || a.role.localeCompare(b.role));
}

function buildPlacementCoordinateMap(
  boardType: AuroraBoardName,
  layoutId: number,
): Map<number, { x: number; y: number }> {
  const map = new Map<number, { x: number; y: number }>();
  const placementsBySet = HOLE_PLACEMENTS[boardType as BoardName] ?? {};

  for (const [key, placements] of Object.entries(placementsBySet)) {
    if (!key.startsWith(`${layoutId}-`)) continue;

    for (const [placementId, , x, y] of placements) {
      if (!map.has(placementId)) {
        map.set(placementId, { x, y });
      }
    }
  }

  return map;
}

// `@boardsesh/board-constants` exports a shared `getLayoutName` used by the
// analytics call sites (web + mobile), but that one falls back to `''` so a
// numeric id is never sent where web sends a name. This export copy keeps its
// own `String(layoutId)` fallback on purpose: a data export should always carry
// an identifiable value for the layout rather than a blank, so an unrecognised
// id stays traceable in the user's downloaded file.
function getLayoutName(boardType: AuroraBoardName, layoutId: number): string {
  return LAYOUTS[boardType as BoardName]?.[layoutId]?.name ?? String(layoutId);
}

function formatTimestamp(value: string | Date): string {
  return typeof value === 'string' ? value : value.toISOString();
}
