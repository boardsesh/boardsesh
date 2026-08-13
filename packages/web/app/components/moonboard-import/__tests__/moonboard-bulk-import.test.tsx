import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MoonBoardBulkImport from '../moonboard-bulk-import';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockShowMessage = vi.fn();
const mockRequest = vi.fn();
const mockPush = vi.fn();
const mockBack = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
  usePathname: () => '/b/moonboard-2016-40/import',
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'user-1' } } }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('@boardsesh/moonboard-ocr/browser', () => ({
  parseMultipleScreenshots: vi.fn(async () => ({
    climbs: [
      {
        sourceFile: 'screen-1.png',
        name: 'Imported Climb',
        setter: 'Setter',
        userGrade: '6A+',
        isBenchmark: false,
        angle: 40,
        holds: {
          start: ['A1'],
          hand: ['B2'],
          finish: ['C3'],
        },
      },
    ],
    errors: [],
  })),
  deduplicateClimbs: (climbs: unknown[]) => climbs,
}));

vi.mock('../moonboard-import-card', () => ({
  default: ({
    climb,
    duplicateMatch,
  }: {
    climb: { name: string };
    duplicateMatch: { exists?: boolean; existingClimbName?: string | null } | null;
  }) => (
    <div>
      <div>{climb.name}</div>
      {duplicateMatch?.exists && <div>{`Skipping: Already Exists as "${duplicateMatch.existingClimbName}"`}</div>}
    </div>
  ),
}));

vi.mock('../moonboard-edit-modal', () => ({
  default: () => null,
}));

vi.mock('@/app/lib/backend-url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/backend-url')>()),
  getBackendWsUrl: () => null,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'auth-token' }),
}));

vi.mock('@/app/lib/moonboard-ocr-upload', () => ({
  uploadOcrTestDataBatch: vi.fn(),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@/app/lib/climb-search-cache', () => ({
  refreshClimbSearchAfterSave: vi.fn(),
}));

function renderComponent() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MoonBoardBulkImport
        layoutFolder="moonboard2016"
        layoutName="MoonBoard 2016"
        layoutId={2}
        holdSetImages={['holdseta.png']}
        angle={40}
      />
    </QueryClientProvider>,
  );
}

describe('MoonBoardBulkImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({
      checkMoonBoardClimbDuplicates: [
        {
          clientKey: 'screen-1.png',
          exists: true,
          existingClimbUuid: 'existing-1',
          existingClimbName: 'Existing Problem',
        },
      ],
    });
  });

  it('marks duplicates on the card and excludes them from Save All', async () => {
    const { container } = renderComponent();

    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();

    fireEvent.change(input!, {
      target: {
        files: [new File(['dummy'], 'screen-1.png', { type: 'image/png' })],
      },
    });

    await waitFor(() => {
      expect(screen.getByText('Skipping: Already Exists as "Existing Problem"')).toBeTruthy();
    });

    expect(screen.queryByText('1 Duplicate Climb(s)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save All (0)' }).hasAttribute('disabled')).toBe(true);
  });
});
