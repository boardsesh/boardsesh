// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const profileFixture = vi.hoisted(() => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'alex@example.com',
  displayName: null as string | null,
  avatarUrl: null as string | null,
}));
// The latest top-bar action the screen asked for: Save lives in the header now.
const headerActions = vi.hoisted(() => ({
  trailing: null as null | { label: string; onPress: () => void; disabled?: boolean; loading?: boolean },
}));

const keyboard = vi.hoisted(() => ({
  platform: 'ios',
  listeners: new Map<string, (event: { endCoordinates: { height: number } }) => void>(),
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 96 }));

vi.mock('react-native', () => ({
  Keyboard: {
    addListener: (name: string, callback: (event: { endCoordinates: { height: number } }) => void) => {
      keyboard.listeners.set(name, callback);
      return { remove: () => keyboard.listeners.delete(name) };
    },
  },
  LayoutAnimation: { configureNext: vi.fn() },
  KeyboardAvoidingView: ({
    children,
    behavior,
    keyboardVerticalOffset,
  }: {
    children?: ReactNode;
    behavior?: string;
    keyboardVerticalOffset?: number;
  }) =>
    createElement(
      'div',
      { 'data-keyboard-avoiding': true, 'data-behavior': behavior ?? '', 'data-offset': keyboardVerticalOffset },
      children,
    ),
  Platform: {
    get OS() {
      return keyboard.platform;
    },
  },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  ScrollView: ({
    children,
    contentContainerStyle,
    automaticallyAdjustKeyboardInsets,
  }: {
    children?: ReactNode;
    contentContainerStyle?: unknown;
    automaticallyAdjustKeyboardInsets?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-scroll-view': true,
        'data-content-style': JSON.stringify(contentContainerStyle),
        'data-automatic-keyboard': String(automaticallyAdjustKeyboardInsets),
      },
      children,
    ),
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

vi.mock('../../hooks/use-header-actions', () => ({
  useHeaderActions: ({ trailing }: { trailing: typeof headerActions.trailing }) => {
    headerActions.trailing = trailing;
  },
}));

vi.mock('../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 28 }),
}));

vi.mock('../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock('../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: profileFixture }),
  useUpdateProfile: () => ({ mutateAsync: mutateAsyncMock }),
}));

vi.mock('../../lib/avatar-upload', () => ({
  uploadAvatar: uploadAvatarMock,
}));

