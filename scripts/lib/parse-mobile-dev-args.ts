export type ParsedMobileDevArgs = {
  qaNotesFilePath: string | null;
  simulator: boolean;
  passthroughArgs: string[];
};

export function parseMobileDevArgs(args: string[], env: NodeJS.ProcessEnv = process.env): ParsedMobileDevArgs {
  let qaNotesFilePath: string | null = null;
  let simulator = env.BOARDSESH_DEV_SIMULATOR === '1';
  const passthroughArgs: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;

    if (argument === '--simulator') {
      simulator = true;
      continue;
    }

    if (argument === '--qa-notes-file' || argument === '--qa-plan-file') {
      const nextArgument = args[index + 1];
      if (!nextArgument || nextArgument.startsWith('--')) {
        throw new Error(`${argument} requires a file path`);
      }
      qaNotesFilePath = nextArgument;
      index++;
      continue;
    }

    let consumed = false;
    for (const prefix of ['--qa-notes-file=', '--qa-plan-file=']) {
      if (argument.startsWith(prefix)) {
        const pathValue = argument.slice(prefix.length).trim();
        if (!pathValue) {
          throw new Error(`${prefix.slice(0, -1)} requires a file path`);
        }
        qaNotesFilePath = pathValue;
        consumed = true;
        break;
      }
    }
    if (consumed) continue;

    passthroughArgs.push(argument);
  }

  return { qaNotesFilePath, simulator, passthroughArgs };
}
