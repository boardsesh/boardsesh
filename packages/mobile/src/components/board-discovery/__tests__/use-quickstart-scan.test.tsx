// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { QuickstartScanDevice } from '../../../lib/ble/quickstart-scan-device';
import { decidePickerTop, type PickerTopLead } from '../picker-top-view';

// The In range slot through a whole scan at a gym with more than one box. The
// serial lookup is keyed on every serial heard, so each new serial starts it
// over with no answer. A board already drawn must stay drawn through that:
// a Kilter heard across the gym used to drop the hero back to "Looking", and
// Climb here went from under the climber's thumb.

type SerialHeard = { serial: string; boardType: 'kilter' | 'tension'; rssi: number };

// What the radio has heard so far, as the scan hands it on: new arrays only
// when a box is heard. The test adds to it and re-renders.
const radio = vi.hoisted(() => ({
  serials: [] as string[],
  devices: [] as QuickstartScanDevice[],
  advertisedTypes: new Map<string, string>(),
  start: () => {},
  reset: () => {},
  finish: () => {},
}));
vi.mock('../../../lib/ble/use-board-scan', () => ({
  useBoardScan: () => ({
    status: 'scanning',
    unavailableReason: null,
    serials: radio.serials,
    advertisedTypes: radio.advertisedTypes,
    devices: radio.devices,
    start: radio.start,
    reset: radio.reset,
    finish: radio.finish,
  }),
}));

// The serial lookup as the real hook makes it: one React Query entry per list
// of serials heard, no placeholder. Each answer waits until the test lands it.
const lookups = vi.hoisted(() => ({
  waiting: new Map<string, (boards: UserBoard[]) => void>(),
}));
vi.mock('../../../lib/graphql/hooks', async () => {
  const { useQuery } = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    useBoardsBySerialNumbers: (serialNumbers: string[]) =>
      useQuery({
        queryKey: ['boardsBySerialNumbers', serialNumbers],
        queryFn: () =>
          new Promise<UserBoard[]>((resolve) => {
            lookups.waiting.set(serialNumbers.join(','), resolve);
          }),
        enabled: serialNumbers.length > 0,
      }),
  };
});
vi.mock('../../../lib/ble/use-my-board-serial-configs', () => ({
  useMyBoardSerialConfigs: () => ({ data: [], isResolving: false }),
}));
vi.mock('../../../lib/ble/recognized-board-devices-store', () => ({
  useRecognizedBoardDevices: () => [],
  indexRecognizedBoardDevices: () => new Map(),
  normalizeBoardDeviceId: (deviceId: string) => deviceId.trim().toUpperCase(),
}));

const { useQuickstartScan } = await import('../use-quickstart-scan');

const CRUX = { gymUuid: 'gym-crux', gymName: 'Crux' };

function savedBoard(uuid: string, serialNumber: string, boardType: 'kilter' | 'tension'): UserBoard {
  return { uuid, name: uuid, serialNumber, boardType, ...CRUX } as unknown as UserBoard;
}

const HOME_KILTER = savedBoard('crux-kilter', 'K1', 'kilter');
const CRUX_TENSION = savedBoard('crux-tension', 'T2', 'tension');

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

/** The top of the picker mid-scan, for a climber on no board. */
function useInRangeSlot() {
  const scan = useQuickstartScan({ knownBoards: [] });
  const { lead } = decidePickerTop({ phase: 'scanning', rows: scan.rows, lookup: scan.lookup, activeBoard: null });
  return { lookup: scan.lookup, lead };
}

function summarize(lead: PickerTopLead): string {
  switch (lead.kind) {
    case 'hero':
      return `hero:${lead.board.uuid}`;
    case 'at_gym':
      return `at_gym:${lead.gymName}[${lead.heardBoards.map((board) => board.uuid).join(',')}]`;
    default:
      return lead.kind;
  }
}

