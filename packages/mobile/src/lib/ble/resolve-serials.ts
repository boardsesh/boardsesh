import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { parseSerialNumber } from '@boardsesh/ble-protocol';
import {
  GET_BOARDS_BY_SERIAL_NUMBERS,
  GET_MY_BOARD_SERIAL_CONFIGS,
  type BoardSerialConfig,
  type GetBoardsBySerialNumbersQueryResponse,
  type GetMyBoardSerialConfigsQueryResponse,
} from '@boardsesh/graphql/operations';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getAuthToken } from '../auth-store';
import { getHttpClient } from '../graphql/client';
import { useAuthToken } from '../graphql/use-auth-token';
import type { DiscoveredDevice } from './types';

export type ResolvedBoardEntry = { kind: 'saved'; board: UserBoard } | { kind: 'recorded'; config: BoardSerialConfig };

const MAX_SERIALS_PER_REQUEST = 20;
const EMPTY_RESOLVED_BOARDS = new Map<string, ResolvedBoardEntry>();

export function serialsFromDiscoveredDevices(devices: ReadonlyArray<DiscoveredDevice>): string[] {
  const serials = new Set<string>();
  for (const device of devices) {
    const serial = parseSerialNumber(device.name);
    if (serial) serials.add(serial);
    if (serials.size >= MAX_SERIALS_PER_REQUEST) break;
  }
  return [...serials];
}

export async function resolveBleSerialNumbers(
  serialNumbers: string[],
  providedAuthToken?: string | null,
): Promise<Map<string, ResolvedBoardEntry>> {
  const uniqueSerialNumbers = [
    ...new Set(serialNumbers.filter((serialNumber) => serialNumber.trim().length > 0)),
  ].slice(0, MAX_SERIALS_PER_REQUEST);
  if (uniqueSerialNumbers.length === 0) return new Map();

  const client = getHttpClient();
  const authToken = providedAuthToken === undefined ? await getAuthToken() : providedAuthToken;
  const recordedRequest = authToken
    ? client
        .request<GetMyBoardSerialConfigsQueryResponse>(GET_MY_BOARD_SERIAL_CONFIGS, {
          serialNumbers: uniqueSerialNumbers,
        })
        .catch(() => ({ myBoardSerialConfigs: [] as BoardSerialConfig[] }))
    : Promise.resolve({ myBoardSerialConfigs: [] as BoardSerialConfig[] });

  const [savedResult, recordedResult] = await Promise.all([
    client
      .request<GetBoardsBySerialNumbersQueryResponse>(GET_BOARDS_BY_SERIAL_NUMBERS, {
        serialNumbers: uniqueSerialNumbers,
      })
      .catch(() => ({ boardsBySerialNumbers: [] as UserBoard[] })),
    recordedRequest,
  ]);

  const resolvedBoards = new Map<string, ResolvedBoardEntry>();
  for (const board of savedResult.boardsBySerialNumbers) {
    if (board.serialNumber) {
      resolvedBoards.set(board.serialNumber, { kind: 'saved', board });
    }
  }
  for (const config of recordedResult.myBoardSerialConfigs) {
    if (!resolvedBoards.has(config.serialNumber)) {
      resolvedBoards.set(config.serialNumber, { kind: 'recorded', config });
    }
  }
  return resolvedBoards;
}

export function useResolvedBleDeviceBoards(devices: ReadonlyArray<DiscoveredDevice>): Map<string, ResolvedBoardEntry> {
  // The devices array gets a fresh identity on every material scan update
  // (new device, late-arriving name), most of which add no new serial. Key the
  // serials memo on their joined string so the array reference — and with it
  // the query key — only changes when the serial set actually does. (TanStack
  // hashes keys structurally, so this is render/memo hygiene rather than a
  // network-request fix.) '@' is a safe delimiter: parseSerialNumber matches
  // `/#([^@]+)/`, so a serial can never contain it.
  const serialNumbersKey = useMemo(() => serialsFromDiscoveredDevices(devices).join('@'), [devices]);
  const serialNumbers = useMemo(
    () => (serialNumbersKey.length > 0 ? serialNumbersKey.split('@') : []),
    [serialNumbersKey],
  );
  const authTokenQuery = useAuthToken();
  const authToken = authTokenQuery.data;
  const { data } = useQuery({
    queryKey: ['bleDeviceSerials', authToken ?? null, serialNumbers],
    queryFn: () => resolveBleSerialNumbers(serialNumbers, authToken ?? null),
    enabled: serialNumbers.length > 0 && authToken !== undefined,
    staleTime: 30_000,
  });
  return data ?? EMPTY_RESOLVED_BOARDS;
}
