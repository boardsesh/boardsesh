'use client';

import { getPlatform, isNativeApp } from '@/app/lib/ble/capacitor-utils';
import { getLayoutById } from '@/app/lib/moonboard-config';

export type InstagramPostingPlatform = 'ios' | 'android' | 'unsupported';

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
  return getLayoutById(layoutId)?.[1]?.name ?? null;
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

export type CopyAndOpenInstagramResult = {
  copied: boolean;
  opened: boolean;
};

const INSTAGRAM_CAMERA_URL = 'instagram://camera';

const CLIPBOARD_SETTLE_DELAY_MS = 180;

function legacyTextareaCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;

  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.fontSize = '16px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
    previouslyFocused?.focus();
  }
}

function legacyContentEditableCopy(text: string): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;

  const previouslyFocused = document.activeElement as HTMLElement | null;
  const container = document.createElement('div');
  container.textContent = text;
  container.contentEditable = 'true';
  container.setAttribute('aria-hidden', 'true');
  container.style.position = 'fixed';
  container.style.opacity = '0';
  container.style.top = '0';
  container.style.left = '0';
  container.style.whiteSpace = 'pre-wrap';
  container.style.userSelect = 'text';
  container.style.webkitUserSelect = 'text';
  container.style.pointerEvents = 'none';
  document.body.appendChild(container);

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(container);
  selection?.removeAllRanges();
  selection?.addRange(range);

  try {
    return document.execCommand('copy');
  } finally {
    selection?.removeAllRanges();
    document.body.removeChild(container);
    previouslyFocused?.focus();
  }
}

function legacyCopy(text: string, platform: InstagramPostingPlatform): boolean {
  if (platform === 'ios') {
    return legacyContentEditableCopy(text) || legacyTextareaCopy(text);
  }

  return legacyTextareaCopy(text);
}

async function copyToClipboard(text: string, platform: InstagramPostingPlatform): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    return legacyCopy(text, platform);
  } catch {
    return legacyCopy(text, platform);
  }
}

function getWebPlatformFromUserAgent(): InstagramPostingPlatform {
  if (typeof navigator === 'undefined') return 'unsupported';

  const ua = navigator.userAgent || '';
  if (/iPhone/i.test(ua)) return 'ios';
  if (/Android/i.test(ua) && /Mobile/i.test(ua)) return 'android';
  return 'unsupported';
}

export function getInstagramPostingPlatform(): InstagramPostingPlatform {
  if (typeof window === 'undefined') return 'unsupported';

  if (isNativeApp()) {
    const platform = getPlatform();
    if (platform === 'ios' || platform === 'android') return platform;
  }

  return getWebPlatformFromUserAgent();
}

export function isInstagramPostingSupported(): boolean {
  return getInstagramPostingPlatform() !== 'unsupported';
}

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
  return `"${climbName}" @ ${angle}\u00b0 on the ${config.name}.${config.separator}${social}`;
}

export function buildInstagramCaption(input: InstagramCaptionInput): string {
  const boardType = input.boardType ?? 'kilter';
  const config = BOARD_CAPTION_CONFIG[boardType] ?? BOARD_CAPTION_CONFIG.kilter;
  if (config.kind === 'custom') return config.format(input);
  return formatSimpleCaption(config, input);
}

function getInstagramLaunchUrl(platform: InstagramPostingPlatform): string | null {
  if (platform === 'ios' || platform === 'android') return INSTAGRAM_CAMERA_URL;
  return null;
}

function attemptInstagramLaunch(platform: InstagramPostingPlatform): Promise<boolean> {
  const launchUrl = getInstagramLaunchUrl(platform);
  if (!launchUrl || typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange, true);
      window.removeEventListener('pagehide', handlePageHide, true);
      window.clearTimeout(timeoutId);
    };

    const finish = (opened: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(opened);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' || document.hidden) {
        finish(true);
      }
    };

    const handlePageHide = () => finish(true);

    document.addEventListener('visibilitychange', handleVisibilityChange, true);
    window.addEventListener('pagehide', handlePageHide, true);

    const timeoutId = window.setTimeout(() => {
      finish(document.visibilityState === 'hidden' || document.hidden);
    }, 1400);

    window.location.href = launchUrl;
  });
}

function settleClipboardWrite(platform: InstagramPostingPlatform): Promise<void> {
  if (platform !== 'ios' || isNativeApp() || typeof window === 'undefined') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.setTimeout(resolve, CLIPBOARD_SETTLE_DELAY_MS);
  });
}

export async function copyInstagramCaption(caption: string): Promise<boolean> {
  const platform = getInstagramPostingPlatform();
  return copyToClipboard(caption, platform);
}

export async function openInstagramCamera(): Promise<boolean> {
  const platform = getInstagramPostingPlatform();
  return attemptInstagramLaunch(platform);
}

export async function copyAndOpenInstagram(caption: string): Promise<CopyAndOpenInstagramResult> {
  const platform = getInstagramPostingPlatform();
  const copied = await copyToClipboard(caption, platform);
  if (!copied) {
    return { copied: false, opened: false };
  }

  await settleClipboardWrite(platform);
  const opened = await attemptInstagramLaunch(platform);
  return { copied, opened };
}
