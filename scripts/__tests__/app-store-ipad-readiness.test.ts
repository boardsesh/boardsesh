/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

type NativeSelector = { id?: string; text?: string; childOf?: NativeSelector };
type NativeCommand = {
  evalScript?: string;
  assertTrue?: string;
  retry?: { maxRetries: number; commands: NativeCommand[] };
  takeScreenshot?: string;
  extendedWaitUntil?: { visible?: string | NativeSelector; timeout: number; optional?: boolean };
};

const flowSource = readFileSync('packages/mobile/.maestro/app-store-ipad.yaml', 'utf8');
const documents = parseAllDocuments(flowSource);
const commands = documents[1].toJS() as NativeCommand[];

function captureGates(screenshot: string): NativeSelector[] {
  const captureIndex = commands.findIndex((command) => command.takeScreenshot === screenshot);
  expect(captureIndex).toBeGreaterThanOrEqual(0);
  const precedingCapture = commands
    .slice(0, captureIndex)
    .reduce((lastIndex, command, index) => (command.takeScreenshot ? index : lastIndex), -1);
  return commands.slice(precedingCapture + 1, captureIndex).flatMap((command) => {
    const wait = command.extendedWaitUntil;
    if (!wait || wait.optional || !wait.visible) return [];
    return typeof wait.visible === 'string' ? [{ text: wait.visible }] : [wait.visible];
  });
}

const primarySelectors = {
  SCREENSHOT_PRIMARY_CLIMB_ROW: '^Lightest Pair of Shorts, .+$',
  SCREENSHOT_PRIMARY_CLIMB_TITLE: 'Lightest Pair of Shorts',
  SCREENSHOT_PRIMARY_WALL_PAINTED_ID: '^screenshot-primary-wall-painted-primary-board-primary-climb$',
};

function matchesGate(selector: NativeSelector, visibleNodes: NativeSelector[]): boolean {
  function resolvePattern(pattern: string): string {
    return pattern.replace(
      /\$\{([^}]+)\}/g,
      (_placeholder, name: string) => primarySelectors[name as keyof typeof primarySelectors],
    );
  }
  return visibleNodes.some((node) => {
    const contentMatches = (['id', 'text'] as const).every((field) => {
      const pattern = selector[field];
      const content = node[field];
      return (
        pattern === undefined || (content !== undefined && new RegExp(`^(?:${resolvePattern(pattern)})$`).test(content))
      );
    });
    return (
      contentMatches &&
      (!selector.childOf || (node.childOf !== undefined && matchesGate(selector.childOf, [node.childOf])))
    );
  });
}

