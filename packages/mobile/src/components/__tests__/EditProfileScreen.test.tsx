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
const AvatarUploadErrorMock = vi.hoisted(
  () =>
    class AvatarUploadError extends Error {
      readonly status: number;

      constructor(message: string, status: number) {
        super(message);
        this.name = 'AvatarUploadError';
        this.status = status;
      }
    },
);

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

vi.mock('../../lib/avatar-upload', () => ({
  AvatarUploadError: AvatarUploadErrorMock,
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
  reportHandledErrorMock.mockClear();

  requestMediaLibraryPermissionsMock.mockResolvedValue({ granted: true });
  launchImageLibraryMock.mockResolvedValue({
    canceled: false,
    assets: [{ uri: 'file://picked-avatar.jpg', width: 2400, height: 1600 }],
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
        { uri: 'file://compressed-avatar.jpg', name: 'avatar.jpg', type: 'image/jpeg' },
        '11111111-1111-4111-8111-111111111111',
      );
    });
    expect(mutateAsyncMock).toHaveBeenCalledWith({
      avatarUrl: 'https://ws.example.com/static/avatars/11111111-1111-4111-8111-111111111111.jpg?v=upload-123',
    });
    expect(routerBackMock).toHaveBeenCalledOnce();
  });

  it('reports avatar upload failures with profile upload context', async () => {
    const uploadError = new AvatarUploadErrorMock('File too large', 413);
    uploadAvatarMock.mockRejectedValue(uploadError);

    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://compressed-avatar.jpg');
    });

    fireEvent.click(screen.getByRole('button', { name: 'profile.save' }));

    await waitFor(() => {
      expect(reportHandledErrorMock).toHaveBeenCalledWith(uploadError, {
        tags: { source: 'profile', op: 'avatar-upload' },
        extra: { status: 413 },
      });
    });
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(routerBackMock).not.toHaveBeenCalled();
  });
});
