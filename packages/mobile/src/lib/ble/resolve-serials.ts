import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { parseBoardTypeFromDeviceName, parseSerialNumber } from '@boardsesh/ble-protocol';
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

/**
 * The board type each discovered serial advertises, read straight from the BLE
 * device name (`Tension Board#12345@3`).
 *
 * Aurora numbers each board app separately, so a serial identifies a controller
 * only WITHIN a type: a Kilter `#12345` and a Tension `#12345` are different
 * hardware. The advertised name is the only trustworthy signal about the box in
 * front of the climber, so it decides which resolved board may claim a serial.
 *
 * Serials whose name carries no recognisable type are absent from the map, and
 * are left unfiltered — an unknown type must not throw away a real match.
 */
export function advertisedBoardTypesBySerial(devices: ReadonlyArray<DiscoveredDevice>): Map<string, string> {
  const advertisedTypes = new Map<string, string>();
  for (const device of devices) {
    const serial = parseSerialNumber(device.name);
    if (!serial || advertisedTypes.has(serial)) continue;
    const boardType = parseBoardTypeFromDeviceName(device.name);
    if (boardType) advertisedTypes.set(serial, boardType);
  }
  return advertisedTypes;
}

/**
 * The single board type to scope the request to, or undefined when the scan is
 * mixed (or nothing advertised a type). A mixed scan can't be narrowed with one
 * argument, so it goes out unscoped and `matchesAdvertisedType` filters the
 * response per serial.
 */
function sharedAdvertisedBoardType(advertisedTypes: ReadonlyMap<string, string>): string | undefined {
  const distinctTypes = new Set(advertisedTypes.values());
  return distinctTypes.size === 1 ? [...distinctTypes][0] : undefined;
}

/**
 * Whether a resolved entry describes hardware of the type this serial
 * advertised. Unknown on either side means "can't tell" — keep the entry, since
 * dropping it would lose a board the picker could otherwise name.
 */
function matchesAdvertisedType(
  serialNumber: string,
  entry: ResolvedBoardEntry,
  advertisedTypes: ReadonlyMap<string, string>,
): boolean {
  const advertisedType = advertisedTypes.get(serialNumber);
  if (!advertisedType) return true;
  const entryBoardType = entry.kind === 'saved' ? entry.board.boardType : entry.config.boardName;
  if (!entryBoardType) return true;
  return entryBoardType === advertisedType;
}

export async function resolveBleSerialNumbers(
  serialNumbers: string[],
  providedAuthToken?: string | null,
  advertisedTypes: ReadonlyMap<string, string> = new Map(),
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
        // Narrows the query when the whole scan advertises one type, which is
        // the usual case. It only reduces what comes back — the per-serial
        // filter below is what actually enforces the rule, so a mixed scan (or
        // an older backend that ignores the argument) is still correct.
        boardType: sharedAdvertisedBoardType(advertisedTypes),
      })
      .catch(() => ({ boardsBySerialNumbers: [] as UserBoard[] })),
    recordedRequest,
  ]);

  const resolvedBoards = new Map<string, ResolvedBoardEntry>();
  for (const board of savedResult.boardsBySerialNumbers) {
    if (!board.serialNumber) continue;
    const entry: ResolvedBoardEntry = { kind: 'saved', board };
    // A board of another type shares nothing but the number with the controller
    // that just advertised. Letting it in is what made a Tension box at
    // Benchmark Climbing render — and behave — as a stranger's Kilter board.
    if (!matchesAdvertisedType(board.serialNumber, entry, advertisedTypes)) continue;
    resolvedBoards.set(board.serialNumber, entry);
  }
  for (const config of recordedResult.myBoardSerialConfigs) {
    if (resolvedBoards.has(config.serialNumber)) continue;
    const entry: ResolvedBoardEntry = { kind: 'recorded', config };
    if (!matchesAdvertisedType(config.serialNumber, entry, advertisedTypes)) continue;
    resolvedBoards.set(config.serialNumber, entry);
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
  // Rebuilt whenever `devices` changes identity, which is cheap and keeps the
  // map in step with late-arriving device names. Only the sorted entries below
  // reach the query key, so this churn never refetches on its own.
  const advertisedTypes = useMemo(() => advertisedBoardTypesBySerial(devices), [devices]);
  // A serial's advertised type can arrive after the serial itself (the name
  // lands late), and it changes which board may claim that serial — so it has
  // to key the cache, not just the request. Sorted for a stable hash.
  const advertisedTypeEntries = useMemo(
    () => [...advertisedTypes].sort(([first], [second]) => first.localeCompare(second)),
    [advertisedTypes],
  );
  const authTokenQuery = useAuthToken();
  const authToken = authTokenQuery.data;
  const { data } = useQuery({
    queryKey: ['bleDeviceSerials', authToken ?? null, serialNumbers, advertisedTypeEntries],
    queryFn: () => resolveBleSerialNumbers(serialNumbers, authToken ?? null, advertisedTypes),
    enabled: serialNumbers.length > 0 && authToken !== undefined,
    staleTime: 30_000,
  });
  return data ?? EMPTY_RESOLVED_BOARDS;
}
