/**
 * The Android half of the showcase recorder's pure logic: the emulator the
 * takes are filmed on, and the adb / emulator / screenrecord argument vectors.
 * Tested in `scripts/__tests__/showcase-video-android-record.test.ts`; the orchestrator
 * (`scripts/showcase-video-record.ts`) runs them.
 */

/** Package the dev-client APK installs under (scripts/lib/android-app.ts). */
export const SHOWCASE_ANDROID_PACKAGE = 'com.boardsesh.app.dev';

/**
 * A Pixel 9-class phone: 1080x2424 at 420 dpi, so 411x923 dp, the unit the
 * app's anchors are measured in. The SDK's device list stops at the Pixel 7,
 * so the AVD is created from `pixel_7` and its screen overridden.
 */
export const SHOWCASE_ANDROID_DEVICE = {
  avdName: 'Boardsesh_Showcase',
  deviceProfile: 'pixel_7',
  systemImageApi: 36,
  lcd: { width: 1080, height: 2424, density: 420 },
  /** dp: 1080 / (420 / 160) and 2424 / (420 / 160), rounded. */
  screen: { width: 411, height: 923 },
  port: 5580,
} as const;

export const androidSerial = (port: number): string => `emulator-${port}`;

/** `system-images;android-36;google_apis;arm64-v8a` on Apple silicon, x86_64 elsewhere. */
export function showcaseSystemImage(arch: string, api: number = SHOWCASE_ANDROID_DEVICE.systemImageApi): string {
  const abi = arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
  return `system-images;android-${api};google_apis;${abi}`;
}

/**
 * The AVD's config.ini with the Pixel 9-class screen, a host GPU, room for the
 * app, and no device frame. Keys the file lacks are appended; the rest keep
 * their values.
 */
export function showcaseAvdConfig(configIni: string): string {
  const overrides: Record<string, string> = {
    'hw.lcd.width': String(SHOWCASE_ANDROID_DEVICE.lcd.width),
    'hw.lcd.height': String(SHOWCASE_ANDROID_DEVICE.lcd.height),
    'hw.lcd.density': String(SHOWCASE_ANDROID_DEVICE.lcd.density),
    'hw.gpu.enabled': 'yes',
    'hw.gpu.mode': 'host',
    'hw.ramSize': '4096M',
    'disk.dataPartition.size': '6G',
    // A hardware keyboard posts a "Physical keyboard configured" notification
    // into the shade the island take films.
    'hw.keyboard': 'no',
    showDeviceFrame: 'no',
  };
  const seen = new Set<string>();
  const lines = configIni.split(/\r?\n/).map((line) => {
    const key = line.split('=')[0]?.trim();
    if (key && key in overrides) {
      seen.add(key);
      return `${key}=${overrides[key]}`;
    }
    return line;
  });
  const missing = Object.keys(overrides).filter((key) => !seen.has(key));
  const body = lines.join('\n').replace(/\n*$/, '');
  return `${body}\n${missing.map((key) => `${key}=${overrides[key]}`).join('\n')}${missing.length ? '\n' : ''}`;
}

/** Headless boot on a fixed port, in UTC (the app's local-date logic must match iOS), cold every time. */
export function buildEmulatorArgs(options: Readonly<{ avdName: string; port: number; windowed: boolean }>): string[] {
  return [
    '-avd',
    options.avdName,
    '-port',
    String(options.port),
    '-timezone',
    'UTC',
    '-no-snapshot',
    '-no-audio',
    '-no-boot-anim',
    '-gpu',
    'host',
    ...(options.windowed ? [] : ['-no-window']),
  ];
}

/**
 * The dev-client deep link that loads the JS from Metro. `adb reverse` maps the
 * emulator's localhost:<port> to the host's, so the URL names localhost.
 */
export function androidDevClientUrl(metroPort: number): string {
  return `exp+boardsesh://expo-development-client/?url=${encodeURIComponent(`http://localhost:${metroPort}`)}`;
}

/** `adb shell screenrecord`'s hard cap per file; a longer take records in parts. */
export const SCREENRECORD_MAX_SECONDS = 180;

export function buildScreenrecordArgs(
  serial: string,
  remotePath: string,
  timeLimit = SCREENRECORD_MAX_SECONDS,
): string[] {
  return [
    '-s',
    serial,
    'shell',
    'screenrecord',
    '--verbose',
    '--bit-rate',
    '12000000',
    '--time-limit',
    String(Math.min(Math.max(1, Math.round(timeLimit)), SCREENRECORD_MAX_SECONDS)),
    remotePath,
  ];
}

/** `screenrecord --verbose` prints this once the encoder is running. */
export function isScreenrecordStartedLine(line: string): boolean {
  return /Content area is|Configuring recorder|Main display is/i.test(line);
}

/** Where part `index` of a take records on the device. */
export const screenrecordRemotePath = (takeId: string, index: number): string =>
  `/sdcard/showcase-${takeId}-${String(index).padStart(2, '0')}.mp4`;

/**
 * ffmpeg's concat demuxer list for the parts of one take. Each part's
 * timestamps restart at 0, and the gaps between parts (the few ms between one
 * screenrecord ending and the next starting) are lost; for takes under the
 * 180 s cap there is one part and the list is just that file.
 */
export function buildConcatList(parts: readonly string[]): string {
  return `${parts.map((part) => `file '${part.replace(/'/g, `'\\''`)}'`).join('\n')}\n`;
}

export function buildConcatArgs(listFile: string, output: string): string[] {
  return ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output];
}

/**
 * SystemUI demo mode: a clean status bar (9:41, full battery, full bars, no
 * notification icons), the Android twin of `simctl status_bar override`.
 * Each entry is one `adb` argument vector.
 */
export function buildDemoModeCommands(serial: string): string[][] {
  const broadcast = (extras: string[]): string[] => [
    '-s',
    serial,
    'shell',
    'am',
    'broadcast',
    '-a',
    'com.android.systemui.demo',
    ...extras,
  ];
  return [
    ['-s', serial, 'shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1'],
    broadcast(['-e', 'command', 'enter']),
    broadcast(['-e', 'command', 'clock', '-e', 'hhmm', '0941']),
    broadcast(['-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false']),
    broadcast(['-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4']),
    // The emulator's fake SIM shows "3G" whatever `datatype` says; wifi alone reads cleaner.
    broadcast(['-e', 'command', 'network', '-e', 'mobile', 'hide']),
    broadcast(['-e', 'command', 'notifications', '-e', 'visible', 'false']),
  ];
}

export function buildDemoModeExitCommand(serial: string): string[] {
  return ['-s', serial, 'shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit'];
}

/**
 * Snoozes (for ten hours) every notification the system itself posted, such as
 * "Serial console enabled", so the shade the island take films holds the
 * session notification alone. Runs on the device, where the keys are.
 */
export const SNOOZE_SYSTEM_NOTIFICATIONS_SCRIPT =
  "for key in $(dumpsys notification --noredact | grep -o 'key=[-0-9]*|android|[^ :]*' | sed 's/key=//' | sort -u); " +
  'do cmd notification snooze --for 36000000 "$key"; done';

export function buildSnoozeSystemNotificationsArgs(serial: string): string[] {
  return ['-s', serial, 'shell', SNOOZE_SYSTEM_NOTIFICATIONS_SCRIPT];
}
