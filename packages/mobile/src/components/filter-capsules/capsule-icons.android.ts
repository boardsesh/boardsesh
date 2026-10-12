// The Android capsule glyphs: Material XML vectors bundled as assets
// (metro.config.js adds `xml` to resolver.assetExts). White-filled (#FFFFFFFF) so
// a Compose `Icon` recolours them: inside a chip or menu slot the Icon inherits
// the content colour (on-fill when the chip is selected, the menu text colour in
// items). Its own module so a test can stand the assets in.

import type { ImageSourcePropType } from 'react-native';
import type { CapsuleIcon } from './CapsuleRow.types';

/**
 * Semantic capsule icon → Material vector. A name with no vector draws no icon:
 * the lock glyphs ('locked' / 'lock' / 'unlock') stay out because the Tall /
 * Wide lock is iOS-only (0011bc363d), so Android never has a locked capsule or a
 * reachable Lock command to draw them on.
 */
export const CAPSULE_ICON_SOURCE: Partial<Record<CapsuleIcon, ImageSourcePropType>> = {
  filters: require('../../../assets/material-icons/tune.xml') as ImageSourcePropType,
  recent: require('../../../assets/material-icons/history.xml') as ImageSourcePropType,
};

/** The check a selected menu option carries. */
export const CHECK_ICON_SOURCE = require('../../../assets/material-icons/check.xml') as ImageSourcePropType;
