/// <reference types="node" />

/**
 * The shots scripts' half of the dev-only story harness (docs/mobile-stories.md).
 *
 * The app renders a story at the `dev/stories/<id>` route. When a component
 * story has painted it logs `[stories] ready <id>` through Metro; a scenario
 * story logs `[stories] scenario <id> -> <route>` and opens a real screen
 * instead; an unknown id logs `[stories] missing <id> (did you mean …)`. Those
 * lines land in the Metro log, which is how mobile-ios-shots and
 * mobile-android-shots know when to capture.
 */

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { METRO_LOG_PATH, METRO_PORT, metroLogPathForPort, waitForMetroLogLine } from './metro-dev-server';
import { sleepSeconds } from './exec';

export const STORY_THEMES = ['dark', 'light'] as const;
export const STORY_VARIANTS = ['liquidGlass', 'material'] as const;
export type StoryTheme = (typeof STORY_THEMES)[number];
export type StoryVariant = (typeof STORY_VARIANTS)[number];

/** How long to wait for the story's line before capturing anyway. */
export const STORY_READY_TIMEOUT_SECONDS = 15;
/** Extra settle after the ready line, for entry animations and an async theme switch. */
export const STORY_READY_SETTLE_SECONDS = 0.5;

// Kebab-case module id, optionally `--` and a kebab-case story key
// (packages/mobile/src/dev/stories/registry-core.ts). A bare module id opens
// that file's first story.
const STORY_ID = /^[a-z0-9]+(?:--?[a-z0-9]+)*$/;

export interface StoryTarget {
  id: string;
  theme: StoryTheme | null;
  variant: StoryVariant | null;
}

export function assertStoryId(id: string): string {
  if (!STORY_ID.test(id)) {
    throw new Error(`--story must be a story id like crew-browse--pills (got "${id}")`);
  }
  return id;
}

/** The deep-link route (no scheme) that opens a story. */
export function storyRoute(target: StoryTarget): string {
  const query = [
    target.theme ? `theme=${target.theme}` : null,
    target.variant ? `variant=${target.variant}` : null,
  ].filter((part): part is string => part !== null);
  return `dev/stories/${target.id}${query.length > 0 ? `?${query.join('&')}` : ''}`;
}

/** Default screenshot label: the story id, plus the theme/variant when passed. */
export function storyLabel(target: StoryTarget): string {
  return [target.id, target.theme, target.variant].filter((part): part is string => part !== null).join('-');
}

export interface StoryShotOptions {
  to: string | null;
  label: string | null;
  story: string | null;
  theme: StoryTheme | null;
  variant: StoryVariant | null;
}

/** After parsing: turn `--story` into the `--to` route and default label. */
export function applyStoryOptions(options: StoryShotOptions): void {
  if (options.story) {
    if (options.to) throw new Error('Pass --to or --story, not both');
    const target = { id: options.story, theme: options.theme, variant: options.variant };
    options.to = storyRoute(target);
    options.label ??= storyLabel(target);
  } else if (options.theme || options.variant) {
    throw new Error('--theme and --variant need --story');
  }
}

export type StoryLogEvent =
  | { kind: 'ready'; storyId: string }
  | { kind: 'scenario'; storyId: string; route: string }
  | { kind: 'missing'; line: string };

/** The first harness line about `id` in `logText`, or null. */
export function findStoryLogEvent(logText: string, id: string): StoryLogEvent | null {
  // The app logs the resolved id, so a bare module id answers as `<module>--<first story>`.
  const idPattern = id.includes('--') ? id : `${id}(?:--[a-z0-9-]+)?`;
  const ready = new RegExp(`\\[stories\\] ready (${idPattern})(?![a-z0-9-])`);
  const scenario = new RegExp(`\\[stories\\] scenario (${idPattern}) -> (\\S+)`);
  const missing = new RegExp(`\\[stories\\] missing ${id}(?![a-z0-9-]).*`);
  for (const line of logText.split('\n')) {
    const readyMatch = ready.exec(line);
    if (readyMatch) return { kind: 'ready', storyId: readyMatch[1] };
    const scenarioMatch = scenario.exec(line);
    if (scenarioMatch) return { kind: 'scenario', storyId: scenarioMatch[1], route: scenarioMatch[2] };
    const missingMatch = missing.exec(line);
    if (missingMatch) return { kind: 'missing', line: missingMatch[0] };
  }
  return null;
}

/**
 * The Metro log a `screenshot`/`navigate` run should watch: `--metro-log` when
 * given, otherwise the most recently written of this port's tee log, the 8081
 * tee log, and `vp run dev:mobile`'s `.boardsesh/mobile-metro.log`.
 */
export function resolveMetroLogPath(explicit: string | null, rootDir: string, port: number = METRO_PORT): string {
  if (explicit) return resolve(explicit);
  const candidates = [
    ...new Set([metroLogPathForPort(port), METRO_LOG_PATH, join(rootDir, '.boardsesh', 'mobile-metro.log')]),
  ];
  const existing = candidates
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return existing[0] ?? candidates[0];
}

/**
 * After navigating to a story, wait for its harness line in the Metro log
 * (written after `offset`), then settle briefly. A scenario story opens a real
 * screen, so it gets the normal `fallbackSettleSeconds`. No line within the
 * timeout: warn and return so the caller still captures. A missing story throws
 * with the app's "did you mean" list.
 */
export function settleAfterStory(
  id: string,
  logPath: string,
  offset: number,
  fallbackSettleSeconds: number,
  logPrefix: string,
): void {
  if (!existsSync(logPath)) {
    console.warn(`${logPrefix} No Metro log at ${logPath}; waiting the fixed ${fallbackSettleSeconds}s settle.`);
    sleepSeconds(fallbackSettleSeconds);
    return;
  }
  const line = waitForMetroLogLine(
    (candidate) => findStoryLogEvent(candidate, id) !== null,
    offset,
    STORY_READY_TIMEOUT_SECONDS,
    logPath,
  );
  const event = line === null ? null : findStoryLogEvent(line, id);
  if (event === null) {
    console.warn(
      `${logPrefix} WARNING: no "[stories] ready ${id}" in ${logPath} after ${STORY_READY_TIMEOUT_SECONDS}s; ` +
        `capturing anyway. (Re-opening the story already on screen doesn't remount it; ` +
        `Metro started elsewhere needs --metro-log <its log>.)`,
    );
    return;
  }
  if (event.kind === 'missing') throw new Error(event.line.replace('[stories] missing', 'No story'));
  if (event.kind === 'scenario') {
    console.log(
      `${logPrefix} Scenario ${event.storyId} opened ${event.route}; settling ${fallbackSettleSeconds}s for it.`,
    );
    sleepSeconds(fallbackSettleSeconds);
    return;
  }
  console.log(`${logPrefix} Story ${event.storyId} is ready.`);
  sleepSeconds(STORY_READY_SETTLE_SECONDS);
}
