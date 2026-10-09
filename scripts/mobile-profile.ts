/// <reference types="node" />
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseMobileProfileArgs, prepareProfile } from './lib/mobile-profile-prepare';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Usage: vp exec tsx scripts/mobile-profile.ts prepare|capture
  --suite hig-cpu --source-ref <commit> --platform ios|android --device <physical-id>
  --fixtures <fixture-directory> --run-dir <evidence-directory>
  --backend-url http://<private-host>:8198 --control-url ws://<private-host>:8199
  [--checkout <fresh-clean-worktree>] [--app-path <Release.app|Release.apk>]
  [--flow <Maestro.yaml>] [--cycles 10] [--warmups 2] [--idle-ms 10000] [--end-settle-ms 0] [--control-bind 127.0.0.1]
  [--ui-driver maestro|wda] [--wda-url http://<owned-runner-host>:8211]
prepare injects local-only instrumentation and emits build-env.json; native builds are a separate owned handoff.
capture requires the signed source-built export and a provided segmented flow. iOS requires the owned physical WDA runner; Android uses Maestro. It never installs, uninstalls or clears app data.`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  const options = parseMobileProfileArgs(argv);
  if (options.mode === 'prepare') {
    const prepared = await prepareProfile(options, ROOT);
    console.log(
      JSON.stringify(
        {
          prepared: true,
          checkout: prepared.checkout,
          runDirectory: options.runDir,
          buildId: prepared.buildId,
          instrumentationSha256: prepared.instrumentationSha256,
          appId: prepared.appId,
          scheme: prepared.scheme,
          next: 'Use build-env.json and build-handoff.json with the owned native Release build wrapper.',
        },
        null,
        2,
      ),
    );
  } else {
    const { captureProfile } = await import('./lib/mobile-profile-harness');
    await captureProfile(options);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
