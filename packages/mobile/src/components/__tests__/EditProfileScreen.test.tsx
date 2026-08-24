// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ChangeEvent, createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routerBackMock = vi.hoisted(() => vi.fn());
const showToastMock = vi.hoisted(() => vi.fn());
const mutateAsyncMock = vi.hoisted(() => vi.fn());
const uploadAvatarMock = vi.hoisted(() => vi.fn());
const requestMediaLibraryPermissionsMock = vi.hoisted(() => vi.fn());
const launchImageLibraryMock = vi.hoisted(() => vi.fn());
const manipulateMock = vi.hoisted(() => vi.fn());
const resizeMock = vi.hoisted(() => vi.fn());
const renderAsyncMock = vi.hoisted(() => vi.fn());
const saveAsyncMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
const reportHandledErrorMock = vi.hoisted(() => vi.fn());
// Bytes the stubbed expo-file-system `File` hands back, keyed by URI. Missing
// entries read back as empty — which is exactly the Android failure under test:
// a 0-byte file reads as an empty array instead of throwing.
const fileBytesByUri = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-scroll-view': true }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: routerBackMock }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: requestMediaLibraryPermissionsMock,
  launchImageLibraryAsync: launchImageLibraryMock,
}));

vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: manipulateMock },
  SaveFormat: { JPEG: 'jpeg' },
}));

vi.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    bytes() {
      return Promise.resolve(fileBytesByUri.get(this.uri) ?? new Uint8Array());
    }
  },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryLabel: '#666666',
      tertiaryLabel: '#999999',
    },
  }),
}));

vi.mock('../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock('../../lib/graphql/hooks', () => ({
  useProfile: () => ({
    data: {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'alex@example.com',
      displayName: null,
      avatarUrl: null,
    },
  }),
  useUpdateProfile: () => ({ mutateAsync: mutateAsyncMock }),
}));

// `authenticatedFetch` drags in auth-store → expo-secure-store, which doesn't
// load under jsdom. Stubbing it is what lets the avatar-upload mock below be a
// *partial* one, so `MAX_AVATAR_BYTES` is the real constant and the over-cap
// test can't drift away from the boundary it's meant to exercise.
vi.mock('../../lib/auth-interceptor', () => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('../../lib/avatar-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/avatar-upload')>()),
  uploadAvatar: uploadAvatarMock,
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: vi.fn(),
  reportHandledError: reportHandledErrorMock,
}));

vi.mock('../Avatar', () => ({
  Avatar: ({ uri }: { uri?: string | null }) =>
    createElement('div', { 'data-testid': 'avatar', 'data-uri': uri ?? '' }),
}));

vi.mock('../AuthTextInput', () => ({
  AuthTextInput: ({
    label,
    value,
    onChangeText,
    editable = true,
  }: {
    label: string;
    value: string;
    onChangeText: (text: string) => void;
    editable?: boolean;
  }) =>
    createElement('input', {
      'aria-label': label,
      disabled: !editable,
      onChange: (event: ChangeEvent<HTMLInputElement>) => onChangeText(event.currentTarget.value),
      value,
    }),
}));

vi.mock('../Button', () => ({
  Button: ({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement(
      'button',
      {
        disabled,
        onClick: onPress,
        type: 'button',
      },
      title,
    ),
}));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

import { MAX_AVATAR_BYTES } from '../../lib/avatar-upload';
import { EditProfileScreen } from '../EditProfileScreen';

beforeEach(() => {
  routerBackMock.mockClear();
  showToastMock.mockClear();
  mutateAsyncMock.mockReset();
  uploadAvatarMock.mockReset();
  requestMediaLibraryPermissionsMock.mockReset();
  launchImageLibraryMock.mockReset();
  manipulateMock.mockReset();
  resizeMock.mockReset();
  renderAsyncMock.mockReset();
  saveAsyncMock.mockReset();
  releaseMock.mockReset();
  reportHandledErrorMock.mockReset();

  fileBytesByUri.clear();
  fileBytesByUri.set('file://picked-avatar.jpg', new Uint8Array([9, 9, 9, 9]));
  fileBytesByUri.set('file://compressed-avatar.jpg', new Uint8Array([1, 2, 3]));

  requestMediaLibraryPermissionsMock.mockResolvedValue({ granted: true });
  launchImageLibraryMock.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://picked-avatar.jpg', width: 2400, height: 1600, mimeType: 'image/jpeg' }],
  });
  saveAsyncMock.mockResolvedValue({ uri: 'file://compressed-avatar.jpg' });
  renderAsyncMock.mockResolvedValue({ saveAsync: saveAsyncMock, release: releaseMock });
  manipulateMock.mockReturnValue({ resize: resizeMock, renderAsync: renderAsyncMock });
  uploadAvatarMock.mockResolvedValue(
    'https://ws.example.com/static/avatars/11111111-1111-4111-8111-111111111111.jpg?v=upload-123',
  );
  mutateAsyncMock.mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    email: 'alex@example.com',
    displayName: null,
    avatarUrl: 'https://ws.example.com/static/avatars/11111111-1111-4111-8111-111111111111.jpg?v=upload-123',
  });
});

