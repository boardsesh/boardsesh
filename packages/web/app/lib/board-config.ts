import type { BoardConfig, UserBoard } from '@boardsesh/shared-schema';
import type { BoardDetails, BoardName } from './types';
import type { ClimbQueueItem } from '@/app/components/queue-control/types';
import { getBoardDetailsForBoard } from './board-utils';

export type { BoardConfig };

/**
 * Stable string key for a "queue board" — the combination that, within a single
 * queue, should prompt the user at most once. Intentionally excludes `sizeId`
 * and `angle`: larger sizes are handled separately by `decideAdd`, and angle
 * is a per-attempt choice that doesn't invalidate the hold layout.
 */
export type ConfigKey = string;

export function configKey(cfg: Pick<BoardConfig, 'boardName' | 'layoutId' | 'setIds'>): ConfigKey {
  const sorted = [...cfg.setIds].sort((a, b) => a - b).join(',');
  return `${cfg.boardName}|${cfg.layoutId}|${sorted}`;
}

export function boardConfigFromDetails(details: BoardDetails, angle: number): BoardConfig {
  return {
    boardName: details.board_name,
    layoutId: details.layout_id,
    sizeId: details.size_id,
    setIds: details.set_ids,
    angle,
  };
}

export function boardConfigFromUserBoard(board: UserBoard, angle: number): BoardConfig {
  const setIds = board.setIds
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return {
    boardName: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds,
    angle,
  };
}

/**
 * Resolve a `BoardConfig` back to full `BoardDetails` (hold positions, images,
 * edges). Returns `null` if the config refers to a board/layout we can't
 * resolve locally (e.g. malformed data).
 */
export function boardConfigToBoardDetails(cfg: BoardConfig): BoardDetails | null {
  try {
    return getBoardDetailsForBoard({
      board_name: cfg.boardName,
      layout_id: cfg.layoutId,
      size_id: cfg.sizeId,
      set_ids: cfg.setIds,
    });
  } catch {
    return null;
  }
}

export function boardConfigToBaseBoardPath(cfg: BoardConfig): string {
  const setIds = [...cfg.setIds].sort((a, b) => a - b).join(',');
  if (cfg.boardName === 'moonboard') {
    return `/moonboard/${cfg.layoutId}/${setIds}`;
  }
  return `/${cfg.boardName}/${cfg.layoutId}/${cfg.sizeId}/${setIds}`;
}

export function boardConfigEquals(a?: BoardConfig | null, b?: BoardConfig | null): boolean {
  if (!a || !b) return a === b;
  if (a.boardName !== b.boardName) return false;
  if (a.layoutId !== b.layoutId) return false;
  if (a.sizeId !== b.sizeId) return false;
  if (a.angle !== b.angle) return false;
  if (a.setIds.length !== b.setIds.length) return false;
  const aSorted = [...a.setIds].sort((x, y) => x - y);
  const bSorted = [...b.setIds].sort((x, y) => x - y);
  return aSorted.every((v, i) => v === bSorted[i]);
}

export type AddDecision =
  | { kind: 'allow' }
  | { kind: 'confirm'; reason: 'new_config' | 'larger_size' };

/**
 * Decide whether an incoming `BoardConfig` can be added silently, or needs the
 * user's explicit confirmation.
 *
 * 1. Empty queue → `allow` (first climb seeds the accepted set).
 * 2. Key not yet accepted → `confirm: new_config`.
 * 3. Key accepted but the incoming size is larger than any size seen before
 *    for that key → `confirm: larger_size` (the hold layout for the larger
 *    board may not fit the smaller boards already in the queue).
 * 4. Otherwise → `allow`.
 */
export function decideAdd(
  incoming: BoardConfig,
  accepted: Set<ConfigKey>,
  acceptedSizes: Map<ConfigKey, number[]>,
): AddDecision {
  if (accepted.size === 0) return { kind: 'allow' };
  const key = configKey(incoming);
  if (!accepted.has(key)) return { kind: 'confirm', reason: 'new_config' };
  const sizes = acceptedSizes.get(key);
  if (!sizes || sizes.length === 0) return { kind: 'allow' };
  const maxSize = Math.max(...sizes);
  if (incoming.sizeId > maxSize) return { kind: 'confirm', reason: 'larger_size' };
  return { kind: 'allow' };
}

/**
 * Backfill a queue item with a fallback `BoardConfig` when the item predates
 * the multi-board queue work (legacy payloads from older clients). Also
 * stamps `climb.boardType` / `climb.layoutId` so downstream UI never has to
 * reach back into the queue item for those fields.
 */
export function normalizeQueueItem(
  item: ClimbQueueItem,
  fallback: BoardConfig | null,
): ClimbQueueItem {
  if (item.boardConfig) return item;
  if (!fallback) return item;
  return {
    ...item,
    boardConfig: fallback,
    climb: {
      ...item.climb,
      boardType: item.climb.boardType ?? fallback.boardName,
      layoutId: item.climb.layoutId ?? fallback.layoutId,
    },
  };
}

/**
 * Dedupe the `boardConfig` entries present in a queue. Preserves first-seen
 * order so the first item becomes the primary board when no better signal
 * exists.
 *
 * Dedupe key intentionally excludes `angle` — angle is a per-climb choice,
 * not a distinct physical board. Two items on the same hold layout at 40deg
 * and 45deg should count as one board.
 */
export function deriveBoardsFromQueue(items: readonly ClimbQueueItem[]): BoardConfig[] {
  const seen = new Set<string>();
  const boards: BoardConfig[] = [];
  for (const item of items) {
    const cfg = item.boardConfig;
    if (!cfg) continue;
    const setIds = [...cfg.setIds].sort((a, b) => a - b).join(',');
    const key = `${cfg.boardName}|${cfg.layoutId}|${cfg.sizeId}|${setIds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    boards.push(cfg);
  }
  return boards;
}

/**
 * Reconstruct the accepted-configs + accepted-sizes pair from a queue. Used
 * on reducer bootstrap (INITIAL_QUEUE_DATA / UPDATE_QUEUE) and as the source
 * of truth for the bridge context.
 */
export function deriveAcceptedConfigs(
  items: readonly ClimbQueueItem[],
): { accepted: Set<ConfigKey>; acceptedSizes: Map<ConfigKey, number[]> } {
  const accepted = new Set<ConfigKey>();
  const acceptedSizes = new Map<ConfigKey, number[]>();
  for (const item of items) {
    const cfg = item.boardConfig;
    if (!cfg) continue;
    const key = configKey(cfg);
    accepted.add(key);
    const existing = acceptedSizes.get(key);
    if (!existing) {
      acceptedSizes.set(key, [cfg.sizeId]);
    } else if (!existing.includes(cfg.sizeId)) {
      existing.push(cfg.sizeId);
    }
  }
  return { accepted, acceptedSizes };
}

/**
 * `BoardName` narrowing helper for use at the type boundary between
 * `BoardConfig.boardName` (plain string) and route/config helpers that expect
 * the narrower `BoardName` union.
 */
export function asBoardName(name: string): BoardName {
  return name as BoardName;
}
