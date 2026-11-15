/** Translate historical capture recipe setup into dev integration commands. */
export function integrationVideoLink(link: string, command: string): string {
  const route = new URL(link, 'https://capture.invalid/');
  const commandKeys = [...route.searchParams.keys()].filter((key) => key.startsWith('screenshot'));
  if (commandKeys.length === 0) return link;
  const supported = new Set([
    'screenshotBoardIndex',
    'screenshotOpenFirst',
    'screenshotOpenFilters',
    'screenshotCppScene',
  ]);
  if (route.pathname !== '/climbs' || commandKeys.some((key) => !supported.has(key))) {
    throw new Error(`Unsupported legacy recording setup: ${link}`);
  }
  const params = new URLSearchParams({ command });
  const slot = route.searchParams.get('screenshotBoardIndex');
  if (slot !== null) {
    if (!/^\d+$/.test(slot)) throw new Error('Recording board index must be nonnegative');
    params.set('boardIndex', slot);
  }
  if (route.searchParams.get('screenshotOpenFirst') === '1') params.set('openFirst', '1');
  return `dev/integration/video?${params}`;
}

/** Wait for the dev controller's real board/list action before the next recipe link. */
export function integrationVideoWaitSteps(command: string): string[] {
  if (!/^[a-z0-9-]{1,40}$/.test(command)) throw new Error('Invalid recording command');
  return [
    "- evalScript: ${output.integrationReady = 'wait'}",
    '- repeat:',
    '    times: 60',
    '    while:',
    "      true: ${output.integrationReady != 'go'}",
    '    commands:',
    `      - evalScript: \${output.integrationReady = http.get(SHOWCASE_SIGNAL_URL + '/signal/integration-ready-${command}').body.trim()}`,
    '      - extendedWaitUntil:',
    "          visible: 'zzz-showcase-pause'",
    '          timeout: 1000',
    '          optional: true',
    "- assertTrue: ${output.integrationReady == 'go'}",
  ];
}
