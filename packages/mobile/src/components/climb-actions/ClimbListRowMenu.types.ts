import type { ReactElement, Ref, RefObject } from 'react';
import type { ColorValue, StyleProp, ViewInstance, ViewStyle } from 'react-native';
import type { PlayDrawerMenuRow } from '../play-drawer/play-drawer-menu-rows';

export type ClimbListRowMenuHandle = { open: () => void };

export type ClimbListRowMenuProps = {
  ref?: Ref<ClimbListRowMenuHandle>;
  onBeforeOpen?: () => void;
  /** Only the main climb list offers both triggers. */
  enabled: boolean;
  rows: PlayDrawerMenuRow[];
  menuKey: string;
  title: string;
  accessibilityLabel: string;
  children: ReactElement;
  /** The same row body, without the source gesture detector. Mounted only while lifted. */
  preview: ReactElement;
  focusRef: RefObject<ViewInstance | null>;
  bodyStyle: StyleProp<ViewStyle>;
  moreButtonStyle: StyleProp<ViewStyle>;
  showMoreButton: boolean;
  previewOverlayColor?: ColorValue;
};
