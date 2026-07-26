/**
 * A single-try ascent must log cleanly. The form used to block submit when a
 * send had <= 1 attempt (#3938), under a comment claiming the rule mirrored
 * the backend — it doesn't: `SaveTickInputSchema` floors `attemptCount` at 1
 * for every status and constrains only flash.
 *
 * That branch was unreachable through this form, because status is derived
 * from the count (`getAscentStatus`: 1 => flash, else send), so
 * `status === 'send'` already implied `attempts !== 1`. These tests therefore
 * pin the user-visible contract rather than the deleted branch: one try
 * submits with no validation banner, and the count reaches saveTick intact.
 *
 * The realistic re-introduction is a guard keyed on the raw count instead of
 * the status (`if (values.attempts <= 1) ...`), which would block the default
 * form state outright. That is what fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import type { BoardDetails, BoardName, Climb } from '@/app/lib/types';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockSaveTick = vi.fn();

vi.mock('../../board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({
    saveTick: mockSaveTick,
    logbook: [],
    boardName: 'kilter' as BoardName,
    isAuthenticated: true,
    isLoading: false,
    error: null,
    isInitialized: true,
    getLogbook: vi.fn(),
    saveClimb: vi.fn(),
  }),
}));

vi.mock('../../board-presence/board-presence-context', () => ({
  useBoardPresenceControls: () => ({
    enabled: false,
    boardId: null,
    resolveAndBindBoard: vi.fn(),
  }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/hooks/use-effective-angle', () => ({
  useEffectiveAngle: () => 40,
}));

vi.mock('../../graphql-queue/QueueContext', () => ({
  useOptionalCurrentClimb: () => null,
}));

const { LogAscentForm } = await import('../logascent-form');

function makeClimb(): Climb {
  return {
    uuid: 'climb-1',
    name: 'One Go',
    difficulty: 'V5',
    frames: 'p1r42',
    quality_average: '3.5',
    angle: 40,
    ascensionist_count: 10,
    display_difficulty: 5,
    difficulty_average: 12.5,
    setter_username: 'setter',
  } as unknown as Climb;
}

function makeBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter' as BoardName,
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2],
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Full',
    set_names: ['Standard'],
    supportsMirroring: false,
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
  } as BoardDetails;
}

function renderForm(onClose = vi.fn()) {
  render(
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <LogAscentForm currentClimb={makeClimb()} boardDetails={makeBoardDetails()} onClose={onClose} />
    </LocalizationProvider>,
  );
  return onClose;
}

const submitButton = () => screen.getByRole('button', { name: /Log at 40°/i });

describe('LogAscentForm — a single try is a valid ascent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveTick.mockResolvedValue(undefined);
  });

  it('submits the default one-attempt ascent without a validation banner', async () => {
    const onClose = renderForm();

    fireEvent.click(submitButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockSaveTick).toHaveBeenCalledTimes(1);
    expect(mockSaveTick.mock.calls[0][0]).toMatchObject({ attemptCount: 1, status: 'flash' });
  });

  it('logs a multi-try ascent as a send with the count it was given', async () => {
    const onClose = renderForm();

    fireEvent.change(screen.getByLabelText('Attempts'), { target: { value: '2' } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockSaveTick.mock.calls[0][0]).toMatchObject({ attemptCount: 2, status: 'send' });
  });
});
