/// <reference types="node" />
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { objectRecord, PROFILE_APP_ID, requiredString } from './mobile-profile-protocol';
import { validateProfileFlow } from './mobile-profile-harness';
import { IOS_UI_RUNNER_ID, IOS_UI_SOURCE_COMMIT } from '../mobile-profile-ios-driver';

type Selector = string | Record<string, unknown>;
type Request = (path: string, method?: string, body?: unknown) => Promise<unknown>;
interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function ownWdaIdentity(candidate: unknown): { pid: number; bundleId: string; sourceCommit: string } {
  const status = objectRecord(objectRecord(candidate).value),
    build = objectRecord(status.build);
  if (
    status.ready !== true ||
    build.profileRunnerBundleId !== `${IOS_UI_RUNNER_ID}.xctrunner` ||
    build.profileRunnerSourceCommit !== IOS_UI_SOURCE_COMMIT ||
    !Number.isSafeInteger(build.profileRunnerPid) ||
    Number(build.profileRunnerPid) <= 0 ||
    'simulatorVersion' in objectRecord(status.ios)
  )
    throw new Error('WDA endpoint is not the owned pinned physical profiling runner');
  return {
    pid: Number(build.profileRunnerPid),
    bundleId: String(build.profileRunnerBundleId),
    sourceCommit: String(build.profileRunnerSourceCommit),
  };
}

export function selectorPredicate(selector: Selector): string {
  const fields = typeof selector === 'string' ? { text: selector } : selector;
  if (
    (!fields.id && !fields.text) ||
    Object.keys(fields).some((key) => !['id', 'text', 'index', 'optional'].includes(key))
  )
    throw new Error('Physical driver requires supported id/text selectors');
  const quote = (text: string) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  // WDA exposes accessibilityIdentifier as wdName, represented by `name` in predicates.
  if (fields.id !== undefined && typeof fields.id !== 'string') throw new Error('Selector id must be literal text');
  if (fields.text !== undefined && typeof fields.text !== 'string')
    throw new Error('Selector text must be literal text');
  const idPredicate = typeof fields.id === 'string' ? `name MATCHES ${quote(fields.id)}` : '';
  const textPredicate =
    typeof fields.text === 'string'
      ? `(label MATCHES ${quote(fields.text)} OR name MATCHES ${quote(fields.text)} OR value MATCHES ${quote(fields.text)})`
      : '';
  if (idPredicate || textPredicate) return [idPredicate, textPredicate, 'visible == 1'].filter(Boolean).join(' AND ');
  throw new Error('Physical driver selectors require literal id or text');
}

export function percentagePoint(point: unknown, rectangle: Rectangle): { x: number; y: number } {
  if (typeof point !== 'string') throw new Error('Physical touch requires an explicit percentage point');
  const match = /^\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*$/.exec(point);
  if (!match || Number(match[1]) > 100 || Number(match[2]) > 100)
    throw new Error('Invalid percentage touch coordinate');
  return {
    x: Math.round(rectangle.x + (rectangle.width * Number(match[1])) / 100),
    y: Math.round(rectangle.y + (rectangle.height * Number(match[2])) / 100),
  };
}

export function swipeActions(start: { x: number; y: number }, end: { x: number; y: number }, durationMs: number) {
  if (!Number.isInteger(durationMs) || durationMs < 50 || durationMs > 2000)
    throw new Error('Swipe duration must be 50..2000ms');
  return {
    actions: [
      {
        type: 'pointer',
        id: 'profile-finger',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, ...start },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: durationMs, ...end },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  };
}

