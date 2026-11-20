/// <reference types="node" />

/**
 * The shots scripts' half of the dev-only story harness (docs/mobile/mobile-stories.md).
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
import {
  DEFAULT_METRO_PORT,
  METRO_LOG_PATH,
  METRO_PORT,
  metroLogPathForPort,
  waitForMetroLogLine,
} from './metro-dev-server';
import { sleepSeconds } from './exec';
import { readCaptureLogs, waitForCaptureLogLine, type CaptureLogBoundary } from './capture-readiness-logs';

export const STORY_THEMES = ['dark', 'light'] as const;
export const STORY_VARIANTS = ['liquidGlass', 'material'] as const;
export type StoryTheme = (typeof STORY_THEMES)[number];
export type StoryVariant = (typeof STORY_VARIANTS)[number];

/** Maximum time for the requested story to report a completed paint. */
export const STORY_READY_TIMEOUT_SECONDS = 15;
/** Extra settle after the ready line, for entry animations and an async theme switch. */
export const STORY_READY_SETTLE_SECONDS = 0.5;

// Kebab-case module id, optionally `--` and a kebab-case story key
// (packages/mobile/src/dev/stories/registry-core.ts). A bare module id opens
// the story declared first in that file.
const STORY_ID = /^[a-z0-9]+(?:--?[a-z0-9]+)*$/;

export interface StoryTarget {
  renderMode?: string | null;
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

/**
 * The deep-link route (no scheme) that opens a story. `shot` is a nonce: a new
 * value makes the story already on screen log its ready line again, so a
 * re-shoot after an edit, or with another `--theme`, doesn't wait out the timeout.
 */
export function storyRoute(target: StoryTarget, shot: number = Date.now()): string {
  const query = [
    target.theme ? `theme=${target.theme}` : null,
    target.variant ? `variant=${target.variant}` : null,
    target.renderMode ? `renderMode=${encodeURIComponent(target.renderMode)}` : null,
    `shot=${shot}`,
  ].filter((part): part is string => part !== null);
  return `dev/stories/${target.id}?${query.join('&')}`;
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
  | { kind: 'missing'; line: string }
  | { kind: 'error'; line: string };

/** The first harness line about `id` in `logText`, or null. */
export function findStoryLogEvent(logText: string, id: string): StoryLogEvent | null {
  // The app logs the resolved id, so a bare module id answers as `<module>--<first story>`.
  const idPattern = id.includes('--') ? id : `${id}(?:--[a-z0-9-]+)?`;
  const ready = new RegExp(`\\[stories\\] ready (${idPattern})(?![a-z0-9-])`);
  const scenario = new RegExp(`\\[stories\\] scenario (${idPattern}) -> (\\S+)`);
  const missing = new RegExp(`\\[stories\\] missing ${id}(?![a-z0-9-]).*`);
  const error = new RegExp(`\\[stories\\] error (?:${idPattern}|root)(?![a-z0-9-]).*`);
  const errorMatch = error.exec(logText);
  if (errorMatch) return { kind: 'error', line: errorMatch[0] };
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
 * The Metro log a `screenshot`/`navigate` run should watch. `--metro-log` wins.
 * On a port other than 8081 it is that port's `run` tee log, or this checkout's
 * `vp run dev:mobile` log (`.boardsesh/mobile-metro.log`) when there is no tee
 * log: never the newest log in TMPDIR, which other sessions share, so another
 * session's 8081 Metro could win. On 8081 it is the newer of the 8081 tee log
 * and the dev:mobile log.
 */
export function resolveMetroLogPath(explicit: string | null, rootDir: string, port: number = METRO_PORT): string {
  if (explicit) return resolve(explicit);
  const portLog = metroLogPathForPort(port);
  const devMobileLog = join(rootDir, '.boardsesh', 'mobile-metro.log');
  if (port !== DEFAULT_METRO_PORT) {
    return existsSync(portLog) || !existsSync(devMobileLog) ? portLog : devMobileLog;
  }
  const existing = [METRO_LOG_PATH, devMobileLog]
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return existing[0] ?? METRO_LOG_PATH;
}

/** A visual capture succeeds only after the requested view reports readiness. */
export function settleAfterStory(
  id: string,
  logPath: string,
  offset: number,
  _fallbackSettleSeconds: number,
  logPrefix: string,
  additionalLogs: readonly CaptureLogBoundary[] = [],
): void {
  if (!existsSync(logPath)) {
    throw new Error(`${logPrefix} No Metro log at ${logPath}; cannot verify story ${id}. Pass --metro-log.`);
  }
  const boundaries = [{ path: logPath, offset }, ...additionalLogs];
  const matches = (candidate: string) => findStoryLogEvent(candidate, id) !== null;
  const line = additionalLogs.length
    ? waitForCaptureLogLine(matches, boundaries, STORY_READY_TIMEOUT_SECONDS)
    : waitForMetroLogLine(matches, offset, STORY_READY_TIMEOUT_SECONDS, logPath);
  const event = line === null ? null : findStoryLogEvent(line, id);
  if (event === null) {
    throw new Error(
      `${logPrefix} Story ${id} did not report readiness within ${STORY_READY_TIMEOUT_SECONDS}s. ` +
        `Check required assets and the Metro log at ${logPath}.`,
    );
  }
  if (event.kind === 'missing') throw new Error(event.line.replace('[stories] missing', 'No story'));
  if (event.kind === 'error') throw new Error(event.line);
  if (event.kind === 'scenario') {
    throw new Error(`Story ${id} redirects to ${event.route}; capture a view story with explicit readiness instead.`);
  }
  // The line poll returns the first match. Scan the whole capture interval so
  // a later asset failure cannot be hidden by an earlier readiness marker.
  const assertNoFailure = () => {
    for (const candidate of readCaptureLogs(boundaries).split('\n')) {
      const latest = findStoryLogEvent(candidate, id);
      if (latest?.kind === 'error') throw new Error(latest.line);
      if (latest?.kind === 'missing') throw new Error(latest.line.replace('[stories] missing', 'No story'));
      if (latest?.kind === 'scenario')
        throw new Error(
          `Story ${id} redirects to ${latest.route}; capture a view story with explicit readiness instead.`,
        );
    }
  };
  assertNoFailure();
  sleepSeconds(STORY_READY_SETTLE_SECONDS);
  assertNoFailure();
  console.log(`${logPrefix} Story ${event.storyId} is ready.`);
}

/** Story captures never inherit live-app fixture transports or test credentials. */
export function buildStoryEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const storyEnv = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !key.startsWith('EXPO_PUBLIC_SCREENSHOT_')),
  );
  return { ...storyEnv, EXPO_PUBLIC_STORY_MODE: '1' };
}

export function isStoryRootReadyLine(line: string): boolean {
  return line.includes('[stories] root ready');
}
