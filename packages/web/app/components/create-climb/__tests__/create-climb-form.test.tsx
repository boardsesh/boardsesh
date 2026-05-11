import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CreateClimbForm from '../create-climb-form';
import { useBoardProvider } from '../../board-provider/board-provider-context';
import { useCreateClimb } from '../use-create-climb';
import { useMoonBoardCreateClimb } from '../use-moonboard-create-climb';
import { useBoardBluetooth } from '../../board-bluetooth-control/use-board-bluetooth';
import type { BoardDetails, Climb } from '@/app/lib/types';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import type { BoardContextType } from '../../board-provider/board-provider-context';
import type { ParseResult } from '@boardsesh/moonboard-ocr/browser';

// ─── shared mocks ────────────────────────────────────────────────────────────

const mockShowMessage = vi.fn();
const mockRequest = vi.fn();
const mockOpenAuthModal = vi.fn();
const mockSetCurrentClimb = vi.fn();
const mockReplaceQueueItem = vi.fn();
const mockSaveClimb = vi.fn();
const mockUpdateClimb = vi.fn();
const mockLoadAuroraHolds = vi.fn();
const mockResetAuroraHolds = vi.fn();
const mockResetMoonboardHolds = vi.fn();
const mockSetAuroraHoldState = vi.fn();
const mockSetMoonboardHoldState = vi.fn();
const mockSendFramesToBoard = vi.fn();
const mockGenerateAuroraFramesString = vi.fn(() => 'test-frames');
let mockQueueActions: Record<string, unknown> | null = null;
let mockQueueData: Record<string, unknown> | null = null;
let mockAuroraCreateState: {
  isValid: boolean;
  totalHolds: number;
  litUpHoldsMap: LitUpHoldsMap;
} = {
  isValid: false,
  totalHolds: 0,
  litUpHoldsMap: {},
};

type DraftsDrawerTestProps = {
  open: boolean;
  onLoadDraft?: (climb: Climb) => void;
  onDraftDeleted?: (climb: Climb) => void;
};

let mockDraftsDrawerProps: DraftsDrawerTestProps | null = null;

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/b/moonboard-2016-40/create',
}));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(() => ({ data: { user: { id: 'user-1', name: 'Test User' } } })),
}));

vi.mock('../../board-provider/board-provider-context', () => ({
  useBoardProvider: vi.fn(() => ({
    isAuthenticated: true,
    saveClimb: mockSaveClimb,
    updateClimb: mockUpdateClimb,
  })),
}));

vi.mock('../../board-bluetooth-control/use-board-bluetooth', () => ({
  useBoardBluetooth: vi.fn(() => ({ isConnected: false, sendFramesToBoard: mockSendFramesToBoard })),
}));

vi.mock('../use-create-climb', () => ({
  useCreateClimb: vi.fn(() => ({
    litUpHoldsMap: mockAuroraCreateState.litUpHoldsMap,
    setHoldState: mockSetAuroraHoldState,
    startingCount: 0,
    finishCount: 0,
    totalHolds: mockAuroraCreateState.totalHolds,
    isValid: mockAuroraCreateState.isValid,
    resetHolds: mockResetAuroraHolds,
    generateFramesString: mockGenerateAuroraFramesString,
    loadHolds: mockLoadAuroraHolds,
  })),
}));

vi.mock('../use-moonboard-create-climb', () => ({
  useMoonBoardCreateClimb: vi.fn(() => ({
    litUpHoldsMap: {
      1: { state: 'STARTING', color: '#00FF00', displayColor: '#44FF44' },
      13: { state: 'HAND', color: '#0000FF', displayColor: '#4444FF' },
      25: { state: 'FINISH', color: '#FF0000', displayColor: '#FF3333' },
    },
    setLitUpHoldsMap: vi.fn(),
    setHoldState: mockSetMoonboardHoldState,
    startingCount: 1,
    finishCount: 1,
    handCount: 1,
    totalHolds: 3,
    isValid: true,
    resetHolds: mockResetMoonboardHolds,
  })),
}));

vi.mock('@/app/components/graphql-queue', () => ({
  useOptionalQueueActions: () => mockQueueActions,
  useOptionalQueueData: () => mockQueueData,
}));