export function visibleRowProof(tree: unknown, id: string, index: number, text: string): Record<string, unknown> {
  if (!id || !text || !Number.isInteger(index) || index < 0) throw new Error('Invalid logical row proof');
  const rows: Record<string, unknown>[] = [];
  let visited = 0;
  const visible = (node: Record<string, unknown>) => node.isVisible === '1' || node.isVisible === true;
  const visit = (candidate: unknown, depth: number) => {
    if (++visited > 20_000 || depth > 100) throw new Error('UI hierarchy exceeds bounded inspection');
    const node = objectRecord(candidate);
    if (node.rawIdentifier === id && visible(node)) rows.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) visit(child, depth + 1);
  };
  visit(tree, 0);
  const row = rows[index];
  if (!row) throw new Error('Required visible logical row missing from hierarchy');
  const contains = (candidate: unknown): boolean => {
    const node = objectRecord(candidate);
    if (visible(node) && ['label', 'name', 'value'].some((key) => node[key] === text)) return true;
    // Accessible native rows merge title and metadata into one label.
    // Require the literal title followed by its comma separator.
    if (candidate === row && visible(node) && typeof node.label === 'string' && node.label.startsWith(`${text}, `))
      return true;
    return Array.isArray(node.children) && node.children.some(contains);
  };
  if (!contains(row)) throw new Error('Expected logical text is absent from selected row subtree');
  return { id, index, text, rect: objectRecord(row.rect) };
}

export function wdaRequest(origin: string): Request {
  return async (path, method = 'GET', body) => {
    const options: RequestInit = {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    };
    const response = await fetch(new URL(path, origin), options);
    const payload = objectRecord((await response.json()) as unknown);
    const errorObject =
      payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value)
        ? objectRecord(payload.value)
        : {};
    if (!response.ok || 'error' in errorObject) {
      const details = errorObject;
      const error = typeof details.error === 'string' ? details.error.slice(0, 200) : 'HTTP error';
      const message = typeof details.message === 'string' ? details.message.slice(0, 4000) : '';
      throw new Error(`Owned WDA command failed: ${method} ${path}; status=${response.status}; ${error}: ${message}`);
    }
    return payload;
  };
}

function commandsFromFile(path: string): Record<string, unknown>[] {
  const documents = parseAllDocuments(readFileSync(path, 'utf8'));
  const commands: Record<string, unknown>[] = [];
  for (const document of documents.slice(1)) {
    const entries: unknown = document.toJSON();
    if (!Array.isArray(entries)) throw new Error('Flow commands must be a YAML array');
    for (const entry of entries) commands.push(objectRecord(entry));
  }
  return commands;
}

export class PhysicalIosFlow {
  private session = '';
  private runnerPid = 0;
  private preparedTouch:
    | {
        key: string;
        createdAt: number;
        route: string;
        body: unknown;
        evidence: Record<string, unknown>;
        settleMs: number;
      }
    | undefined;
  readonly evidence: Record<string, unknown>[] = [];
  constructor(
    private request: Request,
    private markerUrl: string,
    private markerToken: string,
    private directory: string,
  ) {}

  async attach(expectedRunnerPid?: number): Promise<void> {
    const status = objectRecord(await this.request('/status'));
    this.runnerPid = ownWdaIdentity(status).pid;
    if (expectedRunnerPid !== undefined && this.runnerPid !== expectedRunnerPid)
      throw new Error('Owned UI runner process changed before attachment');
    if (status.sessionId !== undefined && status.sessionId !== null && status.sessionId !== '')
      throw new Error('Owned WDA endpoint already has an active session; refusing to replace it');
    const response = objectRecord(
      await this.request('/session', 'POST', {
        capabilities: {
          alwaysMatch: {
            bundleId: PROFILE_APP_ID,
            forceAppLaunch: false,
            shouldTerminateApp: false,
            shouldWaitForQuiescence: false,
            waitForIdleTimeout: 0,
          },
        },
      }),
    );
    const contents = objectRecord(response.value);
    this.session = requiredString(contents.sessionId ?? response.sessionId, 'owned WDA session');
    await this.request(this.path('/appium/settings'), 'POST', {
      settings: { snapshotMaxDepth: 100, waitForIdleTimeout: 0 },
    });
  }

