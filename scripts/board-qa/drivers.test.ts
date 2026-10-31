import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import {
  AndroidDriver,
  IosDriver,
  assertIosFlow,
  assertRecordedAndroidFlow,
  assertRunnerProcess,
  cancelCommands,
  command,
  expand,
  readFlow,
} from './drivers';
import { Evidence } from './evidence';

const directories: string[] = [];
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'boardsesh-qa-driver-test-'));
  directories.push(path);
  return path;
}
function flow(
  root: string,
  name: string,
  commands: unknown[],
  header: Record<string, unknown> = { appId: '${APP_ID}' },
): string {
  const filename = join(root, name);
  mkdirSync(resolve(filename, '..'), { recursive: true });
  writeFileSync(filename, stringify(header) + '---\n' + stringify(commands));
  return filename;
}
const variables = { APP_ID: 'com.boardsesh.app', TARGET: 'fixture-wall' };

afterEach(() => {
  vi.unstubAllGlobals();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('physical flow preflight', () => {
  it('normalizes no-argument Maestro actions and rejects Android-only actions on iOS before execution', () => {
    const root = directory();
    const filename = flow(root, 'main.yaml', ['eraseText', 'launchApp', 'waitForAnimationToEnd']);
    expect(readFlow(filename, variables)).toEqual([
      { eraseText: null },
      { launchApp: null },
      { waitForAnimationToEnd: null },
    ]);
    const notification = flow(root, 'notification.yaml', [{ runFlow: { commands: ['openNotifications'] } }]);
    const commands = readFlow(notification, variables);
    expect(() => assertRecordedAndroidFlow(commands)).not.toThrow();
    expect(() => assertIosFlow(commands)).toThrow('Android-only');
    const back = flow(root, 'back.yaml', [{ pressKey: 'Back' }]);
    const backCommands = readFlow(back, variables);
    expect(() => assertRecordedAndroidFlow(backCommands)).not.toThrow();
    expect(() => assertIosFlow(backCommands)).toThrow('Android-only');
  });
  it('inlines nested relative files before the flow is relocated, preserving runtime conditions', () => {
    const root = directory();
    flow(root, 'nested/leaf.yaml', [{ tapOn: { id: '${TARGET}' } }]);
    flow(root, 'nested/include.yaml', [
      { runFlow: { when: { notVisible: { id: 'already-connected' } }, file: 'leaf.yaml' } },
    ]);
    const filename = flow(root, 'main.yaml', [
      { runFlow: 'nested/include.yaml' },
      { assertVisible: { id: '${TARGET}' } },
    ]);
    expect(readFlow(filename, variables)).toEqual([
      { runFlow: { when: { notVisible: { id: 'already-connected' } }, commands: [{ tapOn: { id: 'fixture-wall' } }] } },
      { assertVisible: { id: 'fixture-wall' } },
    ]);
  });

  it('checks missing variables in an included conditional branch before executing earlier actions', () => {
    const root = directory();
    flow(root, 'included.yaml', [{ tapOn: { id: '${MISSING}' } }]);
    const filename = flow(root, 'main.yaml', [
      { tapOn: { id: 'first-action' } },
      { runFlow: { when: { visible: 'Never visible' }, file: 'included.yaml' } },
    ]);
    expect(() => readFlow(filename, variables)).toThrow('Missing flow variable MISSING');
  });

  it.each(['clearState', 'clearKeychain', 'clearAppData'])('rejects nested %s, including false values', (key) => {
    const root = directory();
    const filename = flow(root, 'main.yaml', [{ runFlow: { commands: [{ launchApp: { [key]: false } }] } }]);
    expect(() => readFlow(filename, variables)).toThrow(`Hardware flows prohibit ${key}`);
  });

  it('validates every included command and refuses destructive hooks in the header', () => {
    const root = directory();
    const unknown = flow(root, 'unknown.yaml', [{ runFlow: { commands: [{ clearKeychain: null }] } }]);
    expect(() => readFlow(unknown, variables)).toThrow('clearKeychain');
    const hook = flow(root, 'header.yaml', [{ assertVisible: 'Home' }], {
      appId: '${APP_ID}',
      onFlowStart: [{ clearState: null }],
    });
    expect(() => readFlow(hook, variables)).toThrow('Unsupported physical QA action fields');
  });

  it('refuses unsupported commands even under an unfulfilled condition', () => {
    const root = directory();
    flow(root, 'included.yaml', [{ runScript: 'arbitrary.js' }]);
    const filename = flow(root, 'main.yaml', [
      { runFlow: { when: { visible: 'Never visible' }, file: 'included.yaml' } },
    ]);
    expect(() => readFlow(filename, variables)).toThrow('Unsupported physical QA action runScript');
  });

  it('refuses absolute includes and parent-directory escapes', () => {
    const root = directory();
    const outside = flow(root, 'outside.yaml', [{ assertVisible: 'Home' }]);
    const absolute = flow(root, 'absolute.yaml', [{ runFlow: outside }]);
    expect(() => readFlow(absolute, variables)).toThrow('relative paths');
    const parent = flow(root, 'nested/parent.yaml', [{ runFlow: '../outside.yaml' }]);
    expect(() => readFlow(parent, variables)).toThrow('escapes its root');
  });

  it('refuses escaping symlinks and include cycles', () => {
    const root = directory();
    const outsideRoot = directory();
    const outside = flow(outsideRoot, 'outside.yaml', [{ assertVisible: 'Home' }]);
    symlinkSync(outside, join(root, 'linked.yaml'));
    const linked = flow(root, 'linked-main.yaml', [{ runFlow: 'linked.yaml' }]);
    expect(() => readFlow(linked, variables)).toThrow('escapes its root');
    const first = flow(root, 'first.yaml', [{ runFlow: 'second.yaml' }]);
    flow(root, 'second.yaml', [{ runFlow: 'first.yaml' }]);
    expect(() => readFlow(first, variables)).toThrow('Recursive flow include');
  });

  it('refuses optional selectors, ambiguous conditions, and an unexpected app ID', () => {
    const root = directory();
    const optional = flow(root, 'optional.yaml', [{ tapOn: { id: 'required-control', optional: true } }]);
    expect(() => readFlow(optional, variables)).toThrow('Unsupported');
    const ambiguous = flow(root, 'ambiguous.yaml', [
      { runFlow: { when: { visible: 'One', notVisible: 'Two' }, commands: [] } },
    ]);
    expect(() => readFlow(ambiguous, variables)).toThrow('exactly one visibility condition');
    const anotherApp = flow(root, 'another-app.yaml', [{ launchApp: null }], { appId: 'another.package' });
    expect(() => readFlow(anotherApp, variables)).toThrow('different app');
  });

  it('rejects malformed YAML and multiple actions in one command', () => {
    const root = directory();
    const filename = flow(root, 'many.yaml', [{ tapOn: 'First', openLink: 'com.boardsesh.app://record' }]);
    expect(() => readFlow(filename, variables)).toThrow('One action per flow step');
    writeFileSync(filename, 'appId: ${APP_ID}\n---\n- tapOn: [broken\n');
    expect(() => readFlow(filename, variables)).toThrow('two-document Maestro flow');
  });

  it('compiles every shipped fragment without leaving relative includes', () => {
    const root = resolve('packages/mobile/.maestro/board-qa');
    for (const name of readdirSync(root).filter((filename) => filename.endsWith('.yaml'))) {
      const filename = join(root, name);
      const variableNames = [...readFileSync(filename, 'utf8').matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(
        (match) => match[1],
      );
      // Includes have their own variables too, and must be resolved up front.
      const supplied: Record<string, string> = {
        ...variables,
        CLIMB_URL: 'com.boardsesh.app://b/qa/play/climb',
        CLIMB_LABEL_PATTERN: 'Fixture climb',
        ACCOUNT_URL: 'com.boardsesh.app://account',
        USER_ID: 'qa-user',
      };
      variableNames.forEach((key) => {
        supplied[key] ??= 'fixture';
      });
      expect(() => readFlow(filename, supplied), name).not.toThrow();
    }
  });

  it('only substitutes explicitly supplied placeholders', () => {
    expect(expand({ tapOn: { id: '${TARGET}' } }, variables)).toEqual({ tapOn: { id: 'fixture-wall' } });
    expect(() => expand('${MISSING}', variables)).toThrow('Missing flow variable MISSING');
  });
});

describe('recorded Android execution', () => {
  it('targets every top-level deep link to the selected package and keeps intervening UI steps in Maestro', async () => {
    const root = directory();
    const filename = flow(root, 'package-route.yaml', [
      { openLink: 'com.boardsesh.app://account' },
      { assertVisible: { id: 'account-user-fixture' } },
      { openLink: 'com.boardsesh.app://b/fixture?wall=qa&angle=40' },
      { tapOn: { id: 'play-drawer-next' } },
    ]);
    const evidence = new Evidence(join(root, 'evidence'));
    const maestroCommands: string[] = [];
    const run = vi.fn(async (executable: string, argumentsList: string[]) => {
      if (executable === 'maestro') {
        const contents = readFileSync(argumentsList.at(-1)!, 'utf8');
        expect(contents).not.toContain('openLink');
        maestroCommands.push(contents);
      }
      return 'Status: ok';
    });
    const driver = new AndroidDriver(
      { id: 'owned-phone', appId: 'com.boardsesh.app.dev', scheme: 'com.boardsesh.app', email: 'qa@example.com' },
      '/owned/adb',
      evidence,
      run,
    );
    await driver.flow(filename);
    expect(run.mock.calls.map(([executable]) => executable)).toEqual([
      '/owned/adb',
      'maestro',
      '/owned/adb',
      'maestro',
    ]);
    expect(run.mock.calls[0][1]).toEqual([
      '-s',
      'owned-phone',
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      "'com.boardsesh.app://account'",
      '-p',
      "'com.boardsesh.app.dev'",
    ]);
    expect(run.mock.calls[2][1]).toEqual([
      '-s',
      'owned-phone',
      'shell',
      'am',
      'start',
      '-W',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      "'com.boardsesh.app://b/fixture?wall=qa&angle=40'",
      '-p',
      "'com.boardsesh.app.dev'",
    ]);
    expect(maestroCommands[0]).toContain('account-user-fixture');
    expect(maestroCommands[1]).toContain('play-drawer-next');
    expect(run.mock.calls.flatMap(([, argumentsList]) => argumentsList)).not.toContain('com.boardsesh.app.debug');
    expect(run.mock.calls.flatMap(([, argumentsList]) => argumentsList)).not.toContain('com.boardsesh.app.perf');
  });

  it('rejects a conditional deep link before any earlier top-level action executes', async () => {
    const root = directory();
    const filename = flow(root, 'conditional-route.yaml', [
      { openLink: 'com.boardsesh.app://account' },
      { runFlow: { when: { visible: 'Fixture' }, commands: [{ openLink: 'com.boardsesh.app://record' }] } },
    ]);
    const run = vi.fn(async () => '');
    const driver = new AndroidDriver(
      { id: 'owned-phone', appId: variables.APP_ID, scheme: 'com.boardsesh.app', email: 'qa@example.com' },
      '/owned/adb',
      new Evidence(join(root, 'evidence')),
      run,
    );
    await expect(driver.flow(filename)).rejects.toThrow('Conditional Android openLink');
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses text entry recursively so Maestro cannot retain a password', () => {
    expect(() => assertRecordedAndroidFlow([{ runFlow: { commands: [{ inputText: 'private-password' }] } }])).toThrow(
      'sign in manually',
    );
    expect(() => assertRecordedAndroidFlow([{ eraseText: null }])).toThrow('sign in manually');
  });

  it('writes only validated inlined flows privately, redacts logs, and removes the temporary file', async () => {
    const root = directory();
    flow(root, 'included.yaml', [{ assertVisible: { id: '${TARGET}' } }]);
    const filename = flow(root, 'main.yaml', [{ runFlow: 'included.yaml' }]);
    const evidence = new Evidence(join(root, 'evidence'));
    evidence.secret('private-token');
    let temporary = '';
    const run = vi.fn(async (_executable: string, argumentsList: string[]) => {
      temporary = argumentsList.at(-1)!;
      expect(statSync(temporary).mode & 0o777).toBe(0o600);
      expect(readFileSync(temporary, 'utf8')).toContain('fixture-wall');
      expect(readFileSync(temporary, 'utf8')).not.toContain('runFlow');
      return 'driver diagnostic private-token';
    });
    const driver = new AndroidDriver(
      { id: 'owned-phone', appId: variables.APP_ID, scheme: 'com.boardsesh.app', email: 'qa@example.com' },
      '/owned/adb',
      evidence,
      run,
    );
    await driver.flow(filename, { TARGET: 'fixture-wall' });
    expect(run).toHaveBeenCalledOnce();
    expect(existsSync(temporary)).toBe(false);
    const logs = readFileSync(join(evidence.directory, 'events.jsonl'), 'utf8');
    expect(logs).not.toContain('private-token');
    expect(logs).toContain('[REDACTED]');
  });

  it('rejects included login input before spawning Maestro or writing an expanded artifact', async () => {
    const root = directory();
    flow(root, 'login.yaml', [{ inputText: '${QA_PASSWORD}' }]);
    const filename = flow(root, 'main.yaml', [{ runFlow: { when: { visible: 'Login' }, file: 'login.yaml' } }]);
    const evidence = new Evidence(join(root, 'evidence'));
    const run = vi.fn(async () => '');
    const driver = new AndroidDriver(
      { id: 'owned-phone', appId: variables.APP_ID, scheme: 'com.boardsesh.app', email: 'qa@example.com' },
      '/owned/adb',
      evidence,
      run,
    );
    await expect(driver.flow(filename, { QA_PASSWORD: 'private-password' })).rejects.toThrow('sign in manually');
    expect(run).not.toHaveBeenCalled();
    expect(readdirSync(evidence.directory)).toEqual([]);
  });
});

describe('selected physical iPhone runner', () => {
  it('executes deep links and physical UI actions against the pinned WDA API contract, rejecting unknown routes', async () => {
    const root = directory();
    const evidence = new Evidence(join(root, 'evidence'));
    evidence.secret('private-password');
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = new URL(String(input));
      const method = options?.method ?? 'GET';
      const body = options?.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : {};
      calls.push({ method, path: url.pathname, body });
      const success = (value: unknown) => Response.json({ value });
      if (method === 'GET' && url.pathname === '/status')
        return success({
          ready: true,
          ios: {},
          build: {
            profileRunnerBundleId: 'com.boardsesh.boardqa.runner.xctrunner',
            profileRunnerSourceCommit: 'pinned-source',
            profileRunnerPid: 42,
          },
        });
      if (method === 'POST' && url.pathname === '/session') {
        expect(body.capabilities).toEqual({
          alwaysMatch: {
            bundleId: variables.APP_ID,
            forceAppLaunch: false,
            shouldTerminateApp: false,
            shouldWaitForQuiescence: false,
            waitForIdleTimeout: 0,
          },
        });
        return success({ sessionId: 'owned-session' });
      }
      if (method === 'POST' && url.pathname === '/session/owned-session/url') {
        expect(body).toEqual({ url: 'com.boardsesh.app://account', bundleId: variables.APP_ID });
        return success(null);
      }
      if (method === 'POST' && url.pathname === '/session/owned-session/elements')
        return success(
          String(body.value).includes('missing-control')
            ? []
            : [{ 'element-6066-11e4-a52e-4f735466cecf': 'owned-element' }],
        );
      if (method === 'GET' && url.pathname === '/session/owned-session/element/owned-element/rect')
        return success({ x: 10, y: 20, width: 100, height: 40 });
      if (method === 'GET' && url.pathname === '/session/owned-session/window/size')
        return success({ width: 400, height: 800 });
      if (method === 'GET' && url.pathname === '/session/owned-session/source') {
        expect(url.searchParams.get('format')).toBe('xml');
        expect(url.searchParams.get('excluded_attributes')).toBe('visible,accessible,customActions');
        return success('<App name="account-user-fixture"/>');
      }
      if (method === 'GET' && url.pathname === '/session/owned-session/screenshot')
        return success(Buffer.from('fixture-screen-bytes').toString('base64'));
      const commands = [
        'POST /session/owned-session/element/owned-element/click',
        'POST /session/owned-session/actions',
        'POST /session/owned-session/wda/keys',
        'POST /session/owned-session/wda/apps/activate',
        'POST /session/owned-session/wda/apps/terminate',
        'POST /wda/homescreen',
        'DELETE /session/owned-session',
      ];
      if (commands.includes(`${method} ${url.pathname}`)) return success(null);
      return Response.json({ value: { error: 'unknown command' } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    const inspect = vi.fn(async (_executable: string, argumentsList: string[]) => {
      const output = argumentsList[argumentsList.indexOf('--json-output') + 1];
      writeFileSync(
        output,
        JSON.stringify({
          result: {
            runningProcesses: [
              {
                processIdentifier: 42,
                executable: '/private/owned/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner',
              },
            ],
          },
        }),
      );
      return '';
    });
    const driver = new IosDriver(
      {
        id: '00008110-0000000000000001',
        appId: variables.APP_ID,
        scheme: 'com.boardsesh.app',
        email: 'qa@example.com',
        wdaUrl: 'http://127.0.0.1:8211',
        runnerBundleId: 'com.boardsesh.boardqa.runner.xctrunner',
      },
      evidence,
      inspect,
    );
    await driver.attach();
    const filename = flow(root, 'physical.yaml', [
      { openLink: 'com.boardsesh.app://account' },
      { assertVisible: { id: 'actual-control' } },
      { assertNotVisible: { id: 'missing-control' } },
      { tapOn: { id: 'actual-control' } },
      { longPressOn: { id: 'actual-control' } },
      { inputText: 'private-password' },
      'eraseText',
      { swipe: { start: '80%,50%', end: '20%,50%', duration: 300 } },
      'launchApp',
      { pressKey: 'Home' },
      { takeScreenshot: 'proof' },
    ]);
    await driver.flow(filename);
    expect(await driver.hierarchy()).toBe('<App name="account-user-fixture"/>');
    await driver.restart();
    await driver.close();
    expect(calls).toContainEqual({
      method: 'POST',
      path: '/session/owned-session/url',
      body: { url: 'com.boardsesh.app://account', bundleId: variables.APP_ID },
    });
    expect(calls.some((call) => call.path.includes('deeplink'))).toBe(false);
    expect(readFileSync(join(evidence.directory, 'proof.png'), 'utf8')).toBe('fixture-screen-bytes');
    expect(readFileSync(join(evidence.directory, 'events.jsonl'), 'utf8')).not.toContain('private-password');
  });

  const executable = '/private/owned/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner';
  it('matches the exact numeric PID and runner executable', () => {
    expect(() =>
      assertRunnerProcess({ result: { runningProcesses: [{ processIdentifier: 42, executable }] } }, 42),
    ).not.toThrow();
  });
  it.each([
    { processIdentifier: 142, executable },
    { processIdentifier: '42', executable },
    { processIdentifier: 42, executable: '/private/Another.app/Another' },
  ])('rejects a substring PID or another executable: %j', (process) => {
    expect(() => assertRunnerProcess({ result: { runningProcesses: [process] } }, 42)).toThrow('do not match');
  });
});

describe('owned command lifetime', () => {
  it('captures output and rejects nonzero exits', async () => {
    await expect(command(process.execPath, ['-e', 'process.stdout.write("ready")'])).resolves.toBe('ready');
    await expect(command(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow('exited 3');
  });

  it('escalates an ignored SIGTERM and leaves no running child', async () => {
    const root = directory();
    const pidFile = join(root, 'owned.pid');
    const program =
      'const fs=require("node:fs");process.on("SIGTERM",()=>{});fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);';
    await expect(command(process.execPath, ['-e', program, pidFile], 300)).rejects.toThrow('timed out');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((resume) => setTimeout(resume, 50));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('cancels only owned active commands and waits for their bounded cleanup', async () => {
    const running = command(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const verdict = expect(running).rejects.toThrow('cancelled');
    await cancelCommands();
    await verdict;
    await expect(cancelCommands()).resolves.toBeUndefined();
  });
});
