/**
 * Regression: 0° is a real selectable angle on vertical-board configs
 * (Kilter / Tension / Decoy / Touchstone all list 0 in `ANGLES`). The
 * group-session feedback fix had to walk through three rounds before
 * the form stopped treating `!formValues.angle` as "missing" — this
 * test pins the behaviour so it can't regress silently again.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import type { BoardDetails, BoardName, Climb } from '@/app/lib/types';
import type { LogbookEntry } from '@boardsesh/board-react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockSaveTick = vi.fn();
const mockLogbookRef: { current: LogbookEntry[] } = { current: [] };
const mockPresenceControls = vi.hoisted(() => ({ boardId: null as number | null }));

vi.mock('../../board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({
    saveTick: mockSaveTick,
    logbook: mockLogbookRef.current,
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
    enabled: mockPresenceControls.boardId !== null,
    boardId: mockPresenceControls.boardId,
    resolveAndBindBoard: vi.fn(),
  }),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

// The hook ships from `@/app/hooks/use-effective-angle`. Mock it directly
// so the form sees whatever angle this test wants regardless of bridge /
// queue context state.
const mockEffectiveAngle: { current: number | null } = { current: null };
vi.mock('@/app/hooks/use-effective-angle', () => ({
  useEffectiveAngle: () => mockEffectiveAngle.current,
}));

// The wall-drift banner reads `useOptionalCurrentClimb` from the queue
// context — return null so the banner stays hidden and doesn't add
// noise to the 0°-specific assertions.
vi.mock('../../graphql-queue/QueueContext', () => ({
  useOptionalCurrentClimb: () => null,
}));

const { LogAscentForm } = await import('../logascent-form');

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    name: '0° Vertical Send',
    difficulty: 'V5',
    frames: 'p1r42',
    quality_average: '3.5',
    // `angle` on the climb record is intentionally null here — the form
    // must source from `useEffectiveAngle`, not fall back to the climb's
    // stored angle for "is 0 really a value here?" disambiguation.
    angle: 0,
    ascensionist_count: 10,
    display_difficulty: 5,
    difficulty_average: 12.5,
    setter_username: 'setter',
    ...overrides,
  } as Climb;
}

function makeBoardDetails(overrides: Partial<BoardDetails> = {}): BoardDetails {
  return {
    board_name: 'kilter' as BoardName,
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2],
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Full',
    set_names: ['Standard'],
    supportsMirroring: true,
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
    boardHeight: 100,
    boardWidth: 100,
    ...overrides,
  } as BoardDetails;
}

function renderForm(props: React.ComponentProps<typeof LogAscentForm>) {
  return render(
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <LogAscentForm {...props} />
    </LocalizationProvider>,
  );
}

describe('LogAscentForm — 0° regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogbookRef.current = [];
    mockSaveTick.mockResolvedValue(undefined);
    mockEffectiveAngle.current = null;
    mockPresenceControls.boardId = null;
  });

  it('enables submit and shows the angle when useEffectiveAngle resolves to 0', () => {
    mockEffectiveAngle.current = 0;

    renderForm({ currentClimb: makeClimb(), boardDetails: makeBoardDetails(), onClose: vi.fn() });

    // Submit button shows the resolved angle, not the default fallback.
    const submitButton = screen.getByRole('button', { name: /Log at 0°/i }) as HTMLButtonElement;
    expect(submitButton).toBeTruthy();
    expect(submitButton.disabled).toBe(false);
  });

  it('persists 0° on submit (does not coerce null/0 through Number())', async () => {
    mockEffectiveAngle.current = 0;
    const onClose = vi.fn();

    renderForm({ currentClimb: makeClimb(), boardDetails: makeBoardDetails(), onClose });

    fireEvent.click(screen.getByRole('button', { name: /Log at 0°/i }));

    await waitFor(() => expect(mockSaveTick).toHaveBeenCalled());
    expect(mockSaveTick.mock.calls[0][0]).toMatchObject({
      climbUuid: 'climb-1',
      // The payload must carry numeric 0, not `null`, not coerced from
      // an empty string. The form's saveTick call was changed from
      // `Number(values.angle)` to `values.angle` once the field became
      // `number | null` — this assertion catches a regression to the
      // coercion path.
      angle: 0,
    });
  });

  it('stamps the active presence board id when logging from the full form', async () => {
    mockEffectiveAngle.current = 0;
    mockPresenceControls.boardId = 77;
    const onClose = vi.fn();

    renderForm({ currentClimb: makeClimb(), boardDetails: makeBoardDetails(), onClose });

    fireEvent.click(screen.getByRole('button', { name: /Log at 0°/i }));

    await waitFor(() => expect(mockSaveTick).toHaveBeenCalled());
    expect(mockSaveTick.mock.calls[0][0]).toMatchObject({
      climbUuid: 'climb-1',
      boardId: 77,
    });
  });

  it('disables submit when no angle resolved (null), with the helper text spelled out', () => {
    mockEffectiveAngle.current = null;

    renderForm({
      currentClimb: makeClimb({ angle: undefined as unknown as number }),
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
    });

    // useEffectiveAngle returned null AND the form should not fall back
    // to climb.angle for the initial value (the bridge angle already had
    // a chance to resolve via the hook). Submit must be disabled.
    const submit = screen.getByRole('button', { name: /Submit/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // The "Pick an angle" copy renders in two places when the field is in
    // error: the disabled placeholder MenuItem and the FormHelperText
    // below the Select. Both are intentional. Assert at least one is in
    // the document.
    expect(screen.queryAllByText(/Pick an angle/i).length).toBeGreaterThan(0);
  });
});
