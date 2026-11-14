// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ChangeEvent, createElement, type ReactNode, useMemo } from 'react';
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
const ownedView = vi.hoisted(() => ({ scoped: false, handle: 'owned-A', revision: 0 }));
const assertUploadReceipt = vi.hoisted(() => vi.fn());
const assertMutationReceipt = vi.hoisted(() => vi.fn());
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
  useUpdateProfile: () => ({
    mutateWithReceipt: async (input: unknown) => {
      const assertCurrent = assertMutationReceipt.getMockImplementation() ?? (() => {});
      const result: unknown = await mutateAsyncMock(input);
      return { result, assertCurrent };
    },
  }),
}));

vi.mock('../../lib/graphql/use-http-query-scope', () => ({
  useHttpQueryScope: () =>
    useMemo(() => {
      const captured = { ...ownedView };
      return {
        scope: captured.scoped ? `${captured.handle}-${captured.revision}` : undefined,
        scoped: captured.scoped,
        assertView: () => {
          if (captured.scoped && (captured.handle !== ownedView.handle || captured.revision !== ownedView.revision))
            throw new Error('Owned profile view changed');
        },
      };
    }, [ownedView.scoped, ownedView.handle, ownedView.revision]),
}));

vi.mock('../../lib/avatar-upload', () => ({
  uploadAvatarWithReceipt: async (file: unknown, userId: string) => {
    const assertCurrent = assertUploadReceipt.getMockImplementation() ?? (() => {});
    const result: unknown = await uploadAvatarMock(file, userId);
    return { result, assertCurrent };
  },
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
  ownedView.scoped = false;
  ownedView.handle = 'owned-A';
  ownedView.revision = 0;
  assertUploadReceipt.mockReset();
  assertMutationReceipt.mockReset();
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
  profileFixture.id = '11111111-1111-4111-8111-111111111111';

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

  it('withholds an earlier picker result after the selected form switches accounts', async () => {
    ownedView.scoped = true;
    let release!: () => void;
    launchImageLibraryMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ canceled: false, assets: [{ uri: 'file://old-A.jpg', width: 100, height: 100 }] });
        }),
    );
    const { rerender } = render(<EditProfileScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));
    expect(launchImageLibraryMock).toHaveBeenCalledOnce();
    ownedView.handle = 'owned-B';
    ownedView.revision += 1;
    profileFixture.id = 'owned-B';
    profileFixture.displayName = 'B profile';
    rerender(<EditProfileScreen />);
    await act(async () => {
      release();
    });
    expect(manipulateMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('');
    expect((screen.getByLabelText('profile.displayName.label') as HTMLInputElement).value).toBe('B profile');
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('withholds a compressed image when the original view retires during native image saving', async () => {
    ownedView.scoped = true;
    let release!: () => void;
    saveAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ uri: 'file://old-A-compressed.jpg' });
        }),
    );
    const { rerender } = render(<EditProfileScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));
    await waitFor(() => expect(saveAsyncMock).toHaveBeenCalledOnce());
    ownedView.handle = 'owned-B';
    ownedView.revision += 1;
    profileFixture.id = 'owned-B';
    profileFixture.displayName = 'B profile';
    rerender(<EditProfileScreen />);
    await act(async () => {
      release();
    });
    expect(screen.getByTestId('avatar').getAttribute('data-uri')).toBe('');
    expect((screen.getByLabelText('profile.displayName.label') as HTMLInputElement).value).toBe('B profile');
    expect(releaseMock).toHaveBeenCalledOnce();
    expect(showToastMock).not.toHaveBeenCalled();
    expect(uploadAvatarMock).not.toHaveBeenCalled();
  });

  it('does not turn an earlier avatar upload into the new account profile mutation', async () => {
    ownedView.scoped = true;
    let release!: () => void;
    uploadAvatarMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('https://ws.example.com/static/avatars/old-A.jpg');
        }),
    );
    const { rerender } = render(<EditProfileScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));
    await waitFor(() => expect(saveAction().disabled).toBe(false));
    act(() => saveAction().onPress());
    await waitFor(() => expect(uploadAvatarMock).toHaveBeenCalledOnce());
    ownedView.handle = 'owned-B';
    ownedView.revision += 1;
    profileFixture.id = 'owned-B';
    profileFixture.displayName = 'B profile';
    rerender(<EditProfileScreen />);
    await act(async () => {
      release();
    });
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(routerBackMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
    expect(saveAction().loading).toBe(false);
  });

  it('suppresses an earlier mutation completion after A-to-B-to-A form replacement', async () => {
    ownedView.scoped = true;
    let release!: () => void;
    mutateAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: 'old-A' });
        }),
    );
    const { rerender } = render(<EditProfileScreen />);
    fireEvent.change(screen.getByLabelText('profile.displayName.label'), { target: { value: 'Original A edit' } });
    act(() => saveAction().onPress());
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledOnce());
    ownedView.handle = 'owned-B';
    ownedView.revision += 1;
    rerender(<EditProfileScreen />);
    ownedView.handle = 'owned-A';
    ownedView.revision += 1;
    profileFixture.displayName = 'Later A profile';
    rerender(<EditProfileScreen />);
    await act(async () => {
      release();
    });
    expect(routerBackMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText('profile.displayName.label') as HTMLInputElement).value).toBe('Later A profile');
    expect(saveAction().loading).toBe(false);
  });

  it('does not borrow a fresh profile mutation to extend an expired original upload result', async () => {
    ownedView.scoped = true;
    let originalUploadLive = true;
    assertUploadReceipt.mockImplementation(() => {
      if (!originalUploadLive) throw new Error('Old upload lease expired');
    });
    let release!: () => void;
    mutateAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: 'owned-A' });
        }),
    );
    render(<EditProfileScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'profile.avatar.upload' }));
    await waitFor(() => expect(saveAction().disabled).toBe(false));
    act(() => saveAction().onPress());
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledOnce());
    originalUploadLive = false;
    await act(async () => {
      release();
    });
    expect(routerBackMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalledWith('profile.saved', 'success');
    expect(showToastMock).toHaveBeenCalledWith('profile.saveError', 'error');
  });

  it('suppresses save completion after unmount even when its decoder ignores cancellation', async () => {
    ownedView.scoped = true;
    let release!: () => void;
    mutateAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: 'owned-A' });
        }),
    );
    const { unmount } = render(<EditProfileScreen />);
    fireEvent.change(screen.getByLabelText('profile.displayName.label'), { target: { value: 'Original A edit' } });
    act(() => saveAction().onPress());
    await waitFor(() => expect(mutateAsyncMock).toHaveBeenCalledOnce());
    unmount();
    await act(async () => {
      release();
    });
    expect(routerBackMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('rechecks before navigation if its success toast retires the original view synchronously', async () => {
    ownedView.scoped = true;
    showToastMock.mockImplementationOnce(() => {
      ownedView.revision += 1;
    });
    render(<EditProfileScreen />);
    fireEvent.change(screen.getByLabelText('profile.displayName.label'), { target: { value: 'Original A edit' } });
    act(() => saveAction().onPress());
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith('profile.saved', 'success'));
    expect(routerBackMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledOnce();
  });
});
