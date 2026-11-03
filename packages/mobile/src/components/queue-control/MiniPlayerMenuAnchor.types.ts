import type { AppMenuProps } from '../AppMenu.types';

export type MiniPlayerMenuAnchorProps = Extract<AppMenuProps, { iconName: string }> & { anchorSize: number };
