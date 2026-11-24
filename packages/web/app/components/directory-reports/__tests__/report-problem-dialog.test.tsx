import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import {
  boardSetupSummary,
  getBoardLayouts,
  getBoardSetsForLayoutAndSize,
  getBoardSizesForLayoutId,
  getDefaultBoardSizeForLayout,
  setupLayoutLabel,
  setupSizeLabel,
} from '@boardsesh/board-config';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import type { ReportBoardSetup, ReportProblemTarget } from '../report-problem-logic';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token' }),
}));

vi.mock('@/app/components/providers/session-provider', () => ({
  useOptionalBrowserSession: () => ({ data: { user: { id: 'viewer' } }, status: 'authenticated' }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

import ReportProblemDialog from '../report-problem-dialog';
import { REPORT_BOARD, REPORT_GYM } from '@boardsesh/graphql/operations';

// Real catalogue rows: a Kilter layout with two sizes, and a second layout.
const kilterLayout = getBoardLayouts('kilter').find(
  (layout) => getBoardSizesForLayoutId('kilter', layout.id).length >= 2,
);
if (!kilterLayout) throw new Error('Expected a Kilter layout with two sizes');
const [kilterSize, otherKilterSize] = getBoardSizesForLayoutId('kilter', kilterLayout.id);
const otherKilterLayout = getBoardLayouts('kilter').find(
  (layout) => layout.id !== kilterLayout.id && getDefaultBoardSizeForLayout('kilter', layout.id) != null,
);
if (!otherKilterLayout) throw new Error('Expected a second Kilter layout');
const setIdsOf = (layoutId: number, sizeId: number) =>
  getBoardSetsForLayoutAndSize('kilter', layoutId, sizeId).map((set) => set.id);

const kilterSetup: ReportBoardSetup = {
  boardType: 'kilter',
  layoutId: kilterLayout.id,
  sizeId: kilterSize.id,
  setIds: setIdsOf(kilterLayout.id, kilterSize.id).join(','),
  angle: 40,
  isAngleAdjustable: true,
};

const boardTarget: ReportProblemTarget = {
  kind: 'board',
  board: { uuid: 'board-1', name: 'Kilter', ownerId: 'sam', ownerDisplayName: null, setup: kilterSetup },
  gym: { uuid: 'gym-1', name: 'Crux', slug: 'crux', listingState: 'RUN_BY_GYM', canClaim: false },
  otherBoards: [{ uuid: 'board-2', label: 'Kilter · Original 12x12 · 40°' }],
};

/** The same board at a gym nobody runs, where a suggestion applies straight away. */
const unclaimedTarget: ReportProblemTarget = {
  ...boardTarget,
  gym: { uuid: 'gym-1', name: 'Crux', slug: 'crux', listingState: 'UNCLAIMED', canClaim: false },
};

const storeLabels: StoreButtonLabels = {
  ios: 'Download on the App Store',
  android: 'Get it on Google Play',
  update: 'Update the app',
  locale: 'en-US',
};

function renderDialog(
  target: ReportProblemTarget | null = boardTarget,
  options: {
    setupSuggestionsEnabled?: boolean;
    storeLabels?: StoreButtonLabels | null;
    onSetupApplied?: () => void;
  } = {},
) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ReportProblemDialog
        open
        onClose={vi.fn()}
        target={target}
        setupSuggestionsEnabled={options.setupSuggestionsEnabled}
        storeLabels={options.storeLabels}
        onSetupApplied={options.onSetupApplied}
      />
    </QueryClientProvider>,
  );
}

function pick(field: string, option: string) {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: field }));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

function comboboxText(field: string): string {
  return screen.getByRole('combobox', { name: field }).textContent ?? '';
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
}