describe('EditProfileScreen', () => {
  it('uploads the picked avatar and saves the exact returned versioned URL', async () => {
    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://compressed-avatar.jpg');
    });

    fireEvent.click(screen.getByRole('button', { name: 'profile.save' }));

    await waitFor(() => {
      expect(uploadAvatarMock).toHaveBeenCalledWith(
        {
          uri: 'file://compressed-avatar.jpg',
          bytes: new Uint8Array([1, 2, 3]),
          name: 'avatar.jpg',
          type: 'image/jpeg',
        },
        '11111111-1111-4111-8111-111111111111',
      );
    });
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      avatarUrl: 'https://ws.example.com/static/avatars/11111111-1111-4111-8111-111111111111.jpg?v=upload-123',
    });
    expect(routerBackMock).toHaveBeenCalledOnce();
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
  });

  // Android's `saveAsync` ignores the Boolean `Bitmap.compress()` returns, so a
  // failed encode resolves with a URI pointing at a 0-byte file. Every layer
  // below treated that as success, and the user's picture vanished on the next
  // screen with nothing logged anywhere.
  it('falls back to the picker crop when the compressed file comes back empty', async () => {
    fileBytesByUri.set('file://compressed-avatar.jpg', new Uint8Array());

    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://picked-avatar.jpg');
    });

    fireEvent.click(screen.getByRole('button', { name: 'profile.save' }));

    await waitFor(() => {
      expect(uploadAvatarMock).toHaveBeenCalledWith(
        {
          uri: 'file://picked-avatar.jpg',
          bytes: new Uint8Array([9, 9, 9, 9]),
          name: 'avatar.jpg',
          type: 'image/jpeg',
        },
        '11111111-1111-4111-8111-111111111111',
      );
    });
    expect(routerBackMock).toHaveBeenCalledOnce();

    // The whole reason this went unnoticed: nothing reported it.
    expect(reportHandledErrorMock).toHaveBeenCalledOnce();
    const [reportedError, context] = reportHandledErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(reportedError.message).toBe('Avatar compression produced an empty file');
    expect(context).toMatchObject({
      level: 'warning',
      tags: { source: 'avatar-compress' },
      extra: { compressedBytes: 0, originalBytes: 4, originalType: 'image/jpeg' },
    });
  });

  // The fallback skips the JPEG re-encode, so the bytes are whatever the picker
  // produced. Declaring them `image/jpeg` regardless would store a PNG under a
  // .jpg key with a lying content-type.
  it("sends the fallback crop under the picker's own MIME type", async () => {
    launchImageLibraryMock.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file://picked-avatar.png', width: 2400, height: 1600, mimeType: 'image/png' }],
    });
    fileBytesByUri.set('file://picked-avatar.png', new Uint8Array([7, 7]));
    fileBytesByUri.set('file://compressed-avatar.jpg', new Uint8Array());

    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));
    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://picked-avatar.png');
    });
    fireEvent.click(screen.getByRole('button', { name: 'profile.save' }));

    await waitFor(() => {
      expect(uploadAvatarMock).toHaveBeenCalledWith(
        {
          uri: 'file://picked-avatar.png',
          bytes: new Uint8Array([7, 7]),
          name: 'avatar.png',
          type: 'image/png',
        },
        '11111111-1111-4111-8111-111111111111',
      );
    });
  });

  it('rescues a good crop the picker could not put a MIME type on', async () => {
    // `ImagePickerAsset.mimeType` is documented as null when the picker cannot
    // determine it. Refusing on that alone would forfeit exactly the rescue this
    // fallback exists for, so the type is read off the bytes instead.
    launchImageLibraryMock.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file://picked-avatar.jpg', width: 2400, height: 1600, mimeType: undefined }],
    });
    // A real JPEG header — FF D8 FF.
    fileBytesByUri.set('file://picked-avatar.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
    fileBytesByUri.set('file://compressed-avatar.jpg', new Uint8Array());

    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'profile.save' })).toHaveProperty('disabled', false);
    });
    expect(showToastMock).not.toHaveBeenCalledWith('profile.validation.avatarFormatUnsupported', 'error');

    fireEvent.click(screen.getByRole('button', { name: 'profile.save' }));

    await waitFor(() => {
      expect(uploadAvatarMock).toHaveBeenCalledWith(
        {
          uri: 'file://picked-avatar.jpg',
          bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]),
          name: 'avatar.jpg',
          type: 'image/jpeg',
        },
        '11111111-1111-4111-8111-111111111111',
      );
    });

    // Rescued, so this is a warning rather than a lost pick.
    const [, context] = reportHandledErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(context).toMatchObject({
      level: 'warning',
      tags: { source: 'avatar-compress', compressed_read: 'empty' },
      extra: { originalType: 'image/jpeg', declaredType: 'unknown' },
    });
  });

  it('refuses a fallback crop the backend would not accept, rather than mislabelling it', async () => {
    launchImageLibraryMock.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file://picked-avatar.heic', width: 2400, height: 1600, mimeType: 'image/heic' }],
    });
    fileBytesByUri.set('file://picked-avatar.heic', new Uint8Array([5, 5, 5]));
    fileBytesByUri.set('file://compressed-avatar.jpg', new Uint8Array());

    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      // The format is the problem, so say so — "try a smaller image" would send
      // the climber round a loop that cannot succeed.
      expect(showToastMock).toHaveBeenCalledWith('profile.validation.avatarFormatUnsupported', 'error');
    });
    expect(showToastMock).not.toHaveBeenCalledWith('profile.validation.compressionFailed', 'error');
    expect(uploadAvatarMock).not.toHaveBeenCalled();

    const [, context] = reportHandledErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    // `originalType` is what we would have sent; the picker's own label is kept
    // separately so triage can see a format we refused.
    expect(context).toMatchObject({
      level: 'error',
      extra: { originalType: 'unknown', declaredType: 'image/heic' },
    });
  });

  it('falls back to the picker crop when the manipulator throws outright', async () => {
    saveAsyncMock.mockRejectedValue(new Error('CorruptedImageDataException'));

    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://picked-avatar.jpg');
    });

    fireEvent.click(screen.getByRole('button', { name: 'profile.save' }));

    await waitFor(() => {
      expect(uploadAvatarMock).toHaveBeenCalledWith(
        {
          uri: 'file://picked-avatar.jpg',
          bytes: new Uint8Array([9, 9, 9, 9]),
          name: 'avatar.jpg',
          type: 'image/jpeg',
        },
        '11111111-1111-4111-8111-111111111111',
      );
    });
    expect(showToastMock).not.toHaveBeenCalledWith('profile.validation.compressionFailed', 'error');
    expect(routerBackMock).toHaveBeenCalledOnce();

    // The manipulator's own error is what gets reported here, not a synthetic
    // "empty file" — the two failure shapes stay distinguishable in triage.
    expect(reportHandledErrorMock).toHaveBeenCalledOnce();
    const [reportedError, context] = reportHandledErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(reportedError.message).toBe('CorruptedImageDataException');
    expect(context).toMatchObject({
      level: 'warning',
      tags: { source: 'avatar-compress' },
      extra: { compressedBytes: 0, originalBytes: 4, originalType: 'image/jpeg' },
    });
  });

  it('tells the user when neither the compressed file nor the picker crop is usable', async () => {
    fileBytesByUri.clear();

    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      // Nothing read back, so no smaller image would help either.
      expect(showToastMock).toHaveBeenCalledWith('profile.validation.avatarUnreadable', 'error');
    });
    expect(showToastMock).not.toHaveBeenCalledWith('profile.validation.compressionFailed', 'error');
    // No avatar was picked, so Save stays disabled and nothing is uploaded.
    expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('');
    expect(screen.getByRole('button', { name: 'profile.save' })).toHaveProperty('disabled', true);
    expect(uploadAvatarMock).not.toHaveBeenCalled();
    expect(routerBackMock).not.toHaveBeenCalled();
    expect(reportHandledErrorMock).toHaveBeenCalledOnce();
  });

  it('refuses a fallback crop that is over the backend cap rather than uploading it', async () => {
    fileBytesByUri.set('file://compressed-avatar.jpg', new Uint8Array());
    fileBytesByUri.set('file://picked-avatar.jpg', new Uint8Array(MAX_AVATAR_BYTES + 1));

    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith('profile.validation.compressionFailed', 'error');
    });
    expect(uploadAvatarMock).not.toHaveBeenCalled();

    // Losing the pick outright is reported at `error`, not the `warning` the
    // rescued-by-fallback path uses — and only once, not once here and again
    // from the screen's catch block.
    expect(reportHandledErrorMock).toHaveBeenCalledOnce();
    const [, context] = reportHandledErrorMock.mock.calls[0] as [Error, Record<string, unknown>];
    expect(context).toMatchObject({
      level: 'error',
      tags: { source: 'avatar-compress' },
      extra: { compressedBytes: 0, originalBytes: MAX_AVATAR_BYTES + 1, originalType: 'image/jpeg' },
    });
  });
});
