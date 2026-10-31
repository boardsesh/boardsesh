import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

type Selector = { id: string };
type Command = {
  extendedWaitUntil?: { visible?: Selector; notVisible?: Selector; timeout: number };
  tapOn?: string;
  runFlow?: { when: { true: string }; commands: Command[] };
  takeScreenshot?: string;
};
const currentId = '${SCREENSHOT_PRIMARY_CURRENT_DRIVING_ID}';
const driveId = '${SCREENSHOT_PRIMARY_DRIVING_ID}';
function commands(): Command[] {
  const documents = parseAllDocuments(readFileSync('packages/mobile/.maestro/app-store-ipad.yaml', 'utf8'));
  for (const document of documents) expect(document.errors).toEqual([]);
  return documents[1].toJS() as Command[];
}

describe('real iPad driving capture', () => {
  it('waits for the real exact drive, closes normally, then observes current state before browsing', () => {
    const program = commands();
    const preparation = program.find((command) =>
      command.runFlow?.commands.some((nested) => nested.tapOn === '${SCREENSHOT_CLOSE_LABEL}'),
    )?.runFlow;
    expect(preparation?.when.true).toBe("${SCREENSHOT_PRIMARY_DRIVING == '1'}");
    expect(preparation?.commands).toEqual([
      { extendedWaitUntil: { visible: { id: '^play-drawer-board-overlay$' }, timeout: 60000 } },
      { extendedWaitUntil: { visible: { id: '^cpp-climb-painted-.+$' }, timeout: 90000 } },
      { extendedWaitUntil: { visible: { id: driveId }, timeout: 90000 } },
      { tapOn: '${SCREENSHOT_CLOSE_LABEL}' },
      { extendedWaitUntil: { notVisible: { id: '^play-drawer-board-overlay$' }, timeout: 60000 } },
      { extendedWaitUntil: { visible: { id: currentId }, timeout: 90000 } },
    ]);
    expect(program.indexOf(program.find((command) => command.runFlow === preparation)!)).toBeLessThan(
      program.findIndex((command) => command.takeScreenshot === '02-climbs'),
    );
  });

  it.each(['02-climbs', '01-home', '00-wall'])(
    'blocks %s after a drive is lost, and keeps no-lights captures possible',
    (shot) => {
      const program = commands();
      const index = program.findIndex((command) => command.takeScreenshot === shot);
      expect(index).toBeGreaterThan(0);
      const gate = program[index - 1].runFlow;
      expect(gate?.when.true).toBe("${SCREENSHOT_PRIMARY_DRIVING == '1'}");
      expect(gate?.commands).toEqual([{ extendedWaitUntil: { visible: { id: currentId }, timeout: 90000 } }]);
      const capture = (requiresDrive: boolean, live: boolean) => {
        if (
          requiresDrive &&
          gate?.commands.some((command) => command.extendedWaitUntil?.visible?.id === currentId) &&
          !live
        )
          throw new Error('No current real drive');
        return shot;
      };
      expect(() => capture(true, false)).toThrow('No current real drive');
      expect(capture(true, true)).toBe(shot);
      expect(capture(false, false)).toBe(shot);
    },
  );

  it('keeps native content, kiosk paint/title/fade and real Exit gates', () => {
    const source = readFileSync('packages/mobile/.maestro/app-store-ipad.yaml', 'utf8');
    for (const gate of [
      "id: '^climb-row$'",
      "id: 'session-feed-card'",
      'id: ${SCREENSHOT_PRIMARY_WALL_PAINTED_ID}',
      "visible: '.*${SCREENSHOT_PRIMARY_CLIMB_TITLE}.*'",
      "id: '^wall-display-controls-faded$'",
      'tapOn: ${SCREENSHOT_WALL_DISPLAY_EXIT_LABEL}',
    ])
      expect(source).toContain(gate);
    expect(source).not.toMatch(/^\s*- openLink:/m);
  });
});