/** React Query hands a result on through a zero-delay timer: let those run. */
async function settle() {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function land(serials: string[], boards: UserBoard[]) {
  const answer = lookups.waiting.get(serials.join(','));
  if (!answer) throw new Error(`No lookup out for ${serials.join(',')}`);
  await act(async () => {
    answer(boards);
    await settle();
  });
}

async function hear({ serial, boardType, rssi }: SerialHeard, rerender: () => void) {
  radio.serials = [...radio.serials, serial];
  radio.advertisedTypes = new Map([...radio.advertisedTypes, [serial, boardType]]);
  radio.devices = [
    ...radio.devices,
    {
      key: `serial:${serial}`,
      deviceId: `id-${serial}`,
      name: `Board#${serial}@3`,
      kind: 'serial',
      serial,
      boardType,
      rssi,
    },
  ];
  await act(async () => {
    rerender();
    await settle();
  });
}

/**
 * Scan again: the radio drops what it heard. `rendersEmptyStart` false is a
 * start whose empty lists React folded into the next box heard, so no render
 * ever saw the scan empty.
 */
async function scanAgain({ rendersEmptyStart }: { rendersEmptyStart: boolean }, rerender: () => void) {
  radio.serials = [];
  radio.devices = [];
  radio.advertisedTypes = new Map();
  if (!rendersEmptyStart) return;
  await act(async () => {
    rerender();
    await settle();
  });
}

beforeEach(() => {
  radio.serials = [];
  radio.devices = [];
  radio.advertisedTypes = new Map();
  lookups.waiting.clear();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('useQuickstartScan through a scan that hears a second box', () => {
  it('keeps the hero while a new serial is looked up, then lists the gym both are at', async () => {
    const { result, rerender } = renderHook(useInRangeSlot, { wrapper });

    // The first serial: nothing drawn yet, so the slot holds its place.
    await hear({ serial: 'K1', boardType: 'kilter', rssi: -45 }, rerender);
    expect(result.current.lookup).toBe('pending');
    expect(summarize(result.current.lead)).toBe('looking');

    await land(['K1'], [HOME_KILTER]);
    expect(result.current.lookup).toBe('resolved');
    expect(summarize(result.current.lead)).toBe('hero:crux-kilter');

    // A Tension across the gym: the lookup starts over for both serials. The
    // hero stays where it is.
    await hear({ serial: 'T2', boardType: 'tension', rssi: -70 }, rerender);
    expect(result.current.lookup).toBe('updating');
    expect(summarize(result.current.lead)).toBe('hero:crux-kilter');

    // Its answer lands: two walls at Crux, so the top is At Crux.
    await land(['K1', 'T2'], [HOME_KILTER, CRUX_TENSION]);
    expect(result.current.lookup).toBe('resolved');
    expect(summarize(result.current.lead)).toBe('at_gym:Crux[crux-kilter,crux-tension]');
  });

  it('never says a serial heard since is unknown before its own answer lands', async () => {
    const { result, rerender } = renderHook(useInRangeSlot, { wrapper });
    await hear({ serial: 'K1', boardType: 'kilter', rssi: -45 }, rerender);
    await land(['K1'], [HOME_KILTER]);

    // A closer Tension: still being looked up, so no "We don't know its setup"
    // row may take the lead from the hero.
    await hear({ serial: 'T2', boardType: 'tension', rssi: -30 }, rerender);
    expect(summarize(result.current.lead)).toBe('hero:crux-kilter');

    await land(['K1', 'T2'], [HOME_KILTER, CRUX_TENSION]);
    expect(summarize(result.current.lead)).toBe('at_gym:Crux[crux-tension,crux-kilter]');
  });

  // The last scan's Kilter must not lead the next scan before its own first
  // answer lands: the Tension that answer names changes what leads, and the
  // hero would go from under the climber's thumb.
  it.each([{ rendersEmptyStart: true }, { rendersEmptyStart: false }])(
    'waits for the first answer of a new scan that hears another box and then the last one (empty start rendered: $rendersEmptyStart)',
    async ({ rendersEmptyStart }) => {
      const { result, rerender } = renderHook(useInRangeSlot, { wrapper });
      await hear({ serial: 'K1', boardType: 'kilter', rssi: -45 }, rerender);
      await land(['K1'], [HOME_KILTER]);
      expect(summarize(result.current.lead)).toBe('hero:crux-kilter');

      await scanAgain({ rendersEmptyStart }, rerender);
      await hear({ serial: 'T2', boardType: 'tension', rssi: -30 }, rerender);
      expect(result.current.lookup).toBe('pending');
      expect(summarize(result.current.lead)).toBe('looking');

      await hear({ serial: 'K1', boardType: 'kilter', rssi: -45 }, rerender);
      expect(result.current.lookup).toBe('pending');
      expect(summarize(result.current.lead)).toBe('looking');

      await land(['T2', 'K1'], [CRUX_TENSION, HOME_KILTER]);
      expect(result.current.lookup).toBe('resolved');
      expect(summarize(result.current.lead)).toBe('at_gym:Crux[crux-tension,crux-kilter]');
    },
  );
});
