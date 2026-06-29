// Ambient type for the platform-split AppMenu so `tsc` resolves the extensionless
// `./AppMenu` import to this declaration, while Metro picks the matching
// AppMenu.ios.tsx / AppMenu.android.tsx at bundle time. Both implementations are
// still compiled and type-checked on their own. Re-exports the action/props types so
// the existing `type`-only importers (home/index.tsx, HomeTopChrome.tsx) keep
// resolving `AppMenuAction` from `./AppMenu`. Mirrors the SwitchRow.d.ts mechanism.

import type { FC } from 'react';
import type { AppMenuProps } from './AppMenu.types';

export type { AppMenuAction, AppMenuProps } from './AppMenu.types';

export declare const AppMenu: FC<AppMenuProps>;
