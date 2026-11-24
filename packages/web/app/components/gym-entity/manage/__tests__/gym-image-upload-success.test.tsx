import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Gym } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymLogoUploader from '../gym-logo-uploader';
import GymPhotoUploader from '../gym-photo-uploader';

const { execute, showMessage } = vi.hoisted(() => ({ execute: vi.fn(), showMessage: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
  }),
}));
vi.mock('@/app/hooks/use-entity-mutation', () => ({ useEntityMutation: () => ({ execute }) }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'test-token' }) }));
vi.mock('@/app/components/providers/snackbar-provider', () => ({ useSnackbar: () => ({ showMessage }) }));
vi.mock('@/app/lib/backend-url', () => ({ getBackendHttpUrl: () => 'https://api.boardsesh.com' }));
vi.mock('@/app/lib/auth/session-guard', () => ({
  guardedFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));

const gym = { uuid: 'test-gym', name: 'Test Gym', ownerId: 'owner', isPublic: true } as Gym;

beforeEach(() => {
  execute.mockReset();
  showMessage.mockReset();
  // Exercise the photo uploader past browser encoding without real raster APIs.
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 100;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      set src(_source: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = () => 'blob:test-upload';
      static revokeObjectURL = () => {};
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    fillRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob(['encoded-image'], { type: 'image/jpeg' }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pickImage(container: HTMLElement, kind: 'photo' | 'logo'): void {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Upload input was not rendered');
  const file =
    kind === 'logo'
      ? new File(['logo-image'], 'logo.gif', { type: 'image/gif' })
      : new File(['photo-image'], 'photo.jpg', { type: 'image/jpeg' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe.each(['photo', 'logo'] as const)('Gym %s upload attachment', (kind) => {
  it('uses the committed gym from POST without sending a second mutation', async () => {
    const storedUrl = `/static/gym-${kind}s/test-gym.upload.jpg`;
    const savedGym = { ...gym, name: 'Saved gym name', [kind === 'logo' ? 'logoUrl' : 'imageUrl']: storedUrl };
    const fetchSpy = vi.fn(async () => Response.json({ success: true, [`${kind}Url`]: storedUrl, gym: savedGym }));
    vi.stubGlobal('fetch', fetchSpy);
    const onGymChange = vi.fn();
    const { container } = render(
      kind === 'logo' ? (
        <GymLogoUploader gym={gym} logoDisplayUrl={null} onGymChange={onGymChange} />
      ) : (
        <GymPhotoUploader gym={gym} onGymChange={onGymChange} />
      ),
    );

    pickImage(container, kind);

    await waitFor(() => expect(onGymChange).toHaveBeenCalledWith(savedGym));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe(`https://api.boardsesh.com/api/gym-${kind}s`);
    expect(requestInit.method).toBe('POST');
    expect(new Headers(requestInit.headers).get('x-boardsesh-client')).toMatch(/^boardsesh-web\//);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a successful response that names another gym', async () => {
    const storedUrl = `/static/gym-${kind}s/test-gym.upload.jpg`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          [`${kind}Url`]: storedUrl,
          gym: { ...gym, uuid: 'another-gym', [kind === 'logo' ? 'logoUrl' : 'imageUrl']: storedUrl },
        }),
      ),
    );
    const onGymChange = vi.fn();
    const { container } = render(
      kind === 'logo' ? (
        <GymLogoUploader gym={gym} logoDisplayUrl={null} onGymChange={onGymChange} />
      ) : (
        <GymPhotoUploader gym={gym} onGymChange={onGymChange} />
      ),
    );

    pickImage(container, kind);

    await waitFor(() => {
      if (kind === 'logo') expect(showMessage).toHaveBeenCalledWith(expect.stringContaining('upload'), 'error');
      else expect(screen.getByRole('alert').textContent).toContain('upload');
    });
    expect(onGymChange).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