vi.mock('../../board-renderer/board-renderer', () => ({
  default: () => <div data-testid="board-renderer">BoardRenderer</div>,
}));

vi.mock('../../moonboard-renderer/moonboard-renderer', () => ({
  default: () => <div data-testid="moonboard-renderer">MoonBoardRenderer</div>,
}));

vi.mock('../../board-renderer/zoomable-board', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="zoomable-board">{children}</div>,
}));

vi.mock('@/app/hooks/use-color-mode', () => ({
  useColorMode: () => ({ mode: 'light' }),
}));

vi.mock('@boardsesh/moonboard-ocr/browser', () => ({
  parseScreenshot: vi.fn(),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('../graphql-queue/graphql-client', () => ({
  createGraphQLClient: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@/app/components/providers/auth-modal-provider', () => ({
  useAuthModal: () => ({ openAuthModal: mockOpenAuthModal }),
}));

vi.mock('../../providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('../drafts-drawer', () => ({
  default: (props: DraftsDrawerTestProps) => {
    mockDraftsDrawerProps = props;
    return props.open ? <div data-testid="drafts-drawer" /> : null;
  },
}));

vi.mock('@/app/lib/climb-search-cache', () => ({
  refreshClimbSearchAfterSave: vi.fn(),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'auth-token' }),
}));

vi.mock('../use-hold-type-picker', () => ({
  useHoldTypePicker: () => ({
    anchorEl: null,
    currentState: null,
    handleHoldClick: vi.fn(),
    handleSelect: vi.fn(),
    handleClose: vi.fn(),
  }),
}));

vi.mock('../hold-type-picker', () => ({
  default: () => null,
}));

vi.mock('../create-climb-heatmap-overlay', () => ({
  default: () => null,
}));

vi.mock('@/app/lib/moonboard-climbs-db', () => ({
  convertOcrHoldsToMap: vi.fn(),
}));

vi.mock('@/app/lib/url-utils', () => ({
  constructClimbListWithSlugs: vi.fn(() => '/b/kilter/list'),
}));

vi.mock('@/app/lib/backend-url', () => ({
  getBackendWsUrl: vi.fn(() => 'ws://localhost:1234'),
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

const MOONBOARD_PROPS = {
  boardType: 'moonboard' as const,
  angle: 40,
  layoutFolder: 'moonboard2016',
  layoutId: 2,
  holdSetImages: ['holdseta.png'],
};

const auroraBoardDetails: BoardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 2,
  set_ids: [3, 4],
  images_to_holds: {},
  holdsData: [],
  edge_left: 0,
  edge_right: 100,
  edge_bottom: 0,
  edge_top: 100,
  boardHeight: 100,
  boardWidth: 100,
};

function renderMoonboard(overrides?: Record<string, unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateClimbForm {...MOONBOARD_PROPS} {...overrides} />
    </QueryClientProvider>,
  );
}

function renderComponent() {
  return renderMoonboard({ forkName: 'Test Climb' });
}

function renderAuroraComponent(overrides?: Record<string, unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateClimbForm boardType="aurora" angle={40} boardDetails={auroraBoardDetails} {...overrides} />
    </QueryClientProvider>,
  );
}

function getSaveButton(): HTMLButtonElement | undefined {
  return screen
    .getAllByLabelText('Save climb')
    .find((element): element is HTMLButtonElement => element.tagName === 'BUTTON');
}

// ─── test suites ─────────────────────────────────────────────────────────────