  private path(route: string) {
    return `/session/${encodeURIComponent(this.session)}${route}`;
  }
  private async elements(selector: Selector): Promise<string[]> {
    const response = objectRecord(
      await this.request(this.path('/elements'), 'POST', {
        using: 'predicate string',
        value: selectorPredicate(selector),
      }),
    );
    if (!Array.isArray(response.value)) throw new Error('Malformed WDA elements response');
    return response.value.map((candidate) => {
      const element = objectRecord(candidate);
      return requiredString(element['element-6066-11e4-a52e-4f735466cecf'] ?? element.ELEMENT, 'element');
    });
  }
  private async visible(selector: Selector, wanted: boolean, timeoutMs: number): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
      throw new Error('Visibility deadline out of bounds');
    const deadline = Date.now() + timeoutMs;
    do {
      const index = typeof selector === 'string' ? 0 : Number(selector.index ?? 0);
      if (!Number.isInteger(index) || index < 0) throw new Error('Invalid assertion element index');
      if (Boolean((await this.elements(selector))[index]) === wanted) return;
      await new Promise((resume) => setTimeout(resume, 200));
    } while (Date.now() < deadline);
    throw new Error(`Required physical UI ${wanted ? 'visible' : 'absent'} assertion failed`);
  }
  private async screen(): Promise<Rectangle> {
    const size = objectRecord(objectRecord(await this.request(this.path('/window/size'))).value);
    if (typeof size.width !== 'number' || typeof size.height !== 'number' || size.width <= 0 || size.height <= 0)
      throw new Error('Invalid physical screen size');
    return { x: 0, y: 0, width: size.width, height: size.height };
  }
  private async rect(selector: Selector): Promise<Rectangle> {
    const fields = typeof selector === 'string' ? {} : selector;
    const matches = await this.elements(selector),
      index = Number(fields.index ?? 0);
    if (!Number.isInteger(index) || index < 0 || !matches[index])
      throw new Error('Required selected physical element missing');
    const rectangle = objectRecord(
      objectRecord(await this.request(this.path(`/element/${encodeURIComponent(matches[index])}/rect`))).value,
    );
    for (const field of ['x', 'y', 'width', 'height'])
      if (typeof rectangle[field] !== 'number' || !Number.isFinite(rectangle[field]))
        throw new Error('Invalid physical element rectangle');
    if (Number(rectangle.width) <= 0 || Number(rectangle.height) <= 0)
      throw new Error('Physical element has no touchable rectangle');
    return rectangle as unknown as Rectangle;
  }
  private async resolveTouch(
    name: 'tapOn' | 'swipe',
    argument: unknown,
  ): Promise<{ route: string; body: unknown; evidence: Record<string, unknown> }> {
    if (name === 'tapOn') {
      const selector = typeof argument === 'string' ? { text: argument } : objectRecord(argument);
      if (selector.point) {
        const point = percentagePoint(selector.point, await this.screen());
        return { route: '/wda/tap', body: point, evidence: { action: 'native-tap', point } };
      } else {
        const rectangle = await this.rect(selector);
        const point = {
          x: Math.round(rectangle.x + rectangle.width / 2),
          y: Math.round(rectangle.y + rectangle.height / 2),
        };
        return { route: '/wda/tap', body: point, evidence: { action: 'native-tap', point } };
      }
    }
    const gesture = objectRecord(argument),
      screen = await this.screen();
    if (
      Object.keys(gesture).some(
        (key) => !['start', 'end', 'from', 'endRelativeTo', 'duration', 'maxDistance'].includes(key),
      )
    )
      throw new Error('Physical swipe requires explicit supported endpoints');
    if (gesture.endRelativeTo !== undefined && gesture.endRelativeTo !== 'screen' && gesture.endRelativeTo !== 'from')
      throw new Error('Swipe endRelativeTo must be screen or from');
    if (gesture.endRelativeTo === 'from' && !gesture.from) throw new Error('Row-relative end requires from selector');
    const source = gesture.from ? await this.rect(gesture.from as Selector) : screen;
    const start = percentagePoint(gesture.start ?? '50%,50%', source),
      end = percentagePoint(gesture.end, gesture.endRelativeTo === 'from' ? source : screen);
    if ([start, end].some((point) => point.x < 0 || point.y < 0 || point.x > screen.width || point.y > screen.height))
      throw new Error('Physical swipe leaves the selected screen');
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    if (
      gesture.maxDistance !== undefined &&
      (!Number.isFinite(gesture.maxDistance) ||
        Number(gesture.maxDistance) < 1 ||
        Number(gesture.maxDistance) >= 192 ||
        distance > Number(gesture.maxDistance))
    )
      throw new Error('Partial reveal exceeds explicit distance guard');
    const actions = swipeActions(start, end, Number(gesture.duration ?? 400));
    return {
      route: '/actions',
      body: actions,
      evidence: {
        action: 'native-touch',
        start,
        end,
        distance,
        endRelativeTo: gesture.endRelativeTo ?? 'screen',
        requestedMoveMs: gesture.duration ?? 400,
      },
    };
  }
  async run(filename: string): Promise<void> {
    validateProfileFlow(filename);
    await this.commands(commandsFromFile(filename), dirname(filename));
    if (this.preparedTouch) throw new Error('Prepared touch was never executed');
  }
  private async commands(commands: Record<string, unknown>[], directory: string): Promise<void> {
    for (const command of commands) {
      const entries = Object.entries(command);
      if (entries.length !== 1) throw new Error('Physical driver commands require one action each');
      const [name, argument] = entries[0];
      switch (name) {
        case 'extendedWaitUntil': {
          const wait = objectRecord(argument);
          await this.visible(
            (wait.visible ?? wait.notVisible) as Selector,
            Boolean(wait.visible),
            Number(wait.timeout ?? 10_000),
          );
          break;
        }
        case 'assertVisible':
        case 'assertNotVisible':
          await this.visible(argument as Selector, name === 'assertVisible', 1000);
          break;
        case 'tapOn':
        case 'swipe': {
          const touch = await this.resolveTouch(name, argument);
          await this.request(this.path(touch.route), 'POST', touch.body);
          this.evidence.push(touch.evidence);
          break;
        }
        case 'prepareTouch': {
          const specification = objectRecord(argument),
            key = requiredString(specification.key, 'prepared touch key');
          if (
            !/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) ||
            this.preparedTouch ||
            Boolean(specification.tapOn) === Boolean(specification.swipe) ||
            Object.keys(specification).some((key) => !['key', 'tapOn', 'swipe', 'settleMs'].includes(key))
          )
            throw new Error('Require one bounded unused prepared touch');
          const settleMs = Number(specification.settleMs ?? 0);
          if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 3000)
            throw new Error('Prepared touch settle must be bounded0..3000ms');
          const touch = await this.resolveTouch(
            specification.tapOn ? 'tapOn' : 'swipe',
            specification.tapOn ?? specification.swipe,
          );
          this.preparedTouch = { ...touch, key, settleMs, createdAt: Date.now() };
          this.evidence.push({
            ...touch.evidence,
            action: 'prepared-touch-geometry',
            key,
            preparedAt: new Date().toISOString(),
          });
          break;
        }
        case 'executePreparedTouch': {
          const key = requiredString(argument, 'prepared touch key'),
            touch = this.preparedTouch;
          this.preparedTouch = undefined;
          if (!touch || touch.key !== key || Date.now() - touch.createdAt > 10000 || Date.now() < touch.createdAt)
            throw new Error('Prepared touch missing, reused or older than ten seconds');
          // Geometry/AX queries ran before the explicit native sample boundary.
          await this.request(this.path(touch.route), 'POST', touch.body);
          if (touch.settleMs) await new Promise((settled) => setTimeout(settled, touch.settleMs));
          this.evidence.push({
            ...touch.evidence,
            action: 'executed-prepared-touch',
            key,
            executedAt: new Date().toISOString(),
            requestedSettleMs: touch.settleMs,
            settleScope: 'Fixed host timer includes native background work; no animation completion assertion.',
          });
          break;
        }
        case 'saveUIHierarchy':
        case 'assertVisibleRow': {
          const specification = name === 'assertVisibleRow' ? objectRecord(argument) : {};
          const filename =
            name === 'assertVisibleRow'
              ? requiredString(specification.evidence, 'row evidence name')
              : requiredString(argument, 'hierarchy name');
          if (!/^[a-zA-Z0-9_-]+$/.test(filename)) throw new Error('Hierarchy name must be bounded and local');
          const tree = objectRecord(await this.request(this.path('/source?format=json'))).value;
          writeFileSync(join(this.directory, `${filename}.json`), JSON.stringify(tree, null, 2) + '\n');
          if (name === 'assertVisibleRow') {
            const id = requiredString(specification.id, 'row id'),
              index = Number(specification.index ?? 0);
            const proof = visibleRowProof(tree, id, index, requiredString(specification.text, 'logical row text'));
            const selectedRectangle = await this.rect({ id, index });
            const proofRectangle = objectRecord(proof.rect);
            if (
              ['x', 'y', 'width', 'height'].some(
                (key) => proofRectangle[key] !== selectedRectangle[key as keyof Rectangle],
              )
            )
              throw new Error('Hierarchy row order/rectangle differs from selected touch row');
            this.evidence.push({ action: 'visible-logical-row-proof', ...proof });
          }
          break;
        }
        case 'waitForAnimationToEnd': {
          const maximum = argument ? Number(objectRecord(argument).timeout ?? 1000) : 1000;
          if (!Number.isFinite(maximum) || maximum < 0 || maximum > 10_000)
            throw new Error('Animation pause out of bounds');
          const pauseMs = Math.min(1000, maximum);
          await new Promise((resume) => setTimeout(resume, pauseMs));
          this.evidence.push({ action: 'bounded-settle-pause', pauseMs, animationDetection: false });
          break;
        }
        case 'takeScreenshot': {
          const filename = requiredString(argument, 'screenshot name');
          if (!/^[a-zA-Z0-9_-]+$/.test(filename)) throw new Error('Screenshot name must be bounded and local');
          const image = objectRecord(await this.request('/screenshot')).value;
          if (typeof image !== 'string') throw new Error('Screenshot missing');
          writeFileSync(join(this.directory, `${filename}.png`), Buffer.from(image, 'base64'));
          break;
        }
        case 'runScript': {
          const mark = objectRecord(objectRecord(argument).env);
          const response = await fetch(this.markerUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: this.markerToken, segment: mark.SEGMENT, boundary: mark.BOUNDARY }),
            signal: AbortSignal.timeout(7000),
          });
          if (!response.ok || objectRecord((await response.json()) as unknown).acknowledged !== true)
            throw new Error('Native segment boundary was not acknowledged');
          break;
        }
        case 'runFlow': {
          const include = typeof argument === 'string' ? { file: argument } : objectRecord(argument);
          if (include.when) {
            const condition = objectRecord(include.when);
            const selector = (condition.visible ?? condition.notVisible) as Selector;
            if (Boolean((await this.elements(selector)).length) !== Boolean(condition.visible)) break;
          }
          if (include.file) {
            const path = resolve(directory, requiredString(include.file, 'included flow'));
            await this.commands(commandsFromFile(path), dirname(path));
          } else if (Array.isArray(include.commands))
            await this.commands(include.commands.map(objectRecord), directory);
          else throw new Error('Empty physical flow include');
          break;
        }
        case 'repeat': {
          const repeated = objectRecord(argument),
            times = Number(repeated.times);
          if (!Number.isInteger(times) || times < 1 || times > 20 || !Array.isArray(repeated.commands))
            throw new Error('Physical repeat must have bounded literal times');
          for (let index = 0; index < times; index++)
            await this.commands(repeated.commands.map(objectRecord), directory);
          break;
        }
        case 'openLink': {
          const link =
            typeof argument === 'string' ? argument : requiredString(objectRecord(argument).link, 'deep link');
          await this.request(this.path('/wda/deeplink'), 'POST', { url: link, bundleId: PROFILE_APP_ID });
          break;
        }
        default:
          throw new Error(`Unsupported physical profiling command: ${name}`);
      }
      this.evidence.push({ command: name, argument, completed: true });
      writeFileSync(join(this.directory, 'ui-commands.json'), JSON.stringify(this.evidence, null, 2) + '\n');
    }
  }
  async detach(): Promise<void> {
    if (this.session) {
      const status = objectRecord(await this.request('/status'));
      if (ownWdaIdentity(status).pid !== this.runnerPid || status.sessionId !== this.session)
        throw new Error('UI session ownership changed; refusing to detach a different session');
      await this.request(this.path(''), 'DELETE');
    }
  }
}
