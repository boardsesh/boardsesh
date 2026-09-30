import type { BackgroundWorkerRole } from '@boardsesh/db/background-jobs';
import { findFamily } from './families';
import { requireRunId } from './jobs';

export type OperatorCommand =
  | { action: 'enqueue'; family: string; payload: Record<string, unknown>; runId?: string }
  | { action: 'status'; runId: string }
  | { action: 'replay'; runId: string; newRunId?: string }
  | { action: 'probe'; runId?: string };

function invalid(): never {
  throw new Error('INVALID_OPERATOR_ARGUMENTS');
}

/** Split `--id <uuid>` (the only flag) from positional arguments. */
function splitIdFlag(argumentList: readonly string[]): { positional: string[]; runId?: string } {
  const positional: string[] = [];
  let runId: string | undefined;
  for (let index = 0; index < argumentList.length; index++) {
    const argument = argumentList[index];
    if (argument === '--id') {
      if (runId !== undefined || index + 1 >= argumentList.length) invalid();
      runId = requireRunId(argumentList[++index]);
    } else if (argument.startsWith('--')) {
      invalid();
    } else {
      positional.push(argument);
    }
  }
  return { positional, runId };
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('INVALID_PAYLOAD');
  }
}

/**
 * Parse and validate an operator command line for one worker role.
 *
 * `enqueue` accepts only a family the role serves, and only a payload that
 * family's schema accepts; there is no way to name a queue or pass SQL.
 */
export function parseOperatorArgs(argumentList: readonly string[], role: BackgroundWorkerRole): OperatorCommand {
  const [action, ...rest] = argumentList;
  const { positional, runId } = splitIdFlag(rest);
  switch (action) {
    case 'enqueue': {
      const [familyName, payloadText, ...extra] = positional;
      if (!familyName || extra.length) invalid();
      const family = findFamily(familyName);
      if (!family || !family.roles.includes(role)) throw new Error('UNKNOWN_FAMILY');
      const parsed = family.payload.safeParse(payloadText === undefined ? {} : parseJsonObject(payloadText));
      if (!parsed.success) throw new Error('INVALID_PAYLOAD');
      const { data: payload } = parsed;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('INVALID_PAYLOAD');
      return { action, family: family.name, payload: payload as Record<string, unknown>, runId };
    }
    case 'status': {
      if (positional.length !== 1 || runId !== undefined) invalid();
      return { action, runId: requireRunId(positional[0]) };
    }
    case 'replay': {
      if (positional.length !== 1) invalid();
      return { action, runId: requireRunId(positional[0]), newRunId: runId };
    }
    case 'probe': {
      if (positional.length > 1 || (positional.length === 1 && runId !== undefined)) invalid();
      return { action, runId: positional.length === 1 ? requireRunId(positional[0]) : runId };
    }
    default:
      return invalid();
  }
}