vi.mock('../../lib/error-reporting', () => ({
  reportError: vi.fn(),
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

function saveAction() {
  if (!headerActions.trailing) throw new Error('no top-bar Save');
  return headerActions.trailing;
}

beforeEach(() => {
  keyboard.platform = 'ios';
  keyboard.listeners.clear();
  headerActions.trailing = null;
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
  profileFixture.displayName = null;
  profileFixture.avatarUrl = null;

  // A spy only: the screen must never ask. It answers "denied" so a request
  // that came back would also block the pick, not just trip the call count.
  requestMediaLibraryPermissionsMock.mockResolvedValue({ granted: false });
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
  it('uses header-offset iOS keyboard avoidance without double-counting keyboard insets', () => {
    const { container } = render(<EditProfileScreen />);
    const avoiding = container.querySelector('[data-keyboard-avoiding]');
    expect(avoiding?.getAttribute('data-behavior')).toBe('padding');
    expect(avoiding?.getAttribute('data-offset')).toBe('96');
    expect(container.querySelector('[data-scroll-view]')?.getAttribute('data-automatic-keyboard')).toBe('undefined');
    expect(keyboard.listeners.size).toBe(0);
  });

  it('adds and clears Android keyboard space while preserving bottom chrome', () => {
    keyboard.platform = 'android';
    const { container, unmount } = render(<EditProfileScreen />);
    const padding = () => {
      const styles = JSON.parse(
        container.querySelector('[data-scroll-view]')?.getAttribute('data-content-style') ?? '[]',
      ) as { paddingBottom?: number }[];
      return styles.find((style) => style.paddingBottom !== undefined)?.paddingBottom;
    };
    expect(padding()).toBe(44);
    act(() => keyboard.listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 300 } }));
    expect(padding()).toBe(344);
    act(() => keyboard.listeners.get('keyboardDidHide')?.({ endCoordinates: { height: 0 } }));
    expect(padding()).toBe(44);
    unmount();
    expect(keyboard.listeners.size).toBe(0);
  });

  it('saves from a top-bar check that stays grey until something changed', () => {
    render(createElement(EditProfileScreen));

    expect(saveAction()).toMatchObject({ label: 'profile.save', disabled: true, loading: false });
    expect(screen.queryByRole('button', { name: 'profile.save' })).toBeNull();

    fireEvent.change(screen.getByLabelText('profile.displayName.label'), { target: { value: 'Alex' } });
    expect(saveAction().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('profile.displayName.label'), { target: { value: '   ' } });
    expect(saveAction().disabled).toBe(true);
  });

  it('saves the typed name and goes back', async () => {
    render(createElement(EditProfileScreen));

    fireEvent.change(screen.getByLabelText('profile.displayName.label'), { target: { value: ' Alex ' } });
    saveAction().onPress();

    await waitFor(() => expect(routerBackMock).toHaveBeenCalledOnce());
    expect(mutateAsyncMock).toHaveBeenCalledWith({ displayName: 'Alex' });
    expect(uploadAvatarMock).not.toHaveBeenCalled();
  });

  it('uploads the picked avatar and saves the exact returned versioned URL', async () => {
    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://compressed-avatar.jpg');
    });

    expect(saveAction().disabled).toBe(false);
    saveAction().onPress();

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

  it('keeps a failed avatar on a named profile for retry without reporting success', async () => {
    profileFixture.displayName = 'Alex';
    uploadAvatarMock.mockRejectedValueOnce(new Error('Upload unavailable'));
    render(<EditProfileScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));
    await waitFor(() => expect(saveAction().disabled).toBe(false));
    act(() => saveAction().onPress());

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledExactlyOnceWith({ displayName: 'Alex' });
      expect(showToastMock.mock.calls).toEqual([['profile.avatarUploadFailed', 'warning']]);
      expect(saveAction().loading).toBe(false);
    });
    expect(routerBackMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://compressed-avatar.jpg');
    expect(saveAction().disabled).toBe(false);

    act(() => saveAction().onPress());

    await waitFor(() => expect(routerBackMock).toHaveBeenCalledOnce());
    expect(launchImageLibraryMock).toHaveBeenCalledOnce();
    expect(uploadAvatarMock).toHaveBeenCalledTimes(2);
    expect(mutateAsyncMock).toHaveBeenLastCalledWith({
      displayName: 'Alex',
      avatarUrl: 'https://ws.example.com/static/avatars/11111111-1111-4111-8111-111111111111.jpg?v=upload-123',
    });
    expect(showToastMock).toHaveBeenLastCalledWith('profile.saved', 'success');
  });

  it('still saves a name edit once when the avatar upload fails', async () => {
    profileFixture.displayName = 'Alex';
    uploadAvatarMock.mockRejectedValueOnce(new Error('Upload unavailable'));
    render(<EditProfileScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));
    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://compressed-avatar.jpg');
    });
    fireEvent.change(screen.getByLabelText('profile.displayName.label'), { target: { value: ' Alex Sender ' } });
    const save = saveAction();
    act(() => {
      save.onPress();
      save.onPress();
    });

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledExactlyOnceWith({ displayName: 'Alex Sender' });
      expect(showToastMock.mock.calls).toEqual([['profile.avatarUploadFailed', 'warning']]);
      expect(saveAction().loading).toBe(false);
    });
    expect(uploadAvatarMock).toHaveBeenCalledOnce();
    expect(routerBackMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText('profile.displayName.label') as HTMLInputElement).value).toBe(' Alex Sender ');
    expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://compressed-avatar.jpg');
    expect(saveAction().disabled).toBe(false);
  });

  it('keeps an avatar-only failure retryable when the profile has no name', async () => {
    uploadAvatarMock.mockRejectedValueOnce(new Error('Upload unavailable'));
    render(<EditProfileScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));
    await waitFor(() => expect(saveAction().disabled).toBe(false));
    act(() => saveAction().onPress());

    await waitFor(() => {
      expect(showToastMock.mock.calls).toEqual([['profile.avatarUploadFailed', 'warning']]);
      expect(saveAction().loading).toBe(false);
    });
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(routerBackMock).not.toHaveBeenCalled();
    expect(saveAction().disabled).toBe(false);
  });

  // The system picker hands back only the chosen photo and needs no permission
  // (#5957). Asking first put a whole-library prompt in front of the picker.
  it('opens the avatar picker without asking for photo library access', async () => {
    render(createElement(EditProfileScreen));

    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));

    await waitFor(() => {
      expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('file://compressed-avatar.jpg');
    });
    expect(launchImageLibraryMock).toHaveBeenCalledWith(expect.objectContaining({ allowsEditing: true }));
    expect(requestMediaLibraryPermissionsMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