describe('ReportProblemDialog', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it('keeps Send off until a reason is picked, and says who will read it', () => {
    renderDialog();
    expect(screen.getByText('Kilter at Crux')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    // A climber's board at a gym run by the gym, the creator's name kept back.
    expect(screen.getByText('The climber who added this board and Crux staff will see this.')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Not on the wall anymore/));
    expect(sendButton().disabled).toBe(false);
  });

  it('asks which board is the same wall for a duplicate, and sends the pick', async () => {
    mockRequest.mockResolvedValue({
      reportBoard: { status: 'created', reportUuid: 'r1', routedTo: ['creator', 'gym_staff'], otherReporterCount: 0 },
    });
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Listed twice/));
    expect(screen.getByText('Which board is the same wall?')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Kilter · Original 12x12 · 40°'));
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText("Sent. We'll tell you when it's sorted.")).toBeTruthy());
    expect(mockRequest).toHaveBeenCalledWith(REPORT_BOARD, {
      input: { boardUuid: 'board-1', reason: 'duplicate', duplicateOfBoardUuid: 'board-2', note: null },
    });
  });

  it('needs a note for Something else', () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Something else/));
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Tell them what's wrong/), { target: { value: 'The wall is a 7x10 now' } });
    expect(sendButton().disabled).toBe(false);
  });

  it('tells a climber who joined others, and one who already reported', async () => {
    mockRequest.mockResolvedValueOnce({
      reportBoard: { status: 'added', reportUuid: 'r1', routedTo: ['creator'], otherReporterCount: 2 },
    });
    const { unmount } = renderDialog();
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText('2 other climbers flagged this too. Yours is added.')).toBeTruthy());
    unmount();

    mockRequest.mockResolvedValueOnce({
      reportBoard: { status: 'already_reported', reportUuid: 'r1', routedTo: ['creator'], otherReporterCount: 2 },
    });
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(screen.getByText("You already reported this. We'll tell you when it's sorted.")).toBeTruthy(),
    );
  });

  it('says the report did not go through, never the server’s words', async () => {
    mockRequest.mockRejectedValue(new Error('Reporting a problem isn’t available yet.'));
    renderDialog();
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText("Your report didn't go through. Try again.")).toBeTruthy());
    expect(screen.queryByText('Reporting a problem isn’t available yet.')).toBeNull();
  });

  it('reports a gym, and offers the claim on a gym nobody runs', async () => {
    mockRequest.mockResolvedValue({
      reportGym: { status: 'created', reportUuid: 'r2', routedTo: ['admin'], otherReporterCount: 0 },
    });
    renderDialog({
      kind: 'gym',
      gym: { uuid: 'gym-1', name: 'Crux', slug: 'crux', listingState: 'UNCLAIMED', canClaim: true },
    });
    expect(screen.getByText('Our team will see this.')).toBeTruthy();
    expect(screen.getByText('Run Crux? Claim it and fix it yourself.').closest('a')?.getAttribute('href')).toContain(
      '/gym/crux?claim=1',
    );
    fireEvent.click(screen.getByLabelText(/Closed for good/));
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText("Sent. We'll tell you when it's sorted.")).toBeTruthy());
    expect(mockRequest).toHaveBeenCalledWith(REPORT_GYM, {
      input: { gymUuid: 'gym-1', reason: 'closed', duplicateOfGymUuid: null, note: null },
    });
  });

  it('keeps a late answer for board A off the dialog reopened for board B', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    mockRequest.mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)));
    const otherTarget: ReportProblemTarget = {
      ...boardTarget,
      board: { uuid: 'board-9', name: 'Tension', ownerId: 'sam', ownerDisplayName: null, setup: null },
    };
    const renderWith = (open: boolean, target: ReportProblemTarget) => (
      <QueryClientProvider client={createTestQueryClient()}>
        <ReportProblemDialog open={open} onClose={vi.fn()} target={target} />
      </QueryClientProvider>
    );
    const { rerender } = render(renderWith(true, boardTarget));
    fireEvent.click(screen.getByLabelText(/Not on the wall anymore/));
    fireEvent.click(sendButton());
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));

    rerender(renderWith(false, boardTarget));
    rerender(renderWith(true, otherTarget));
    resolveFirst({
      reportBoard: { status: 'created', reportUuid: 'r1', routedTo: ['creator'], otherReporterCount: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("Sent. We'll tell you when it's sorted.")).toBeNull();
    expect(sendButton().disabled).toBe(true);
  });

  it('shows a spinner while the page reads the board, and a retry when that failed', () => {
    const { unmount } = renderDialog(null);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    unmount();

    const onRetry = vi.fn();
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ReportProblemDialog open onClose={vi.fn()} target={null} loadFailed onRetryLoad={onRetry} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('ReportProblemDialog, setup fields', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("stays today's note-only dialog while the flag is off", () => {
    renderDialog(unclaimedTarget);
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    expect(screen.queryByRole('combobox', { name: 'Layout' })).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it("starts on the board's setup, keeps Send off until it differs, and says it changes it for everyone", () => {
    renderDialog(unclaimedTarget, { setupSuggestionsEnabled: true });
    fireEvent.click(screen.getByLabelText(/Set up wrong/));

    expect(comboboxText('Layout')).toBe(setupLayoutLabel('kilter', kilterLayout));
    expect(comboboxText('Size')).toBe(setupSizeLabel(kilterSize));
    // A board that tilts has no angle row: its angle isn't part of the setup.
    expect(screen.queryByRole('combobox', { name: 'Angle' })).toBeNull();
    expect(screen.getByText('This changes it for everyone at Crux. It can be undone.')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);

    pick('Size', setupSizeLabel(otherKilterSize));
    expect(comboboxText('Size')).toBe(setupSizeLabel(otherKilterSize));
    expect(sendButton().disabled).toBe(false);

    // Back to the board's own setup: nothing to suggest.
    pick('Size', setupSizeLabel(kilterSize));
    expect(sendButton().disabled).toBe(true);
  });

  it('resets the size and holds when the layout changes', () => {
    renderDialog(unclaimedTarget, { setupSuggestionsEnabled: true });
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    pick('Layout', setupLayoutLabel('kilter', otherKilterLayout));

    const defaultSizeId = getDefaultBoardSizeForLayout('kilter', otherKilterLayout.id);
    const defaultSize = getBoardSizesForLayoutId('kilter', otherKilterLayout.id).find(
      (size) => size.id === defaultSizeId,
    );
    if (!defaultSize) throw new Error('Expected the default size');
    expect(comboboxText('Size')).toBe(setupSizeLabel(defaultSize));
    const sets = getBoardSetsForLayoutAndSize('kilter', otherKilterLayout.id, defaultSize.id);
    expect(comboboxText('Holds')).toBe(sets.map((set) => set.name).join(', '));
    expect(sendButton().disabled).toBe(false);
  });

  it('says nothing above Send when the gym is known but its state did not load', () => {
    renderDialog(
      { ...unclaimedTarget, gym: { uuid: 'gym-1', name: 'Crux', slug: 'crux', listingState: null, canClaim: false } },
      { setupSuggestionsEnabled: true },
    );
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    pick('Size', setupSizeLabel(otherKilterSize));
    expect(screen.queryByText('This changes it for everyone at Crux. It can be undone.')).toBeNull();
    expect(screen.queryByText('Crux staff check it first.')).toBeNull();
    expect(screen.queryByText('The climber who added this board checks it first.')).toBeNull();
    expect(screen.queryByText(/will see this/)).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it('unchecks the set the climber tapped on a board carrying a set the catalogue does not list', async () => {
    mockRequest.mockResolvedValue({
      reportBoard: {
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'APPLIED',
        setupReviewReason: null,
        board: null,
      },
    });
    const listed = getBoardSetsForLayoutAndSize('kilter', kilterLayout.id, kilterSize.id);
    if (listed.length < 2) throw new Error('Expected a Kilter size with two sets');
    renderDialog(
      {
        ...unclaimedTarget,
        board: { ...boardTarget.board, setup: { ...kilterSetup, setIds: `99999,${kilterSetup.setIds}` } },
      },
      { setupSuggestionsEnabled: true },
    );
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    // The unlisted set is never part of the pick, so the fields open unchanged.
    expect(comboboxText('Holds')).toBe(listed.map((set) => set.name).join(', '));
    expect(sendButton().disabled).toBe(true);

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Holds' }));
    fireEvent.click(screen.getByRole('option', { name: listed[0].name }));
    // A multi-select stays open after a tap: close it to read the field.
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(comboboxText('Holds')).toBe(
      listed
        .slice(1)
        .map((set) => set.name)
        .join(', '),
    );
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());

    const remaining = listed
      .slice(1)
      .map((set) => set.id)
      .sort((first, second) => first - second)
      .join(',');
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(REPORT_BOARD, {
        input: expect.objectContaining({
          suggestedSetup: { layoutId: kilterLayout.id, sizeId: kilterSize.id, setIds: remaining, angle: null },
        }),
      }),
    );
  });

  it('never lets the holds go to zero', () => {
    const singleSet = setIdsOf(kilterLayout.id, kilterSize.id).slice(0, 1);
    renderDialog(
      { ...unclaimedTarget, board: { ...boardTarget.board, setup: { ...kilterSetup, setIds: singleSet.join(',') } } },
      { setupSuggestionsEnabled: true },
    );
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Holds' }));
    const onlySet = getBoardSetsForLayoutAndSize('kilter', kilterLayout.id, kilterSize.id)[0];
    expect(screen.getByRole('option', { name: onlySet.name }).getAttribute('aria-disabled')).toBe('true');
  });

  it('shows the angle on a board that does not tilt, and says who checks it at a claimed gym', () => {
    renderDialog(
      { ...boardTarget, board: { ...boardTarget.board, setup: { ...kilterSetup, isAngleAdjustable: false } } },
      { setupSuggestionsEnabled: true },
    );
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    expect(comboboxText('Angle')).toBe('40°');
    expect(screen.getByText('Crux staff check it first.')).toBeTruthy();
    pick('Angle', '45°');
    expect(sendButton().disabled).toBe(false);
  });

  it('sends the suggestion, then says the board changed and points to the app', async () => {
    mockRequest.mockResolvedValue({
      reportBoard: {
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'APPLIED',
        setupReviewReason: null,
        board: null,
      },
    });
    const onSetupApplied = vi.fn();
    renderDialog(unclaimedTarget, { setupSuggestionsEnabled: true, storeLabels, onSetupApplied });
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    pick('Size', setupSizeLabel(otherKilterSize));
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText('Setup updated for everyone at Crux.')).toBeTruthy());
    // The page reads the board again, so its row shows the new setup.
    expect(onSetupApplied).toHaveBeenCalledTimes(1);
    const otherSetIds = setIdsOf(kilterLayout.id, otherKilterSize.id).sort((first, second) => first - second);
    const suggestedSetup = {
      layoutId: kilterLayout.id,
      sizeId: otherKilterSize.id,
      setIds: otherSetIds.join(','),
      angle: null,
    };
    expect(mockRequest).toHaveBeenCalledWith(REPORT_BOARD, {
      input: { boardUuid: 'board-1', reason: 'wrong_setup', duplicateOfBoardUuid: null, note: null, suggestedSetup },
    });
    expect(screen.getByText(boardSetupSummary('kilter', suggestedSetup))).toBeTruthy();
    // The phone's store badge, then both badges from md: real anchors either way.
    expect(document.querySelectorAll('a[data-store-badge]').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Climb it now in the Boardsesh app.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('says why a suggestion waits for review', async () => {
    mockRequest.mockResolvedValue({
      reportBoard: {
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator', 'gym_staff'],
        otherReporterCount: 0,
        setupOutcome: 'SENT_FOR_REVIEW',
        setupReviewReason: 'CLAIMED_GYM',
        board: null,
      },
    });
    const onSetupApplied = vi.fn();
    renderDialog(boardTarget, { setupSuggestionsEnabled: true, storeLabels, onSetupApplied });
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    pick('Size', setupSizeLabel(otherKilterSize));
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText("Sent to Crux staff. We'll tell you when it's fixed.")).toBeTruthy());
    expect(document.querySelector('a[data-store-badge]')).toBeNull();
    expect(onSetupApplied).not.toHaveBeenCalled();
  });

  it('says the board is already set up that way when the server finds no change, and reads it again', async () => {
    mockRequest.mockRejectedValue(
      Object.assign(new Error('That is the setup the board has now.'), {
        response: {
          errors: [
            {
              message: 'That is the setup the board has now.',
              extensions: { code: 'BAD_USER_INPUT', reason: 'SETUP_UNCHANGED' },
            },
          ],
        },
      }),
    );
    const onSetupApplied = vi.fn();
    renderDialog(unclaimedTarget, { setupSuggestionsEnabled: true, storeLabels, onSetupApplied });
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    pick('Size', setupSizeLabel(otherKilterSize));
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText("It's already set up that way.")).toBeTruthy());
    expect(onSetupApplied).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Your report didn't go through. Try again.")).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The board is on that setup, so the app link stays: the climber can climb it.
    expect(document.querySelectorAll('a[data-store-badge]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('still says the send failed for any other refusal', async () => {
    mockRequest.mockRejectedValue(
      Object.assign(new Error('Unknown layout'), {
        response: { errors: [{ message: 'Unknown layout', extensions: { code: 'BAD_USER_INPUT' } }] },
      }),
    );
    const onSetupApplied = vi.fn();
    renderDialog(unclaimedTarget, { setupSuggestionsEnabled: true, onSetupApplied });
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    pick('Size', setupSizeLabel(otherKilterSize));
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText("It's already set up that way.")).toBeNull();
    expect(onSetupApplied).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it("keeps today's words for a suggestion that went to review with no reason", async () => {
    mockRequest.mockResolvedValue({
      reportBoard: {
        status: 'created',
        reportUuid: 'r1',
        routedTo: ['creator'],
        otherReporterCount: 0,
        setupOutcome: 'SENT_FOR_REVIEW',
        setupReviewReason: null,
        board: null,
      },
    });
    renderDialog(unclaimedTarget, { setupSuggestionsEnabled: true });
    fireEvent.click(screen.getByLabelText(/Set up wrong/));
    pick('Size', setupSizeLabel(otherKilterSize));
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText("Sent. We'll tell you when it's sorted.")).toBeTruthy());
  });
});