describe('CreateClimbForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueActions = null;
    mockQueueData = null;
    mockDraftsDrawerProps = null;
    mockAuroraCreateState = {
      isValid: false,
      totalHolds: 0,
      litUpHoldsMap: {},
    };
    mockGenerateAuroraFramesString.mockReturnValue('test-frames');
    mockSaveClimb.mockResolvedValue({ uuid: 'new-draft-1', createdAt: '2026-01-01T00:00:00.000Z', publishedAt: null });
    mockUpdateClimb.mockResolvedValue({
      uuid: 'loaded-draft-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      publishedAt: null,
      isDraft: true,
    });
    mockRequest.mockResolvedValue({ checkMoonBoardClimbDuplicates: [], searchClimbs: { totalCount: 0 } });
  });

  it('shows a blocking duplicate error for MoonBoard climbs and disables save', async () => {
    mockRequest.mockResolvedValue({
      checkMoonBoardClimbDuplicates: [
        {
          clientKey: 'create-form',
          exists: true,
          existingClimbUuid: 'existing-1',
          existingClimbName: 'Existing Problem',
        },
      ],
    });

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/This hold pattern already exists as "Existing Problem"/)).toBeTruthy();
    });

    await waitFor(() => {
      const saveButton = getSaveButton();
      expect(saveButton).toBeTruthy();
      expect(saveButton?.disabled).toBe(true);
    });
  });

  describe('Set Active button', () => {
    it('is not rendered when queueActions is null (no session)', () => {
      mockQueueActions = null;
      renderComponent();

      expect(screen.queryByLabelText('Set as active climb')).toBeNull();
    });

    it('is rendered when queueActions is available', () => {
      mockQueueActions = {
        setCurrentClimb: mockSetCurrentClimb,
        replaceQueueItem: mockReplaceQueueItem,
        addToQueue: vi.fn(),
        removeFromQueue: vi.fn(),
      };
      mockQueueData = { currentClimb: null };

      renderComponent();

      expect(screen.getByLabelText('Set as active climb')).toBeTruthy();
    });

    it('is enabled when holds are placed (MoonBoard with 3 holds)', () => {
      mockQueueActions = {
        setCurrentClimb: mockSetCurrentClimb,
        replaceQueueItem: mockReplaceQueueItem,
        addToQueue: vi.fn(),
        removeFromQueue: vi.fn(),
      };
      mockQueueData = { currentClimb: null };

      renderComponent();

      const button = screen.getByLabelText('Set as active climb').closest('button');
      expect(button?.disabled).toBe(false);
    });

    it('calls setCurrentClimb when clicked', async () => {
      mockSetCurrentClimb.mockResolvedValue({ uuid: 'queue-item-1' });
      mockQueueActions = {
        setCurrentClimb: mockSetCurrentClimb,
        replaceQueueItem: mockReplaceQueueItem,
        addToQueue: vi.fn(),
        removeFromQueue: vi.fn(),
      };
      mockQueueData = { currentClimb: null };

      renderComponent();

      const button = screen.getByLabelText('Set as active climb');
      fireEvent.click(button);

      await waitFor(() => {
        expect(mockSetCurrentClimb).toHaveBeenCalledTimes(1);
      });

      const climb = mockSetCurrentClimb.mock.calls[0][0];
      expect(climb).toMatchObject({
        angle: 40,
        frames: '',
      });
      expect(climb.uuid).toBeTruthy();
    });

    it('calls replaceQueueItem on second click instead of setCurrentClimb', async () => {
      mockSetCurrentClimb.mockResolvedValue({ uuid: 'queue-item-1' });
      mockQueueActions = {
        setCurrentClimb: mockSetCurrentClimb,
        replaceQueueItem: mockReplaceQueueItem,
        addToQueue: vi.fn(),
        removeFromQueue: vi.fn(),
      };
      mockQueueData = { currentClimb: null };

      renderComponent();

      const button = screen.getByLabelText('Set as active climb');

      // First click: should call setCurrentClimb
      fireEvent.click(button);
      await waitFor(() => {
        expect(mockSetCurrentClimb).toHaveBeenCalledTimes(1);
      });

      // After setCurrentClimb resolves and sets queueItemUuid, the sync effect
      // also fires replaceQueueItem. Clear counts before the second click.
      mockReplaceQueueItem.mockClear();

      // Second click: should call replaceQueueItem with the queue item UUID
      fireEvent.click(button);
      await waitFor(() => {
        expect(mockReplaceQueueItem).toHaveBeenCalled();
        expect(mockReplaceQueueItem).toHaveBeenCalledWith(
          'queue-item-1',
          expect.objectContaining({
            angle: 40,
          }),
        );
      });
    });
  });

  it('detaches a loaded draft when that draft is deleted before the next save', async () => {
    mockAuroraCreateState = {
      isValid: true,
      totalHolds: 2,
      litUpHoldsMap: {},
    };
    mockRequest.mockResolvedValue({ searchClimbs: { totalCount: 1 } });

    renderAuroraComponent();

    await waitFor(() => {
      expect(mockDraftsDrawerProps?.onLoadDraft).toBeTruthy();
    });

    const loadedDraft = {
      uuid: 'loaded-draft-1',
      name: 'Loaded Draft',
      description: 'Saved beta',
      frames: '',
      angle: 40,
      is_draft: true,
      created_at: '2026-01-01T00:00:00.000Z',
      published_at: null,
    } as Climb;

    await act(async () => {
      mockDraftsDrawerProps?.onLoadDraft?.(loadedDraft);
    });

    await act(async () => {
      mockDraftsDrawerProps?.onDraftDeleted?.(loadedDraft);
    });

    const saveButton = getSaveButton();
    expect(saveButton).toBeTruthy();

    fireEvent.click(saveButton!);

    await waitFor(() => {
      expect(mockSaveClimb).toHaveBeenCalledTimes(1);
    });

    expect(mockUpdateClimb).not.toHaveBeenCalled();
    expect(mockSaveClimb).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Loaded Draft',
        description: 'Saved beta',
        frames: 'test-frames',
        is_draft: true,
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CreateClimbForm — MoonBoard rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueActions = null;
    mockQueueData = null;
    mockDraftsDrawerProps = null;
    mockRequest.mockResolvedValue({ checkMoonBoardClimbDuplicates: [] });
  });

  it('renders MoonBoardRenderer inside the board section', () => {
    renderMoonboard();
    expect(screen.getByTestId('moonboard-renderer')).toBeTruthy();
  });

  it('does not render BoardRenderer for moonboard', () => {
    renderMoonboard();
    expect(screen.queryByTestId('board-renderer')).toBeNull();
  });

  it('shows Start, Hand, Finish, Total hold indicators', () => {
    renderMoonboard();
    expect(screen.getByLabelText('createClimbForm.holds.start')).toBeTruthy();
    expect(screen.getByLabelText('createClimbForm.holds.hand')).toBeTruthy();
    expect(screen.getAllByLabelText('createClimbForm.holds.finish').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('createClimbForm.holds.total')).toBeTruthy();
  });

  it('does not show Starting label (Aurora-specific)', () => {
    renderMoonboard();
    expect(screen.queryByLabelText('createClimbForm.holds.starting')).toBeNull();
  });

  it('shows Import and Bulk buttons', () => {
    renderMoonboard();
    expect(screen.getByRole('button', { name: /import/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /bulk/i })).toBeTruthy();
  });

  it('bulk link points to the import path', () => {
    renderMoonboard();
    const bulkLink = screen.getByRole('link', { name: /bulk/i });
    expect((bulkLink as HTMLAnchorElement).href).toContain('/import');
  });

  it('shows duplicate error without a name when existingClimbName is absent', async () => {
    mockRequest.mockResolvedValue({
      checkMoonBoardClimbDuplicates: [
        { clientKey: 'create-form', exists: true, existingClimbUuid: 'abc', existingClimbName: null },
      ],
    });

    renderMoonboard();

    await waitFor(() => {
      expect(screen.getByText(/This hold pattern already exists\. Change at least one hold/)).toBeTruthy();
    });
  });

  it('shows checking-duplicate info alert while duplicate check is in progress', async () => {
    // Never resolves so the checking state stays visible
    mockRequest.mockImplementation(() => new Promise(() => {}));

    renderMoonboard();

    await waitFor(() => {
      expect(screen.getByText('createClimbForm.alerts.checkingMoonBoardDuplicate')).toBeTruthy();
    });
  });

  it('does not show checking alert when climb is not valid', () => {
    vi.mocked(useMoonBoardCreateClimb).mockReturnValueOnce({
      litUpHoldsMap: {},
      setLitUpHoldsMap: vi.fn(),
      setHoldState: mockSetMoonboardHoldState,
      startingCount: 0,
      finishCount: 0,
      handCount: 0,
      totalHolds: 0,
      isValid: false,
      resetHolds: mockResetMoonboardHolds,
    });
    renderMoonboard();
    expect(screen.queryByText('createClimbForm.alerts.checkingMoonBoardDuplicate')).toBeNull();
  });

  it('clear button is disabled when totalHolds is 0', () => {
    vi.mocked(useMoonBoardCreateClimb).mockReturnValueOnce({
      litUpHoldsMap: {},
      setLitUpHoldsMap: vi.fn(),
      setHoldState: mockSetMoonboardHoldState,
      startingCount: 0,
      finishCount: 0,
      handCount: 0,
      totalHolds: 0,
      isValid: false,
      resetHolds: mockResetMoonboardHolds,
    });
    renderMoonboard();
    const deleteIcon = document.querySelector('[data-testid="DeleteOutlinedIcon"]');
    const clearBtn = deleteIcon?.closest('button');
    expect(clearBtn?.hasAttribute('disabled')).toBe(true);
  });

  it('clear button is enabled when holds are present', () => {
    renderMoonboard();
    const deleteIcon = document.querySelector('[data-testid="DeleteOutlinedIcon"]');
    const clearBtn = deleteIcon?.closest('button');
    expect(clearBtn?.hasAttribute('disabled')).toBe(false);
  });

  it('calls resetHolds after confirming the clear popover', () => {
    renderMoonboard();
    const deleteIcon = document.querySelector('[data-testid="DeleteOutlinedIcon"]');
    const clearBtn = deleteIcon?.closest('button') as HTMLButtonElement;
    // Clear is wrapped in ConfirmPopover — first click opens the popover, the
    // confirm button inside fires resetHolds.
    fireEvent.click(clearBtn);
    const confirmBtn = screen.getByRole('button', { name: /actions\.clear/i });
    fireEvent.click(confirmBtn);
    expect(mockResetMoonboardHolds).toHaveBeenCalledTimes(1);
  });

  it('does not show heatmap button for MoonBoard', () => {
    renderMoonboard();
    expect(screen.queryByLabelText(/heatmap/i)).toBeNull();
  });

  it('does not show Drafts button for MoonBoard', () => {
    renderMoonboard();
    expect(screen.queryByRole('button', { name: /drafts/i })).toBeNull();
  });

  it('shows Settings button', () => {
    renderMoonboard();
    expect(screen.getByRole('button', { name: /settings/i })).toBeTruthy();
  });

  it('Settings button opens settings panel with Angle, Grade, Benchmark fields', () => {
    renderMoonboard();
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByText('createClimbForm.fields.angle')).toBeTruthy();
    expect(screen.getByText('createClimbForm.fields.grade')).toBeTruthy();
    expect(screen.getByText('createClimbForm.fields.benchmark')).toBeTruthy();
    expect(screen.getByText('createClimbForm.fields.description')).toBeTruthy();
  });

  it('has Draft toggle checked by default', () => {
    renderMoonboard();
    const draftSwitch = document.querySelector('input[type="checkbox"]');
    expect((draftSwitch as HTMLInputElement).checked).toBe(true);
  });

  it('shows OCR error alert when import fails', async () => {
    const { parseScreenshot } = await import('@boardsesh/moonboard-ocr/browser');
    vi.mocked(parseScreenshot).mockResolvedValueOnce({
      success: false,
      error: 'Could not detect board',
      warnings: [],
    } as ParseResult);

    renderMoonboard();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['img'], 'screenshot.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(screen.getByText('createClimbForm.alerts.importFailed')).toBeTruthy();
    });
  });

  it('shows OCR warning alert when import succeeds with warnings', async () => {
    const { parseScreenshot } = await import('@boardsesh/moonboard-ocr/browser');
    const { convertOcrHoldsToMap } = await import('@/app/lib/moonboard-climbs-db');
    vi.mocked(parseScreenshot).mockResolvedValueOnce({
      success: true,
      warnings: ['Screenshot is for 25° but current page is 40°. Holds imported anyway.'],
      climb: {
        holds: { start: [], hand: [], finish: [] },
        name: '',
        angle: 25,
        userGrade: '',
        setterGrade: '',
        isBenchmark: false,
        setter: '',
        sourceFile: 'screenshot.png',
      },
    });
    vi.mocked(convertOcrHoldsToMap).mockReturnValueOnce({});

    renderMoonboard();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['img'], 'screenshot.png', { type: 'image/png' });

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    await waitFor(() => {
      expect(screen.getByText(/createClimbForm\.alerts\.importWarnings/)).toBeTruthy();
    });
  });

  it('Import button is disabled while OCR is processing', async () => {
    const { parseScreenshot } = await import('@boardsesh/moonboard-ocr/browser');
    // Never resolves so we stay in processing state
    vi.mocked(parseScreenshot).mockImplementation(() => new Promise(() => {}));

    renderMoonboard();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['img'], 'screenshot.png', { type: 'image/png' });

    act(() => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    await waitFor(() => {
      const importBtn = screen.getByRole('button', { name: /createClimbForm\.(processing|importFromScreenshot)/i });
      expect(importBtn.hasAttribute('disabled')).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CreateClimbForm — Aurora rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueActions = null;
    mockQueueData = null;
    mockDraftsDrawerProps = null;
    mockAuroraCreateState = {
      isValid: false,
      totalHolds: 0,
      litUpHoldsMap: {},
    };
    mockRequest.mockResolvedValue({ searchClimbs: { totalCount: 0 } });
  });

  it('renders BoardRenderer inside the board section', () => {
    renderAuroraComponent();
    expect(screen.getByTestId('board-renderer')).toBeTruthy();
  });

  it('does not render MoonBoardRenderer for Aurora', () => {
    renderAuroraComponent();
    expect(screen.queryByTestId('moonboard-renderer')).toBeNull();
  });

  it('shows Starting, Finish, Total hold indicators', () => {
    renderAuroraComponent();
    expect(screen.getByLabelText('createClimbForm.holds.starting')).toBeTruthy();
    expect(screen.getByLabelText('createClimbForm.holds.finish')).toBeTruthy();
    expect(screen.getByLabelText('createClimbForm.holds.total')).toBeTruthy();
  });

  it('does not show Hand label (MoonBoard-specific)', () => {
    renderAuroraComponent();
    expect(screen.queryByLabelText('createClimbForm.holds.hand')).toBeNull();
  });

  it('shows heatmap toggle button', () => {
    renderAuroraComponent();
    expect(screen.getByRole('button', { name: /heatmap/i })).toBeTruthy();
  });

  it('heatmap toggle flips between Show and Hide states', () => {
    renderAuroraComponent();
    expect(screen.getByRole('button', { name: /show heatmap/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /show heatmap/i }));
    expect(screen.getByRole('button', { name: /hide heatmap/i })).toBeTruthy();
  });

  it('shows Drafts button when Aurora user is authenticated and boardDetails present', async () => {
    renderAuroraComponent();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /drafts/i })).toBeTruthy();
    });
  });

  it('does not show Drafts button when Aurora user is not authenticated', async () => {
    vi.mocked(useBoardProvider).mockReturnValueOnce({
      isAuthenticated: false,
      saveClimb: mockSaveClimb,
      updateClimb: mockUpdateClimb,
    } as unknown as BoardContextType);
    renderAuroraComponent();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /drafts/i })).toBeNull();
    });
  });

  it('does not show Drafts button when boardDetails is absent', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CreateClimbForm boardType="aurora" angle={40} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('button', { name: /drafts/i })).toBeNull();
  });

  it('does not show Import button for Aurora', () => {
    renderAuroraComponent();
    expect(screen.queryByRole('button', { name: /import/i })).toBeNull();
  });

  it('does not show Bulk link for Aurora', () => {
    renderAuroraComponent();
    expect(screen.queryByRole('link', { name: /bulk/i })).toBeNull();
  });

  it('Settings button opens settings panel without Angle/Grade/Benchmark', () => {
    renderAuroraComponent();
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.queryByText('createClimbForm.fields.angle')).toBeNull();
    expect(screen.queryByText('createClimbForm.fields.grade')).toBeNull();
    expect(screen.queryByText('createClimbForm.fields.benchmark')).toBeNull();
    expect(screen.getByText('createClimbForm.fields.description')).toBeTruthy();
  });

  it('Draft toggle is on by default', () => {
    renderAuroraComponent();
    const draftSwitch = document.querySelector('input[type="checkbox"]');
    expect((draftSwitch as HTMLInputElement).checked).toBe(true);
  });

  it('Draft toggle can be turned off', () => {
    renderAuroraComponent();
    const draftSwitch = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(draftSwitch);
    expect(draftSwitch.checked).toBe(false);
  });

  it('clear button disabled when no holds', () => {
    renderAuroraComponent();
    const deleteIcon = document.querySelector('[data-testid="DeleteOutlinedIcon"]');
    const clearBtn = deleteIcon?.closest('button');
    expect(clearBtn?.hasAttribute('disabled')).toBe(true);
  });

  it('sends frames to board via Bluetooth when connected and holds change', async () => {
    vi.mocked(useBoardBluetooth).mockReturnValue({
      isConnected: true,
      sendFramesToBoard: mockSendFramesToBoard,
    } as unknown as ReturnType<typeof useBoardBluetooth>);
    mockAuroraCreateState = {
      isValid: true,
      totalHolds: 1,
      litUpHoldsMap: { 1: { state: 'HAND', color: '#blue', displayColor: '#blue' } } as LitUpHoldsMap,
    };
    vi.mocked(useCreateClimb).mockReturnValue({
      litUpHoldsMap: mockAuroraCreateState.litUpHoldsMap,
      setHoldState: mockSetAuroraHoldState,
      startingCount: 0,
      finishCount: 0,
      totalHolds: 1,
      isValid: true,
      resetHolds: mockResetAuroraHolds,
      generateFramesString: mockGenerateAuroraFramesString,
      loadHolds: mockLoadAuroraHolds,
    });

    renderAuroraComponent();

    await waitFor(() => {
      expect(mockSendFramesToBoard).toHaveBeenCalledWith('test-frames');
    });
  });

  it('does not show duplicate checking alert for Aurora', () => {
    renderAuroraComponent();
    expect(screen.queryByText('createClimbForm.alerts.checkingMoonBoardDuplicate')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CreateClimbForm — Save button state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueActions = null;
    mockQueueData = null;
    mockDraftsDrawerProps = null;
    mockRequest.mockResolvedValue({ checkMoonBoardClimbDuplicates: [] });
  });

  it('save button enabled when MoonBoard: valid + name + no duplicate + logged in', async () => {
    renderMoonboard({ forkName: 'My Climb' });

    await waitFor(() => {
      const saveButton = getSaveButton();
      expect(saveButton?.disabled).toBe(false);
    });
  });

  it('save button disabled when duplicate is being checked', async () => {
    mockRequest.mockImplementation(() => new Promise(() => {}));
    renderMoonboard({ forkName: 'My Climb' });

    await waitFor(() => {
      const saveButton = getSaveButton();
      expect(saveButton?.disabled).toBe(true);
    });
  });

  it('save button disabled when duplicate match is found', async () => {
    mockRequest.mockResolvedValue({
      checkMoonBoardClimbDuplicates: [
        { clientKey: 'create-form', exists: true, existingClimbUuid: 'x', existingClimbName: 'Dupe' },
      ],
    });
    renderMoonboard({ forkName: 'My Climb' });

    await waitFor(() => {
      const saveButton = getSaveButton();
      expect(saveButton?.disabled).toBe(true);
    });
  });

  it('renders a login link when MoonBoard session is absent', async () => {
    const { useSession } = await import('next-auth/react');
    vi.mocked(useSession).mockReturnValueOnce({ data: null } as ReturnType<typeof useSession>);
    renderMoonboard();
    const loginLink = document.querySelector('a[href$="/api/auth/signin"]');
    expect(loginLink).toBeTruthy();
  });

  it('does not render a Save button when Aurora is unauthenticated', () => {
    vi.mocked(useBoardProvider).mockReturnValueOnce({
      isAuthenticated: false,
      saveClimb: mockSaveClimb,
      updateClimb: mockUpdateClimb,
    } as unknown as BoardContextType);
    renderAuroraComponent();
    expect(screen.queryByLabelText('Save climb')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('CreateClimbForm — forkName prop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueueActions = null;
    mockQueueData = null;
    mockDraftsDrawerProps = null;
    mockRequest.mockResolvedValue({ checkMoonBoardClimbDuplicates: [] });
  });

  it('initialises the climb name input with "<forkName> fork" when forkName provided', () => {
    renderMoonboard({ forkName: 'Original Climb' });
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(screen.getByDisplayValue('Original Climb fork')).toBeTruthy();
  });

  it('initialises the climb name input as empty when forkName is absent', () => {
    renderMoonboard({ forkName: undefined });
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    const nameInputs = document.querySelectorAll('input[type="text"]');
    expect((nameInputs[0] as HTMLInputElement).value).toBe('');
  });
});
