import type { StyleProp, ViewStyle } from 'react-native';
import type { StorePromptSurface } from '../lib/store-links';

export type AppStorePromptProps = {
  /**
   * The screen the prompt sits on. It picks the layout, and it is the
   * `utm_campaign` on the store link and the `placement` on the click event.
   */
  surface: StorePromptSurface;
  style?: StyleProp<ViewStyle>;
};
