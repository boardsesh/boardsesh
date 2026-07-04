import { normaliseSetIds, toBoardName } from '@boardsesh/board-config';
import { parseSerialNumber } from '@boardsesh/ble-protocol';
import type { BoardName } from '@boardsesh/shared-schema';
import type { DiscoveredDevice } from './types';
import type { ResolvedBoardEntry } from './resolve-serials';

export type BleBoardConfig = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  boardSlug?: string | null;
};

export type PickerSelectionDecision =
  | { kind: 'forward' }
  | { kind: 'mismatch'; serial: string; config: BleBoardConfig; entry: ResolvedBoardEntry };

export function configFromResolvedEntry(entry: ResolvedBoardEntry): BleBoardConfig | undefined {
  if (entry.kind === 'saved') {
    const boardName = toBoardName(entry.board.boardType);
    if (!boardName) return undefined;
    return {
      boardName,
      layoutId: entry.board.layoutId,
      sizeId: entry.board.sizeId,
      setIds: entry.board.setIds,
      boardSlug: entry.board.slug,
    };
  }

  const boardName = toBoardName(entry.config.boardName);
  if (!boardName) return undefined;
  return {
    boardName,
    layoutId: entry.config.layoutId,
    sizeId: entry.config.sizeId,
    setIds: entry.config.setIds,
    boardSlug: entry.config.boardSlug,
  };
}

export function matchesBleBoardConfig(config: BleBoardConfig, currentConfig: BleBoardConfig | undefined): boolean {
  if (!currentConfig) return true;
  return (
    config.boardName === currentConfig.boardName &&
    config.layoutId === currentConfig.layoutId &&
    config.sizeId === currentConfig.sizeId &&
    normaliseSetIds(config.setIds) === normaliseSetIds(currentConfig.setIds)
  );
}

export function decideBlePickerSelection({
  deviceId,
  devices,
  resolvedBoards,
  currentBoardConfig,
}: {
  deviceId: string;
  devices: ReadonlyArray<DiscoveredDevice>;
  resolvedBoards: ReadonlyMap<string, ResolvedBoardEntry>;
  currentBoardConfig?: BleBoardConfig;
}): PickerSelectionDecision {
  const device = devices.find((candidateDevice) => candidateDevice.deviceId === deviceId);
  const serial = device ? parseSerialNumber(device.name) : undefined;
  if (!serial) return { kind: 'forward' };

  const resolvedEntry = resolvedBoards.get(serial);
  if (!resolvedEntry) return { kind: 'forward' };

  const config = configFromResolvedEntry(resolvedEntry);
  if (!config || matchesBleBoardConfig(config, currentBoardConfig)) return { kind: 'forward' };

  return { kind: 'mismatch', serial, config, entry: resolvedEntry };
}
