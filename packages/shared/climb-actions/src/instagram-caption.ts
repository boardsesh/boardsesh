// Board-aware Instagram/TikTok caption builder for the "share your beta" flow.
// Pure TS (no DOM, no React, no React Native) so both web and mobile build the
// exact same caption — the climb name is embedded so the share-back auto-match
// (matchClimbsToCaption) can recover the climb from the reel caption.

import { getLayoutById } from '@boardsesh/board-config';

export type InstagramCaptionInput = {
  climbName: string;
  angle: number;
  boardType?: string;
  grade?: string | null;
  setter?: string | null;
  layoutId?: number | null;
};

const BOARDSESH_TAG = '@boardsesh #boardsesh';

type SimpleBoardCaptionConfig = {
  kind: 'simple';
  name: string;
  displayName: string;
  handle?: string;
  hashtags: string;
  separator: '\n' | ' ';
};

type CustomBoardCaptionConfig = {
  kind: 'custom';
  displayName: string;
  format: (input: InstagramCaptionInput) => string;
};

type BoardCaptionConfig = SimpleBoardCaptionConfig | CustomBoardCaptionConfig;

function findMoonBoardLayoutName(layoutId: number | null | undefined): string | null {
  if (layoutId == null) return null;
  // getLayoutById returns the matched Object.entries() pair [key, layout] (or
  // undefined). Destructure the layout out of the tuple instead of indexing [1].
  const [, layout] = getLayoutById(layoutId) ?? [];
  return layout?.name ?? null;
}

function buildMoonBoardCaption({ climbName, angle, grade, setter, layoutId }: InstagramCaptionInput): string {
  const layoutName = findMoonBoardLayoutName(layoutId);
  const segments: string[] = [climbName];
  if (grade) segments.push(grade);
  segments.push(`${angle}° MoonBoard`);
  if (layoutName) segments.push(`${layoutName} setup`);
  let prefix = segments.join(', ');
  if (setter) prefix += `, set by ${setter}`;
  return `${prefix}. - @moonclimbing #moonboard #moonclimbing #moonboardchallenge #trainhardclimbharder ${BOARDSESH_TAG}`;
}

const BOARD_CAPTION_CONFIG: Record<string, BoardCaptionConfig> = {
  kilter: {
    kind: 'simple',
    name: 'Kilter Board',
    displayName: 'Kilter',
    handle: '@kilterboard',
    hashtags: '#kilterboard #kiltergrips',
    separator: '\n',
  },
  tension: {
    kind: 'simple',
    name: 'Tension Board',
    displayName: 'Tension',
    handle: '@tensionclimbing',
    hashtags: '#tensionboard #climbing #bouldering',
    separator: ' ',
  },
  decoy: {
    kind: 'simple',
    name: 'Decoy Board',
    displayName: 'Decoy',
    hashtags: '#climbing #bouldering',
    separator: ' ',
  },
  touchstone: {
    kind: 'simple',
    name: 'Touchstone Board',
    displayName: 'Touchstone',
    hashtags: '#climbing #bouldering',
    separator: ' ',
  },
  grasshopper: {
    kind: 'simple',
    name: 'Grasshopper Board',
    displayName: 'Grasshopper',
    hashtags: '#climbing #bouldering',
    separator: ' ',
  },
  soill: {
    kind: 'simple',
    name: 'So iLL Board',
    displayName: 'So iLL',
    hashtags: '#climbing #bouldering',
    separator: ' ',
  },
  moonboard: {
    kind: 'custom',
    displayName: 'MoonBoard',
    format: buildMoonBoardCaption,
  },
};

export function getBoardDisplayName(boardType: string): string {
  const config = BOARD_CAPTION_CONFIG[boardType];
  if (config) return config.displayName;
  return boardType.charAt(0).toUpperCase() + boardType.slice(1);
}

function formatSimpleCaption(config: SimpleBoardCaptionConfig, input: InstagramCaptionInput): string {
  const { climbName, angle } = input;
  const social = config.handle
    ? `${config.handle} ${config.hashtags} ${BOARDSESH_TAG}`
    : `${config.hashtags} ${BOARDSESH_TAG}`;
  return `"${climbName}" @ ${angle}° on the ${config.name}.${config.separator}${social}`;
}

export function buildInstagramCaption(input: InstagramCaptionInput): string {
  const boardType = input.boardType ?? 'kilter';
  const config = BOARD_CAPTION_CONFIG[boardType] ?? BOARD_CAPTION_CONFIG.kilter;
  if (config.kind === 'custom') return config.format(input);
  return formatSimpleCaption(config, input);
}
