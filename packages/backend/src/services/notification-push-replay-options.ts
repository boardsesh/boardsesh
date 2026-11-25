export type PushReplayOptions = { apply: boolean; limit: number };

export function parsePushReplayArgs(argv: readonly string[]): PushReplayOptions {
  let apply = false;
  let limit = 25;
  let hasLimit = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--apply' && !apply) apply = true;
    else if (flag === '--limit' && !hasLimit) {
      const argument = argv[++index];
      if (!argument || !/^\d+$/.test(argument) || Number(argument) < 1 || Number(argument) > 200)
        throw new Error('PUSH_REPLAY_LIMIT_MUST_BE_1_TO_200');
      limit = Number(argument);
      hasLimit = true;
    } else throw new Error('PUSH_REPLAY_INVALID_ARGUMENT');
  }
  return { apply, limit };
}
