import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import type { OgClimbCardIdentity } from '@/app/components/board-renderer/util';
import type { BoardName } from '@/app/lib/types';

/**
 * The climb identity an OG share card draws.
 *
 * One builder because two places need the identical value: `generateMetadata`
 * puts it in the card URL, and the SSR warmer fetches that URL to prime the
 * backend's byte cache. The identity is part of the URL and therefore part of
 * the cache key, so a warmer that built it even slightly differently would warm
 * a card nobody is about to ask for and leave the real one cold.
 *
 * Lives here rather than beside the URL builder so the board-renderer util
 * module keeps the export surface its many test mocks already stub.
 */
export function buildOgClimbCardIdentity(
  climb: { name?: string | null; difficulty?: string | null; setter_username?: string | null },
  boardName: BoardName,
  canonicalAngle: number,
): OgClimbCardIdentity {
  return {
    name: resolveClimbDisplayName(climb.name, boardName),
    grade: climb.difficulty,
    setter: climb.setter_username,
    angle: canonicalAngle,
  };
}
