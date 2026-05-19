import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { BoardHistoryEntry } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@/app/components/queue-control/types';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

let mockBoardSerial: string | null = 'serial-A';
let mockLatestEntry: BoardHistoryEntry | null = null;
let mockDivergent = false;
let mockLocalPick: ClimbQueueItem | null = null;
let mockIsBluetoothConnected = false;
const mockSendLocalPick = vi.fn();
let mockSessionUserId: string | null = null;

vi.mock('../use-board-history', () => ({
  useBoardHistory: () => ({
    history: mockLatestEntry ? [mockLatestEntry] : [],
    latestEntry: mockLatestEntry,
    boardSerial: mockBoardSerial,
    isLoading: false,
    isSubscribed: true,
  }),
}));

vi.mock('../use-board-vs-local-divergence', () => ({
  useBoardVsLocalDivergence: () => ({
    boardCurrent: mockLatestEntry,
    localPick: mockLocalPick,
    divergent: mockDivergent,
  }),
}));

vi.mock('../use-send-local-pick', () => ({
  useSendLocalPick: () => ({
    sendLocalPick: mockSendLocalPick,
  }),
}));

vi.mock('@/app/components/board-bluetooth-control/bluetooth-status-store', () => ({
  useBluetoothConnectedStatus: () => mockIsBluetoothConnected,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: mockSessionUserId ? { user: { id: mockSessionUserId } } : null,
    status: mockSessionUserId ? 'authenticated' : 'unauthenticated',
  }),
}));

import CurrentlyOnBoardHeader from '../currently-on-board-header';

function makeEntry(overrides: Partial<BoardHistoryEntry> = {}): BoardHistoryEntry {
  return {
    id: 'row-1',
    uuid: 'send-uuid-1',
    boardSerial: 'serial-A',
    boardId: null,
    climbUuid: 'climb-A',
    angle: 40,
    isMirror: false,
    source: 'BLE_SEND',
    userId: 'user-other',
    username: 'Sarah',
    sessionId: null,
    sentAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    sequence: 1,
    ...overrides,
  };
}

function makeQueueItem(climbUuid: string, name: string): ClimbQueueItem {
  return {
    uuid: 'queue-item-1',
    addedBy: 'user-1',
    suggested: false,
    climb: {
      uuid: climbUuid,
      setter_username: 'setter',
      name,
      description: '',
      frames: '',
      angle: 40,
      ascensionist_count: 0,
      difficulty: 'V4',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0.00',
      mirrored: false,
      benchmark_difficulty: null,
    },
  };
}

describe('CurrentlyOnBoardHeader', () => {
  beforeEach(() => {
    mockBoardSerial = 'serial-A';
    mockLatestEntry = null;
    mockDivergent = false;
    mockLocalPick = null;
    mockIsBluetoothConnected = false;
    mockSessionUserId = null;
    mockSendLocalPick.mockReset();
  });

  it('renders the "Pair a board" empty state when boardSerial is null', () => {
    mockBoardSerial = null;
    render(<CurrentlyOnBoardHeader />);
    expect(screen.getByText("Pair a board to see what's on the wall")).toBeDefined();
  });

  it('renders the "Nothing\'s been on the wall yet" empty state when latestEntry is null', () => {
    mockBoardSerial = 'serial-A';
    mockLatestEntry = null;
    render(<CurrentlyOnBoardHeader />);
    expect(screen.getByText("Nothing's been on the wall yet")).toBeDefined();
  });

  it('renders a single-line attribution when not divergent', () => {
    mockLatestEntry = makeEntry();
    mockDivergent = false;
    render(<CurrentlyOnBoardHeader />);
    // Attribution text always starts with "Sent by " for non-self entries.
    const matches = screen.getAllByText(/Sent by Sarah/);
    expect(matches.length).toBeGreaterThan(0);
    expect(screen.queryByText('Send your pick')).toBeNull();
  });

  it('renders the "Send your pick" CTA when divergent and BLE-connected', () => {
    mockLatestEntry = makeEntry();
    mockLocalPick = makeQueueItem('climb-B', 'My Project');
    mockDivergent = true;
    mockIsBluetoothConnected = true;
    render(<CurrentlyOnBoardHeader />);
    expect(screen.getByText('Send your pick')).toBeDefined();
    expect(screen.getByText('My Project')).toBeDefined();
  });

  it('omits the "Send your pick" CTA when divergent but NOT BLE-connected', () => {
    mockLatestEntry = makeEntry();
    mockLocalPick = makeQueueItem('climb-B', 'My Project');
    mockDivergent = true;
    mockIsBluetoothConnected = false;
    render(<CurrentlyOnBoardHeader />);
    expect(screen.queryByText('Send your pick')).toBeNull();
  });

  it('invokes sendLocalPick when the CTA is clicked', () => {
    mockLatestEntry = makeEntry();
    mockLocalPick = makeQueueItem('climb-B', 'My Project');
    mockDivergent = true;
    mockIsBluetoothConnected = true;
    render(<CurrentlyOnBoardHeader />);
    fireEvent.click(screen.getByText('Send your pick'));
    expect(mockSendLocalPick).toHaveBeenCalledTimes(1);
  });

  it('uses the self-attribution copy when the sender is the current user', () => {
    mockSessionUserId = 'user-mine';
    mockLatestEntry = makeEntry({ userId: 'user-mine', username: 'Marco' });
    mockDivergent = false;
    render(<CurrentlyOnBoardHeader />);
    expect(screen.getByText(/You sent this/)).toBeDefined();
  });
});
