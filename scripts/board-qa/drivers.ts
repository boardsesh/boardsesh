import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseAllDocuments, stringify } from 'yaml';
import { selectorPredicate, swipeActions, percentagePoint } from '../lib/mobile-profile-wda';
import { record, string, type Phone, type QaConfig, type Role } from './config';
import { Evidence, QaFailure, until, requireRunning } from './evidence';

class CommandExitFailure extends QaFailure {}
const ownedCommands = new Set<{ stop: () => void; stopped: Promise<void> }>();

/** Cancel only subprocess groups created by this runner, with a bounded escalation. */
export async function cancelCommands(): Promise<void> {
  const active = [...ownedCommands];
  active.forEach((owned) => owned.stop());
  await Promise.all(active.map((owned) => owned.stopped));
}

export async function command(
  executable: string,
  args: string[],
  timeoutMs = 30_000,
  env = process.env,
): Promise<string> {
  requireRunning();
  return await new Promise((resolveResult, reject) => {
    const ownsGroup = process.platform !== 'win32';
    const child = spawn(executable, args, { env, detached: ownsGroup, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stopping: 'timed out' | 'cancelled' | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped: () => void = () => {};
    const completion = new Promise<void>((finished) => {
      stopped = finished;
    });
    const signal = (name: NodeJS.Signals) => {
      try {
        if (ownsGroup && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        /* The owned process may have exited between the deadline and signal. */
      }
    };
    const stop = (reason: 'timed out' | 'cancelled') => {
      if (stopping) return;
      stopping = reason;
      signal('SIGTERM');
      killTimer = setTimeout(() => {
        signal('SIGKILL');
        ownedCommands.delete(owned);
        stopped();
        reject(new QaFailure(`${executable} ${reason}`, 'infrastructure'));
      }, 1000);
    };
    const owned = { stop: () => stop('cancelled'), stopped: completion };
    ownedCommands.add(owned);
    const timer = setTimeout(() => stop('timed out'), timeoutMs);
    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      ownedCommands.delete(owned);
      stopped();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2_000_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-2_000_000);
    });
    child.on('error', () => {
      clearTimers();
      reject(new QaFailure(`Cannot start ${executable}`, 'infrastructure'));
    });
    child.on('close', (code) => {
      clearTimers();
      if (stopping) reject(new QaFailure(`${executable} ${stopping}`, 'infrastructure'));
      else if (code === 0) resolveResult(output);
      else reject(new CommandExitFailure(`${executable} exited ${code}: ${output.slice(-2000)}`, 'infrastructure'));
    });
  });
}
export function expand(candidate: unknown, variables: Record<string, string>): unknown {
  if (typeof candidate === 'string')
    return candidate.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, key: string) => {
      if (!(key in variables)) throw new Error(`Missing flow variable ${key}`);
      return variables[key];
    });
  if (Array.isArray(candidate)) return candidate.map((entry) => expand(entry, variables));
  if (candidate && typeof candidate === 'object')
    return Object.fromEntries(Object.entries(candidate).map(([key, entry]) => [key, expand(entry, variables)]));
  return candidate;
}
const FLOW_ACTIONS = new Set([
  'openLink',
  'openNotifications',
  'assertVisible',
  'assertNotVisible',
  'extendedWaitUntil',
  'tapOn',
  'longPressOn',
  'inputText',
  'eraseText',
  'swipe',
  'runFlow',
  'takeScreenshot',
  'launchApp',
  'pressKey',
  'waitForAnimationToEnd',
]);
const FORBIDDEN_KEYS = new Set([
  'clearState',
  'clearKeychain',
  'clearAppData',
  'clearMedia',
  'removeMedia',
  'clearContacts',
]);
type FlowStep = Record<string, unknown>;
function forbidResets(candidate: unknown): void {
  if (Array.isArray(candidate)) {
    candidate.forEach(forbidResets);
    return;
  }
  if (!candidate || typeof candidate !== 'object') return;
  for (const [key, contents] of Object.entries(candidate)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Hardware flows prohibit ${key}`);
    forbidResets(contents);
  }
}
function keysOnly(contents: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(contents).some((key) => !allowed.includes(key)))
    throw new Error('Unsupported physical QA action fields');
}
function selector(candidate: unknown): void {
  const fields = typeof candidate === 'string' ? { text: candidate } : record(candidate);
  keysOnly(fields, ['id', 'text', 'index']);
  if (fields.index !== undefined && (!Number.isInteger(fields.index) || Number(fields.index) < 0))
    throw new Error('Invalid selector index');
  selectorPredicate(fields);
}
function condition(candidate: unknown): Record<string, unknown> {
  const when = record(candidate);
  keysOnly(when, ['visible', 'notVisible']);
  if ('visible' in when === 'notVisible' in when) throw new Error('Require exactly one visibility condition');
  selector(when.visible ?? when.notVisible);
  return when;
}
function duration(candidate: unknown, maximum: number): void {
  if (!Number.isFinite(candidate) || Number(candidate) < 0 || Number(candidate) > maximum)
    throw new Error('Flow deadline out of bounds');
}

/** Validate and inline every include before either physical driver performs any UI action. */
export function readFlow(filename: string, variables: Record<string, string>): FlowStep[] {
  const root = realpathSync(dirname(resolve(filename)));
  const stack = new Set<string>();
  let count = 0;
  const commands = (candidate: unknown, directory: string, depth: number): FlowStep[] => {
    if (!Array.isArray(candidate) || depth > 32) throw new Error('Invalid or excessively nested flow commands');
    return candidate.flatMap((entry): FlowStep[] => {
      if (++count > 2000) throw new Error('Flow exceeds the command limit');
      const step = typeof entry === 'string' ? { [entry]: null } : record(entry);
      const entries = Object.entries(step);
      if (entries.length !== 1) throw new Error('One action per flow step');
      const [action, argument] = entries[0];
      if (!FLOW_ACTIONS.has(action)) throw new Error(`Unsupported physical QA action ${action}`);
      if (action === 'runFlow') {
        const include = typeof argument === 'string' ? { file: argument } : record(argument);
        keysOnly(include, ['file', 'commands', 'when']);
        if ('file' in include === 'commands' in include)
          throw new Error('Require exactly one included flow or command list');
        const when = include.when === undefined ? undefined : condition(include.when);
        let included: FlowStep[];
        if ('file' in include) {
          const path = string(include.file);
          if (isAbsolute(path)) throw new Error('Included flows must use relative paths');
          included = file(resolve(directory, path), depth + 1);
        } else included = commands(include.commands, directory, depth + 1);
        return when ? [{ runFlow: { when, commands: included } }] : included;
      }
      if (['tapOn', 'longPressOn', 'assertVisible', 'assertNotVisible'].includes(action)) selector(argument);
      else if (action === 'extendedWaitUntil') {
        const wait = record(argument);
        keysOnly(wait, ['visible', 'notVisible', 'timeout']);
        condition(Object.fromEntries(Object.entries(wait).filter(([key]) => key !== 'timeout')));
        duration(wait.timeout ?? 15_000, 60_000);
      } else if (action === 'launchApp') {
        if (argument !== null && argument !== undefined) keysOnly(record(argument), []);
      } else if (action === 'pressKey') {
        if (argument !== 'Home' && argument !== 'Back')
          throw new Error('Only Home and Android Back keys are supported by physical QA flows');
      } else if (action === 'openNotifications') {
        if (argument !== null && argument !== undefined) throw new Error('openNotifications takes no arguments');
      } else if (action === 'swipe') {
        const gesture = record(argument);
        keysOnly(gesture, ['start', 'end', 'duration']);
        const rectangle = { x: 0, y: 0, width: 100, height: 100 };
        swipeActions(
          percentagePoint(gesture.start, rectangle),
          percentagePoint(gesture.end, rectangle),
          Number(gesture.duration ?? 400),
        );
      } else if (action === 'eraseText') {
        if (
          argument !== null &&
          argument !== undefined &&
          (!Number.isInteger(argument) || Number(argument) < 1 || Number(argument) > 1000)
        )
          throw new Error('Invalid eraseText count');
      } else if (action === 'waitForAnimationToEnd') {
        if (argument !== null && argument !== undefined) {
          const wait = record(argument);
          keysOnly(wait, ['timeout']);
          duration(wait.timeout ?? 500, 10_000);
        }
      } else if (action === 'openLink') {
        if (typeof argument !== 'string') {
          const link = record(argument);
          keysOnly(link, ['link']);
          string(link.link);
        } else string(argument);
      } else string(argument);
      return [step];
    });
  };
  const file = (path: string, depth: number): FlowStep[] => {
    const canonical = realpathSync(path);
    const inside = relative(root, canonical);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      throw new Error('Included flow escapes its root');
    if (stack.has(canonical)) throw new Error('Recursive flow include');
    stack.add(canonical);
    try {
      const documents = parseAllDocuments(readFileSync(canonical, 'utf8'));
      if (documents.length !== 2 || documents.some((document) => document.errors.length))
        throw new Error('Require a two-document Maestro flow');
      const header = record(expand(documents[0].toJSON(), variables));
      keysOnly(header, ['appId', 'name']);
      if (variables.APP_ID !== undefined && header.appId !== variables.APP_ID)
        throw new Error('Flow targets a different app');
      const expanded = expand(documents[1].toJSON(), variables);
      forbidResets(expanded);
      return commands(expanded, dirname(canonical), depth);
    } finally {
      stack.delete(canonical);
    }
  };
  return file(resolve(filename), 0);
}

export function assertRecordedAndroidFlow(commands: FlowStep[]): void {
  for (const step of commands) {
    if ('inputText' in step || 'eraseText' in step)
      throw new QaFailure(
        'Recorded Android flows cannot enter credentials or text; sign in manually before running QA',
        'blocked',
      );
    if (step.runFlow) assertRecordedAndroidFlow(record(step.runFlow).commands as FlowStep[]);
  }
}

export function assertIosFlow(commands: FlowStep[]): void {
  for (const step of commands) {
    if ('openNotifications' in step) throw new QaFailure('openNotifications is an Android-only QA action', 'blocked');
    if (step.pressKey === 'Back') throw new QaFailure('Back is an Android-only QA action', 'blocked');
    if (step.runFlow) assertIosFlow(record(step.runFlow).commands as FlowStep[]);
  }
}

export function assertRunnerProcess(candidate: unknown, expectedPid: number): void {
  const processes = record(record(candidate).result).runningProcesses;
  if (
    !Array.isArray(processes) ||
    !processes.some((entry) => {
      const process = record(entry);
      return (
        process.processIdentifier === expectedPid &&
        typeof process.executable === 'string' &&
        process.executable.endsWith('/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner')
      );
    })
  )
    throw new QaFailure('WDA PID and runner executable do not match the selected physical iPhone', 'blocked');
}
export interface Driver {
  phone: Phone;
  flow(name: string, variables?: Record<string, string>): Promise<void>;
  hierarchy(): Promise<string>;
  background(): Promise<void>;
  foreground(): Promise<void>;
  restart(): Promise<void>;
  screenshot(name: string): Promise<void>;
  close(): Promise<void>;
}
const FLOW_ROOT = resolve('packages/mobile/.maestro/board-qa');
function flowFilename(name: string): string {
  if (/\.ya?ml$/.test(name)) return resolve(name);
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(name)) throw new Error('Invalid physical flow name');
  return join(FLOW_ROOT, `${name}.yaml`);
}
type AndroidFlowGroup = { kind: 'link'; url: string } | { kind: 'maestro'; commands: FlowStep[] };
function androidFlowGroups(commands: FlowStep[]): AndroidFlowGroup[] {
  const prohibitConditionalLinks = (nested: FlowStep[]) => {
    for (const step of nested) {
      if ('openLink' in step)
        throw new QaFailure(
          'Conditional Android openLink is unsupported; use a top-level package-targeted link',
          'blocked',
        );
      if (step.runFlow) prohibitConditionalLinks(record(step.runFlow).commands as FlowStep[]);
    }
  };
  const groups: AndroidFlowGroup[] = [];
  for (const step of commands) {
    if (step.runFlow) prohibitConditionalLinks(record(step.runFlow).commands as FlowStep[]);
    if ('openLink' in step) {
      groups.push({
        kind: 'link',
        url: typeof step.openLink === 'string' ? step.openLink : string(record(step.openLink).link),
      });
    } else {
      const last = groups.at(-1);
      if (last?.kind === 'maestro') last.commands.push(step);
      else groups.push({ kind: 'maestro', commands: [step] });
    }
  }
  return groups;
}
// adb shell joins its arguments for the remote shell. Preserve URI query
// separators and package names literally rather than interpreting shell text.
function androidShellArgument(contents: string): string {
  return `'${contents.replaceAll("'", "'\\''")}'`;
}
export class AndroidDriver implements Driver {
  constructor(
    readonly phone: Phone,
    private adb: string,
    private evidence: Evidence,
    private runCommand: typeof command = command,
  ) {}
  async flow(name: string, variables: Record<string, string> = {}): Promise<void> {
    const filename = flowFilename(name);
    // Expanded flow is owner-only, never carries credentials in process arguments.
    // Delete it even when Maestro dies. Console output is redacted before retention.
    const expanded = readFlow(filename, { APP_ID: this.phone.appId, APP_SCHEME: this.phone.scheme, ...variables });
    assertRecordedAndroidFlow(expanded);
    const groups = androidFlowGroups(expanded);
    const privateDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-board-qa-flow-'));
    try {
      for (const group of groups) {
        requireRunning();
        if (group.kind === 'link') {
          const logs = await this.runCommand(this.adb, [
            '-s',
            this.phone.id,
            'shell',
            'am',
            'start',
            '-W',
            '-a',
            'android.intent.action.VIEW',
            '-d',
            androidShellArgument(group.url),
            '-p',
            androidShellArgument(this.phone.appId),
          ]);
          this.evidence.event('android-open-link', { name, packageId: this.phone.appId, logs });
          continue;
        }
        const temporary = join(privateDirectory, `${randomUUID()}.yaml`);
        writeFileSync(temporary, stringify({ appId: this.phone.appId }) + '---\n' + stringify(group.commands), {
          mode: 0o600,
        });
        const logs = await this.runCommand(
          'maestro',
          [
            '--device',
            this.phone.id,
            'test',
            '--test-output-dir',
            join(this.evidence.directory, 'android-maestro'),
            temporary,
          ],
          180_000,
          { ...process.env, PATH: `${dirname(this.adb)}:${process.env.PATH ?? ''}` },
        );
        this.evidence.event('android-flow', { name, logs });
      }
    } catch (error) {
      const kind = error instanceof CommandExitFailure ? 'failed' : 'infrastructure';
      throw new QaFailure(this.evidence.redact(error instanceof Error ? error.message : String(error)), kind);
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true });
    }
  }
  async hierarchy(): Promise<string> {
    return await this.runCommand(this.adb, ['-s', this.phone.id, 'exec-out', 'uiautomator', 'dump', '/dev/tty']);
  }
  async background(): Promise<void> {
    await this.runCommand(this.adb, ['-s', this.phone.id, 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  }
  async foreground(): Promise<void> {
    await this.runCommand(this.adb, [
      '-s',
      this.phone.id,
      'shell',
      'monkey',
      '-p',
      this.phone.appId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
  }
  async restart(): Promise<void> {
    await this.runCommand(this.adb, ['-s', this.phone.id, 'shell', 'am', 'force-stop', this.phone.appId]);
    await this.foreground();
  }
  async screenshot(name: string): Promise<void> {
    await this.flow('capture', { CAPTURE_NAME: join(this.evidence.directory, name) });
  }
  async close(): Promise<void> {
    /* No persistent Android UI session. */
  }
}
export class IosDriver implements Driver {
  private session = '';
  constructor(
    readonly phone: Phone,
    private evidence: Evidence,
    private runCommand: typeof command = command,
  ) {}
  private path(suffix: string): string {
    return `/session/${encodeURIComponent(this.session)}${suffix}`;
  }
  private async request(
    path: string,
    method = 'GET',
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(new URL(path, this.phone.wdaUrl), {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = record(await response.json());
      if (
        !response.ok ||
        (payload.value &&
          typeof payload.value === 'object' &&
          !Array.isArray(payload.value) &&
          'error' in record(payload.value))
      )
        throw new Error('Rejected');
      return payload;
    } catch {
      throw new QaFailure(`Physical iPhone driver unavailable: ${method} ${path.split('?')[0]}`, 'infrastructure');
    }
  }
  async attach(): Promise<void> {
    const response = await this.request('/status');
    const status = record(response.value);
    const build = record(status.build);
    if (
      status.ready !== true ||
      build.profileRunnerBundleId !== this.phone.runnerBundleId ||
      !Number.isSafeInteger(build.profileRunnerPid) ||
      Number(build.profileRunnerPid) <= 0 ||
      'simulatorVersion' in record(status.ios)
    )
      throw new QaFailure('WDA is not the configured owned physical runner', 'blocked');
    if (response.sessionId || status.sessionId) throw new QaFailure('WDA already has an active session', 'blocked');
    // Bind the endpoint to the selected physical phone, not just an open TCP port.
    const privateDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-board-qa-processes-'));
    const processesPath = join(privateDirectory, 'processes.json');
    writeFileSync(processesPath, '', { mode: 0o600, flag: 'wx' });
    try {
      await this.runCommand('xcrun', [
        'devicectl',
        'device',
        'info',
        'processes',
        '--device',
        this.phone.id,
        '--json-output',
        processesPath,
      ]);
      assertRunnerProcess(JSON.parse(readFileSync(processesPath, 'utf8')) as unknown, Number(build.profileRunnerPid));
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true });
    }
    this.evidence.event('ios-driver', {
      runnerBundleId: build.profileRunnerBundleId,
      sourceCommit: build.profileRunnerSourceCommit,
      pid: build.profileRunnerPid,
      device: this.phone.id,
    });
    const created = await this.request('/session', 'POST', {
      capabilities: {
        alwaysMatch: {
          bundleId: this.phone.appId,
          forceAppLaunch: false,
          shouldTerminateApp: false,
          shouldWaitForQuiescence: false,
          waitForIdleTimeout: 0,
        },
      },
    });
    this.session = string(record(created.value).sessionId ?? created.sessionId);
  }
  private async elements(selector: unknown): Promise<string[]> {
    const literal = typeof selector === 'string' ? selector : record(selector);
    const response = await this.request(this.path('/elements'), 'POST', {
      using: 'predicate string',
      value: selectorPredicate(literal),
    });
    if (!Array.isArray(response.value)) throw new QaFailure('Invalid WDA selector response', 'infrastructure');
    return response.value.map((entry) => {
      const element = record(entry);
      return string(element['element-6066-11e4-a52e-4f735466cecf'] ?? element.ELEMENT);
    });
  }
  private async element(selector: unknown): Promise<string> {
    const fields = typeof selector === 'string' ? {} : record(selector);
    const index = Number(fields.index ?? 0);
    return await until(
      () => this.elements(selector),
      (matches) => Boolean(matches[index]),
      15_000,
      'iPhone control visible',
    ).then((matches) => matches[index]);
  }
  async flow(name: string, variables: Record<string, string> = {}): Promise<void> {
    const filename = flowFilename(name);
    const commands = readFlow(filename, { APP_ID: this.phone.appId, APP_SCHEME: this.phone.scheme, ...variables });
    assertIosFlow(commands);
    await this.execute(commands);
  }
  private async execute(commands: Record<string, unknown>[]): Promise<void> {
    for (const step of commands) {
      requireRunning();
      const entries = Object.entries(step);
      if (entries.length !== 1) throw new Error('One action per flow step');
      const [action, argument] = entries[0];
      this.evidence.event('ios-action', { action }); // Never record input arguments.
      if (action === 'openLink') {
        await this.request(this.path('/url'), 'POST', {
          url: typeof argument === 'string' ? argument : string(record(argument).link),
          bundleId: this.phone.appId,
        });
      } else if (action === 'assertVisible' || action === 'assertNotVisible' || action === 'extendedWaitUntil') {
        const wait = action === 'extendedWaitUntil' ? record(argument) : {};
        const selector = action === 'extendedWaitUntil' ? (wait.visible ?? wait.notVisible) : argument;
        const wanted = action === 'assertVisible' || Boolean(wait.visible);
        const index = typeof selector === 'string' ? 0 : Number(record(selector).index ?? 0);
        await until(
          () => this.elements(selector),
          (matches) => Boolean(matches[index]) === wanted,
          Number(wait.timeout ?? 15_000),
          `iPhone ${action}`,
        );
      } else if (action === 'tapOn' || action === 'longPressOn') {
        const element = await this.element(argument);
        if (action === 'tapOn')
          await this.request(this.path(`/element/${encodeURIComponent(element)}/click`), 'POST', {});
        else {
          const rectangle = record(
            (await this.request(this.path(`/element/${encodeURIComponent(element)}/rect`))).value,
          );
          const coordinates = {
            x: Number(rectangle.x) + Number(rectangle.width) / 2,
            y: Number(rectangle.y) + Number(rectangle.height) / 2,
          };
          if (
            ![coordinates.x, coordinates.y, rectangle.width, rectangle.height].every(
              (measurement) => typeof measurement === 'number' && Number.isFinite(measurement),
            ) ||
            Number(rectangle.width) <= 0 ||
            Number(rectangle.height) <= 0
          )
            throw new QaFailure('Invalid selected iPhone control bounds', 'infrastructure');
          await this.request(this.path('/actions'), 'POST', {
            actions: [
              {
                type: 'pointer',
                id: 'board-qa-hold',
                parameters: { pointerType: 'touch' },
                actions: [
                  { type: 'pointerMove', duration: 0, ...coordinates },
                  { type: 'pointerDown', button: 0 },
                  { type: 'pause', duration: 1000 },
                  { type: 'pointerUp', button: 0 },
                ],
              },
            ],
          });
        }
      } else if (action === 'inputText' || action === 'eraseText') {
        await this.request(this.path('/wda/keys'), 'POST', {
          value:
            action === 'inputText'
              ? [string(argument)]
              : ['\u0008'.repeat(typeof argument === 'number' ? argument : 100)],
        });
      } else if (action === 'swipe') {
        const gesture = record(argument);
        const screen = record(record((await this.request(this.path('/window/size'))).value));
        const rectangle = { x: 0, y: 0, width: Number(screen.width), height: Number(screen.height) };
        await this.request(
          this.path('/actions'),
          'POST',
          swipeActions(
            percentagePoint(gesture.start, rectangle),
            percentagePoint(gesture.end, rectangle),
            Number(gesture.duration ?? 400),
          ),
        );
      } else if (action === 'runFlow') {
        const include = typeof argument === 'string' ? { file: argument } : record(argument);
        if (include.when) {
          const when = record(include.when);
          if (Boolean((await this.elements(when.visible ?? when.notVisible)).length) !== Boolean(when.visible))
            continue;
        }
        if (Array.isArray(include.commands)) await this.execute(include.commands.map(record));
        else throw new Error('Empty included flow');
      } else if (action === 'takeScreenshot') {
        await this.screenshot(string(argument));
      } else if (action === 'launchApp') await this.foreground();
      else if (action === 'pressKey' && argument === 'Home') await this.background();
      else if (action === 'waitForAnimationToEnd') await new Promise((resume) => setTimeout(resume, 500));
      else throw new Error(`Unsupported physical QA action ${action}`);
    }
  }
  async hierarchy(): Promise<string> {
    // The pinned JSON tree computes customActions on every node even when the
    // attribute is excluded. XML can omit these expensive native AX queries.
    return string(
      (
        await this.request(
          this.path('/source?format=xml&excluded_attributes=visible,accessible,customActions'),
          'GET',
          undefined,
          30_000,
        )
      ).value,
    );
  }
  async background(): Promise<void> {
    await this.request('/wda/homescreen', 'POST', {});
  }
  async foreground(): Promise<void> {
    await this.request(this.path('/wda/apps/activate'), 'POST', { bundleId: this.phone.appId });
  }
  async restart(): Promise<void> {
    await this.request(this.path('/wda/apps/terminate'), 'POST', { bundleId: this.phone.appId });
    await this.foreground();
  }
  async screenshot(name: string): Promise<void> {
    const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    mkdirSync(this.evidence.directory, { recursive: true });
    writeFileSync(
      join(this.evidence.directory, `${safeName}.png`),
      Buffer.from(string((await this.request(this.path('/screenshot'))).value), 'base64'),
      { mode: 0o600 },
    );
  }
  async close(): Promise<void> {
    if (this.session) {
      await this.request(this.path(''), 'DELETE');
      this.session = '';
    }
  }
}
export async function drivers(config: QaConfig, evidence: Evidence): Promise<Record<Role, Driver>> {
  const ios = new IosDriver(config.phones.ios, evidence);
  await ios.attach();
  return { ios, android: new AndroidDriver(config.phones.android, config.adb, evidence) };
}
