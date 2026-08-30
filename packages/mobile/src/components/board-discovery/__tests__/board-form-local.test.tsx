// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  useDeviceLocation: vi.fn(),
  useForeignSerialBoard: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TextInput: () => <input />,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  StyleSheet: { create: <T,>(styles: T) => styles },
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-config', () => ({ SUPPORTED_BOARDS: ['kilter'] }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#fff',
      tertiaryBackground: '#eee',
      separator: '#ddd',
      label: '#000',
      secondaryLabel: '#666',
      tertiaryLabel: '#999',
    },
  }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../lib/use-device-location', () => ({ useDeviceLocation: spies.useDeviceLocation }));
vi.mock('../../../lib/boards/use-foreign-serial-board', () => ({
  useForeignSerialBoard: spies.useForeignSerialBoard,
}));
vi.mock('../../../lib/boards/serial-reuse', () => ({ serialReuseDisclosure: () => null }));
vi.mock('../BoardConfigChips', () => ({ BoardConfigChips: () => <div>chips</div> }));
vi.mock('../board-builder-labels', () => ({
  boardTypeLabel: () => 'Kilter',
  cleanLayoutName: (name: string) => name,
  formatSizeLabel: () => '12 × 12',
}));
vi.mock('../../BoardImageNative', () => ({ BoardImageNative: () => <div>board image</div> }));
vi.mock('../../../lib/board-details', () => ({ getBoardRenderData: () => null }));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => <div>angle slider</div> }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => <div>angle diagram</div> }));
vi.mock('../../SwitchRow', () => ({ SwitchRow: () => <div>switch</div> }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));
vi.mock('../../Icon', () => ({ Icon: () => <span>icon</span> }));
vi.mock('../../Button', () => ({ Button: ({ title }: { title: string }) => <button type="button">{title}</button> }));
vi.mock('../../ble/TimerPairingSheet', () => ({ TimerPairingSheet: () => <div>timer API</div> }));
vi.mock('../GymPickerSheet', () => ({ GymPickerSheet: () => <div>gym API</div> }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32, 16: 64 },
  borderRadius: { md: 8, lg: 12 },
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { systemRed: '#f00', systemOrange: '#f80' },
}));

import { BoardForm } from '../BoardForm';

const noOp = () => {};
const builder = {
  boardName: 'kilter',
  layouts: [],
  sizes: [],
  sets: [],
  angles: [],
  layoutId: null,
  sizeId: null,
  setIds: [],
  angle: 0,
  name: '',
  rawLayoutName: null,
  isAngleAdjustable: true,
  canCreate: false,
  serialNumber: '',
  selectedGym: null,
  coords: null,
  locationName: '',
  timerName: '',
  isOwned: true,
  isPublic: false,
  isUnlisted: true,
  hideLocation: true,
  selectBoard: noOp,
  selectLayout: noOp,
  selectSize: noOp,
  toggleSet: noOp,
  setAngle: noOp,
  setName: noOp,
  setIsAngleAdjustable: noOp,
  setSerialNumber: noOp,
  setSelectedGym: noOp,
  setCoords: noOp,
  setLocationName: noOp,
  setTimerName: noOp,
  setIsOwned: noOp,
  setIsPublic: noOp,
  setIsUnlisted: noOp,
  setHideLocation: noOp,
} as never;

afterEach(() => cleanup());

describe('BoardForm local presentation', () => {
  it('does not mount location, serial, gym or account/social controls', () => {
    render(
      <BoardForm
        presentation="local"
        builder={builder}
        defaultName="Garage wall"
        submitting={false}
        onSubmit={noOp}
        submitLabel="Download"
      />,
    );

    expect(spies.useDeviceLocation).not.toHaveBeenCalled();
    expect(spies.useForeignSerialBoard).not.toHaveBeenCalled();
    expect(screen.queryByText('mobile.create.gym')).toBeNull();
    expect(screen.queryByText('mobile.create.location')).toBeNull();
    expect(screen.queryByText('mobile.create.serial')).toBeNull();
    expect(screen.queryByText('mobile.create.public')).toBeNull();
    expect(screen.queryByText('gym API')).toBeNull();
    expect(screen.queryByText('timer API')).toBeNull();
  });
});
