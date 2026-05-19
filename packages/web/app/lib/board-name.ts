import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import type { BoardName } from './types';

const SUPPORTED_BOARD_SET = new Set<string>(SUPPORTED_BOARDS);

/**
 * Narrow a raw `string` (from a DB column, a URL parameter, or an API
 * payload) to the {@link BoardName} union. Returns `undefined` when the
 * value isn't one of `SUPPORTED_BOARDS` — keeps client code from passing
 * unknown board identifiers into routing / RQ keys / pubsub channels.
 */
export function asBoardName(value: string | undefined | null): BoardName | undefined {
  return value != null && SUPPORTED_BOARD_SET.has(value) ? (value as BoardName) : undefined;
}
