import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockShowMessage = vi.fn();
const mockRequest = vi.fn();
const mockOpenAuthModal = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/b/moonboard-2016-40/create',
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-1' } } }),
}));

vi.mock('../../board-provider/board-provider-context', () => ({
  useBoardProvider: () => ({ isAuthenticated: true, saveClimb: vi.fn() }),
}));

vi.mock('../../board-bluetooth-control/use-board-bluetooth', () => ({
  useBoardBluetooth: () => ({ isConnected: false, sendFramesToBoard: vi.fn() }),
}));

vi.mock('../use-create-climb', () => ({
  useCreateClimb: () => ({
    litUpHoldsMap: {},
    setHoldState: vi.fn(),
    startingCount: 0,
    finishCount: 0,
    totalHolds: 0,
    isValid: false,
    resetHolds: vi.fn(),
    generateFramesString: vi.fn(),
  }),
}));

vi.mock('../use-moonboard-create-climb', () => ({
  useMoonBoardCreateClimb: () => ({
    litUpHoldsMap: {
      1: { state: 'STARTING', color: '#00FF00', displayColor: '#44FF44' },
      13: { state: 'HAND', color: '#0000FF', displayColor: '#4444FF' },
      25: { state: 'FINISH', color: '#FF0000', displayColor: '#FF3333' },
    },
    setLitUpHoldsMap: vi.fn(),
    setHoldState: vi.fn(),
    startingCount: 1,
    finishCount: 1,
    handCount: 1,
    totalHolds: 3,
    isValid: true,
    resetHolds: vi.fn(),
  }),
}));

vi.mock('../../board-renderer/board-renderer', () => ({
  default: () => <div>BoardRenderer</div>,
}));

vi.mock('../../moonboard-renderer/moonboard-renderer', () => ({
  default: () => <div>MoonBoardRenderer</div>,
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

vi.mock('@/app/lib/climb-search-cache', () => ({
  refreshClimbSearchAfterSave: vi.fn(),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'auth-token' }),
}));

import CreateClimbForm from '../create-climb-form';

function renderComponent() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <CreateClimbForm
        boardType="moonboard"
        angle={40}
        forkName="Test Climb"
        layoutFolder="moonboard2016"
        layoutId={2}
        holdSetImages={['holdseta.png']}
      />
    </QueryClientProvider>,
  );
}

describe('CreateClimbForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(screen.getByLabelText<HTMLButtonElement>('Save climb').disabled).toBe(true);
    });
  });
});