describe('regular iPad primary board readiness', () => {
  it('keeps valid Maestro documents and all six mandatory captures', () => {
    expect(documents).toHaveLength(2);
    for (const document of documents) expect(document.errors).toEqual([]);
    expect(commands.flatMap((command) => (command.takeScreenshot ? [command.takeScreenshot] : []))).toEqual([
      '02-climbs',
      '01-home',
      '00-wall',
      '03-workout-generator',
      '04-discover',
      '05-profile',
    ]);
  });

  it('requests the verified primary scene once and requires its exact ACK before sidebar navigation', () => {
    const requestIndex = commands.findIndex((command) => command.evalScript?.includes('/set?scene=hero-1'));
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(commands[requestIndex].evalScript).toBe(
      "${output.primaryBoardSequence = JSON.parse(http.get(SCREENSHOT_PRIMARY_BOARD_URL + '/set?scene=hero-1').body).sequence}",
    );
    expect(commands[requestIndex + 1].retry).toEqual({
      maxRetries: 3,
      commands: [
        {
          evalScript:
            "${output.primaryBoardAcknowledged = JSON.parse(http.get(SCREENSHOT_PRIMARY_BOARD_URL + '/status?waitFor=' + output.primaryBoardSequence).body).acknowledged}",
        },
        { assertTrue: '${output.primaryBoardAcknowledged == output.primaryBoardSequence}' },
      ],
    });
    expect(commands.filter((command) => command.evalScript?.includes('/set?scene='))).toHaveLength(1);
    const firstSidebarRetry = commands.findIndex((command) =>
      command.retry?.commands.some((nested) => 'tapOn' in nested),
    );
    expect(firstSidebarRetry).toBeGreaterThan(requestIndex + 1);
    expect(flowSource).not.toContain('SCREENSHOT_CPP_URL');
    expect(flowSource).not.toContain('openLink:');
  });

  it.each([null, 16, 18])('rejects absent or foreign acknowledgement %s', (acknowledged) => {
    const ackRetry = commands.find((command) => command.retry?.commands.some((nested) => nested.assertTrue))?.retry;
    expect(ackRetry).toBeDefined();
    const output = { primaryBoardSequence: 17, primaryBoardAcknowledged: undefined as number | null | undefined };
    const context = {
      output,
      SCREENSHOT_PRIMARY_BOARD_URL: 'http://localhost:19870/cpp',
      http: { get: () => ({ body: JSON.stringify({ acknowledged }) }) },
    };
    runInNewContext(ackRetry!.commands[0].evalScript!.slice(2, -1), context, { timeout: 1000 });
    expect(runInNewContext(ackRetry!.commands[1].assertTrue!.slice(2, -1), context, { timeout: 1000 })).toBe(false);
  });

  it('accepts only the acknowledgement for the requested sequence', () => {
    const ackRetry = commands.find((command) => command.retry?.commands.some((nested) => nested.assertTrue))?.retry;
    expect(ackRetry).toBeDefined();
    const output = { primaryBoardSequence: 17, primaryBoardAcknowledged: undefined as number | undefined };
    const requestedUrls: string[] = [];
    const context = {
      output,
      SCREENSHOT_PRIMARY_BOARD_URL: 'http://localhost:19870/cpp',
      http: {
        get: (url: string) => {
          requestedUrls.push(url);
          return { body: JSON.stringify({ acknowledged: 17 }) };
        },
      },
    };
    runInNewContext(ackRetry!.commands[0].evalScript!.slice(2, -1), context, { timeout: 1000 });
    expect(runInNewContext(ackRetry!.commands[1].assertTrue!.slice(2, -1), context, { timeout: 1000 })).toBe(true);
    expect(requestedUrls).toEqual(['http://localhost:19870/cpp/status?waitFor=17']);
  });

  it('requires the real Climbs surface and exact genuine native row before the browse capture', () => {
    const gates = captureGates('02-climbs');
    expect(gates).toContainEqual({ id: '^climbs-screen$' });
    const rowGate = {
      id: '^climb-row$',
      text: '${SCREENSHOT_PRIMARY_CLIMB_ROW}',
      childOf: { id: '^climb-list$' },
    };
    expect(gates).toContainEqual(rowGate);
    expect(matchesGate(rowGate, [{ text: 'Lightest Pair of Shorts' }])).toBe(false);
    expect(matchesGate(rowGate, [{ id: 'climb-row', text: 'Another climb, V4, 35°' }])).toBe(false);
    expect(matchesGate(rowGate, [{ id: 'climb-row', text: 'Lightest Pair of Shorts, V4, 35°' }])).toBe(false);
    expect(
      matchesGate(rowGate, [
        { id: 'climb-row', text: 'Lightest Pair of Shorts, V4, 35°', childOf: { id: 'history-list' } },
      ]),
    ).toBe(false);
    expect(
      matchesGate(rowGate, [
        { id: 'climb-row', text: 'Lightest Pair of Shorts, V4, 35°', childOf: { id: 'climb-list' } },
      ]),
    ).toBe(true);
    // German empty-state captures had successful sidebar/Home gates, but no row.
    expect(matchesGate(rowGate, [{ text: 'Wähl dein Board' }, { id: 'session-feed-card' }])).toBe(false);
  });

  it('requires the genuine title and exact physical painted identity before the wall capture', () => {
    const gates = captureGates('00-wall');
    const titleGate = { text: '.*${SCREENSHOT_PRIMARY_CLIMB_TITLE}.*' };
    const paintGate = { id: '${SCREENSHOT_PRIMARY_WALL_PAINTED_ID}' };
    expect(gates).toContainEqual(titleGate);
    expect(gates).toContainEqual(paintGate);
    expect(matchesGate(titleGate, [{ text: 'Niemand an der Wand' }])).toBe(false);
    expect(matchesGate(titleGate, [{ text: 'Another climb' }])).toBe(false);
    expect(matchesGate(titleGate, [{ text: 'Lightest Pair of Shorts' }])).toBe(true);
    expect(matchesGate(paintGate, [{ text: 'Lightest Pair of Shorts' }])).toBe(false);
    expect(matchesGate(paintGate, [{ id: 'screenshot-primary-wall-painted-other-board-primary-climb' }])).toBe(false);
    expect(matchesGate(paintGate, [{ id: 'screenshot-primary-wall-painted-primary-board-other-climb' }])).toBe(false);
    expect(matchesGate(paintGate, [{ id: 'screenshot-primary-wall-painted-primary-board-primary-climb' }])).toBe(true);
  });

  it('makes every primary content wait mandatory and bounded', () => {
    const readiness = commands.flatMap((command) => {
      const wait = command.extendedWaitUntil;
      if (!wait?.visible) return [];
      const selector = typeof wait.visible === 'string' ? { text: wait.visible } : wait.visible;
      return [selector.id, selector.text].some((pattern) => pattern?.includes('SCREENSHOT_PRIMARY_')) ? [wait] : [];
    });
    expect(readiness).toHaveLength(3);
    for (const wait of readiness) {
      expect(wait.optional).not.toBe(true);
      expect(wait.timeout).toBe(90000);
    }
  });
});
