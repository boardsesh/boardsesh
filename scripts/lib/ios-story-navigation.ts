const OPEN_PROMPT = '.*Open in.*Boardsesh.*';

/** iPad landscape accessibility bounds can remain rotated for system alerts. */
export function iosStoryNavigationFlow(
  appId: string,
  url: string,
  orientation: 'PORTRAIT' | 'LANDSCAPE_LEFT' | 'LANDSCAPE_RIGHT',
): string {
  return [
    `appId: ${appId}`,
    '---',
    '- setOrientation: PORTRAIT',
    `- openLink: ${url}&captureOrientation=${orientation === 'PORTRAIT' ? 'portrait' : 'landscape'}`,
    '- tapOn:',
    '    text: "^Open$"',
    '    optional: true',
    '- repeat:',
    '    times: 3',
    '    while:',
    `      visible: ${JSON.stringify(OPEN_PROMPT)}`,
    '    commands:',
    '      - tapOn: "^Open$"',
    '- assertNotVisible:',
    `    text: ${JSON.stringify(OPEN_PROMPT)}`,
    `- setOrientation: ${orientation}`,
    '- waitForAnimationToEnd:',
    '    timeout: 10000',
    '',
  ].join('\n');
}
