/**
 * Wall-drift banner tests — the "Wall moved to {X}. Still logging {Y}?"
 * Alert that protects mid-log users from losing their draft when the
 * driver advances the queue underneath them (PR #2238, Fix 3). The
 * `window.confirm` path in particular is easy to break silently — a
 * regression to "Switch silently discards notes" or "Switch never fires
 * onSwitchClimb when dirty" would only surface in a real party session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('@/app/hooks/use-effective-angle', () => ({
  useEffectiveAngle: () => 40,
}));

// Drift is gated on `useOptionalCurrentClimb` returning a climb whose
// uuid differs from the form's locked climb. The mock is set per-test
// via the `mockWallClimbItem` cell.
const mockWallClimbItem: { current: { climb: Climb } | null } = { current: null };
vi.mock('../../graphql-queue/QueueContext', () => ({
  useOptionalCurrentClimb: () => ({
    currentClimbQueueItem: mockWallClimbItem.current,
  }),
}));

const { LogAscentForm } = await import('../logascent-form');

function makeClimb(uuid: string, name: string, overrides: Partial<Climb> = {}): Climb {
  return {
    uuid,
    name,
    difficulty: 'V5',
    frames: 'p1r42',
    quality_average: '3.5',
    angle: 40,
    ascensionist_count: 10,
    display_difficulty: 5,
    difficulty_average: 12.5,
    setter_username: 'setter',
    ...overrides,
  } as Climb;
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
    supportsMirroring: true,
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

function renderForm(props: React.ComponentProps<typeof LogAscentForm>) {
  return render(
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <LogAscentForm {...props} />
    </LocalizationProvider>,
  );
}

describe('LogAscentForm — wall-drift banner', () => {
  const lockedClimb = makeClimb('climb-A', 'Locked Climb A');
  const newWallClimb = makeClimb('climb-B', 'New Wall Climb B');

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogbookRef.current = [];
    mockSaveTick.mockResolvedValue(undefined);
    mockWallClimbItem.current = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not render the banner when the wall climb matches the locked climb', () => {
    mockWallClimbItem.current = { climb: lockedClimb };

    renderForm({ currentClimb: lockedClimb, boardDetails: makeBoardDetails(), onClose: vi.fn() });

    // No drift → no banner. Match the copy template against the climb
    // name to avoid false positives from other places the locked-climb
    // name appears (boulder row, submit button, etc.).
    expect(screen.queryByText(/Wall moved to/i)).toBeNull();
  });

  it('renders the banner with both climb names when the wall moves to a different climb', () => {
    mockWallClimbItem.current = { climb: newWallClimb };

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb: vi.fn(),
    });

    // Banner copy: "Wall moved to {wallClimb}. Still logging {loggingClimb}?"
    expect(screen.getByText(/Wall moved to.*New Wall Climb B.*Still logging.*Locked Climb A/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Switch to New Wall Climb B/i })).toBeTruthy();
  });

  it('dismisses the banner without switching when the close button is clicked', () => {
    mockWallClimbItem.current = { climb: newWallClimb };
    const onSwitchClimb = vi.fn();

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb,
    });

    // MUI Alert renders the close button with aria-label "Close" by default.
    const closeBtn = screen.getByRole('button', { name: /^Close$/i });
    fireEvent.click(closeBtn);

    expect(screen.queryByText(/Wall moved to/i)).toBeNull();
    expect(onSwitchClimb).not.toHaveBeenCalled();
  });

  it('calls onSwitchClimb with the wall climb when Switch is clicked and notes are empty', () => {
    mockWallClimbItem.current = { climb: newWallClimb };
    const onSwitchClimb = vi.fn();

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb,
    });

    fireEvent.click(screen.getByRole('button', { name: /Switch to New Wall Climb B/i }));

    // No dirty notes → no confirm prompt, switch fires immediately.
    expect(onSwitchClimb).toHaveBeenCalledTimes(1);
    expect(onSwitchClimb).toHaveBeenCalledWith(newWallClimb);
  });

  it('prompts window.confirm and calls onSwitchClimb when the user accepts (dirty notes path)', () => {
    mockWallClimbItem.current = { climb: newWallClimb };
    const onSwitchClimb = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb,
    });

    // Type into the notes field. The dirty check reads `formValues.notes`
    // length, so any non-empty string triggers the confirm prompt. The
    // Notes Typography label isn't `htmlFor`-associated with the input,
    // so `getByRole('textbox', { name: 'notes' })` doesn't resolve —
    // pick the multiline textarea by tag instead (only the Notes field
    // is multiline).
    const notesField = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(notesField).toBeTruthy();
    fireEvent.change(notesField, { target: { value: 'pinky-strenuous undercling' } });

    fireEvent.click(screen.getByRole('button', { name: /Switch to New Wall Climb B/i }));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/You'll lose what you typed/i));
    expect(onSwitchClimb).toHaveBeenCalledTimes(1);
    expect(onSwitchClimb).toHaveBeenCalledWith(newWallClimb);
  });

  it('aborts the switch when the user cancels the window.confirm prompt (dirty notes path)', () => {
    mockWallClimbItem.current = { climb: newWallClimb };
    const onSwitchClimb = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb,
    });

    const notesField = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(notesField).toBeTruthy();
    fireEvent.change(notesField, { target: { value: 'midway through writing beta' } });

    fireEvent.click(screen.getByRole('button', { name: /Switch to New Wall Climb B/i }));

    expect(confirmSpy).toHaveBeenCalledOnce();
    // User cancelled — onSwitchClimb must NOT be called, banner stays
    // visible, draft preserved.
    expect(onSwitchClimb).not.toHaveBeenCalled();
    expect(screen.getByText(/Wall moved to.*New Wall Climb B/i)).toBeTruthy();
  });

  // Dirty-detection regression tests — `isFormDirty` used to only check
  // notes, so editing any other field would silently slip past the
  // confirm prompt and lose the user's work when they hit Switch.
  // Each case below mutates exactly one non-notes field, then asserts
  // that the Switch button triggers `window.confirm`.

  it('prompts window.confirm when attempts is changed (dirty attempts path)', () => {
    mockWallClimbItem.current = { climb: newWallClimb };
    const onSwitchClimb = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb,
    });

    // The attempts field is the only `type="number"` TextField in the
    // form right now — pick it by selector rather than by label, which
    // isn't `htmlFor`-associated with the input.
    const attemptsField = document.querySelector('input[type="number"]') as HTMLInputElement;
    expect(attemptsField).toBeTruthy();
    fireEvent.change(attemptsField, { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: /Switch to New Wall Climb B/i }));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onSwitchClimb).toHaveBeenCalledTimes(1);
  });

  it('prompts window.confirm when quality is rated (dirty quality path)', () => {
    mockWallClimbItem.current = { climb: newWallClimb };
    const onSwitchClimb = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb,
    });

    // MUI Rating renders one radio per star labelled "<n> Stars" — pick
    // the 4-star one and click it to bump quality from 0 → 4.
    const fourStar = screen.getByRole('radio', { name: /4 Stars/i });
    fireEvent.click(fourStar);

    fireEvent.click(screen.getByRole('button', { name: /Switch to New Wall Climb B/i }));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onSwitchClimb).toHaveBeenCalledTimes(1);
  });

  it('prompts window.confirm when video URL is entered (dirty videoUrl path)', () => {
    mockWallClimbItem.current = { climb: newWallClimb };
    const onSwitchClimb = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb,
    });

    // The video field is the only single-line TextField with a URL
    // placeholder. Use the placeholder copy to locate it without
    // wiring up label associations. Boardsesh accepts Instagram /
    // TikTok beta links — value just needs to differ from '' to count
    // as dirty; URL validity isn't gating the Switch path.
    const videoField = screen.getByPlaceholderText(/instagram|tiktok/i) as HTMLInputElement;
    fireEvent.change(videoField, { target: { value: 'https://www.instagram.com/reel/abc123/' } });

    fireEvent.click(screen.getByRole('button', { name: /Switch to New Wall Climb B/i }));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onSwitchClimb).toHaveBeenCalledTimes(1);
  });

  it('prompts window.confirm when logType is switched to attempt (dirty logType path)', () => {
    mockWallClimbItem.current = { climb: newWallClimb };
    const onSwitchClimb = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      onSwitchClimb,
    });

    // Toggle from the default 'ascent' to 'attempt'. The
    // ToggleButtonGroup renders the labels as button text.
    fireEvent.click(screen.getByRole('button', { name: /^Attempt$/i }));

    fireEvent.click(screen.getByRole('button', { name: /Switch to New Wall Climb B/i }));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(onSwitchClimb).toHaveBeenCalledTimes(1);
  });

  it('does not render the Switch button when onSwitchClimb is not provided (graceful fallback)', () => {
    mockWallClimbItem.current = { climb: newWallClimb };

    renderForm({
      currentClimb: lockedClimb,
      boardDetails: makeBoardDetails(),
      onClose: vi.fn(),
      // onSwitchClimb intentionally omitted — older callers (or future
      // ones that don't snapshot at the drawer level) can still render
      // the banner without a switch action.
    });

    expect(screen.getByText(/Wall moved to/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Switch to/i })).toBeNull();
  });
});
