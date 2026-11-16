import { describe, expect, it } from 'vitest';
import {
  isWithinPickerScanCooldown,
  PICKER_SCAN_COOLDOWN_MS,
  pickerScanPermissionFromAuthorization,
  resolvePickerScan,
  type PickerScanInputs,
  type PickerScanPhase,
} from '../picker-scan-phase';

// The board picker's in-range slot: what it shows, and when it scans by itself.

/** A picker just opened on a phone that allowed Bluetooth long ago: it scans by itself. */
const READY: PickerScanInputs = {
  canScan: true,
  connectedToBoard: false,
  focused: true,
  appActive: true,
  autoStart: true,
  permission: 'granted',
  scannedRecently: false,
  autoStartUsed: false,
  starting: false,
  scanStatus: 'idle',
  unavailableReason: null,
  lookup: 'none',
};

type PhaseCase = { name: string; inputs: Partial<PickerScanInputs>; phase: PickerScanPhase; autoStart: boolean };

describe('resolvePickerScan', () => {
  const cases: PhaseCase[] = [
    // Scans by itself.
    { name: 'scans by itself when opened with Bluetooth allowed', inputs: {}, phase: 'scanning', autoStart: true },

    // Each rule that keeps it from scanning by itself.
    {
      name: 'never in a browser (the web scan ends falsely empty)',
      inputs: { canScan: false },
      phase: 'hidden',
      autoStart: false,
    },
    {
      name: 'never while this phone is connected to a board (a connected box may stop advertising)',
      inputs: { connectedToBoard: true },
      phase: 'hidden',
      autoStart: false,
    },
    {
      name: 'not while the picker is under another screen',
      inputs: { focused: false },
      phase: 'tap_to_scan',
      autoStart: false,
    },
    { name: 'not in the background', inputs: { appActive: false }, phase: 'tap_to_scan', autoStart: false },
    {
      name: 'not with the remote switch off: it waits for a tap',
      inputs: { autoStart: false },
      phase: 'tap_to_scan',
      autoStart: false,
    },
    {
      name: 'not within 30 s of the last picker scan (also Android’s 5 starts per 30 s)',
      inputs: { scannedRecently: true },
      phase: 'tap_to_scan',
      autoStart: false,
    },
    {
      name: 'not twice in one visit, nor after a pick',
      inputs: { autoStartUsed: true },
      phase: 'tap_to_scan',
      autoStart: false,
    },
    {
      name: 'not while a start is already on its way',
      inputs: { starting: true },
      phase: 'scanning',
      autoStart: false,
    },
    {
      name: 'never before Bluetooth is allowed: iOS undetermined, Android not granted (the prompt only comes from the button)',
      inputs: { permission: 'not_asked' },
      phase: 'needs_permission',
      autoStart: false,
    },
    {
      name: 'never once iOS said no',
      inputs: { permission: 'blocked' },
      phase: 'blocked_denied',
      autoStart: false,
    },
    {
      name: 'not before Android’s permission read is back, though it shows the scan it expects',
      inputs: { permission: 'checking' },
      phase: 'scanning',
      autoStart: false,
    },
    {
      name: 'shows the button while Android’s read is out and the switch is off',
      inputs: { permission: 'checking', autoStart: false },
      phase: 'tap_to_scan',
      autoStart: false,
    },
    {
      name: 'not once a scan has run',
      inputs: { scanStatus: 'done' },
      phase: 'done',
      autoStart: false,
    },

    // A permission question still open, and the button's own start.
    {
      name: 'asks with the switch off too: the button still asks first',
      inputs: { permission: 'not_asked', autoStart: false },
      phase: 'needs_permission',
      autoStart: false,
    },
    {
      name: 'reads as scanning while the button’s start waits on the prompt',
      inputs: { permission: 'not_asked', starting: true },
      phase: 'scanning',
      autoStart: false,
    },

    // The scan's own state.
    {
      name: 'scans, rows growing as boards are heard',
      inputs: { scanStatus: 'scanning', autoStartUsed: true },
      phase: 'scanning',
      autoStart: false,
    },
    {
      name: 'keeps scanning while the serial lookup names what the radio heard',
      inputs: { scanStatus: 'done', lookup: 'pending' },
      phase: 'scanning',
      autoStart: false,
    },
    {
      name: 'ends with final rows once the lookup answered',
      inputs: { scanStatus: 'done', lookup: 'resolved' },
      phase: 'done',
      autoStart: false,
    },
    {
      name: 'ends even when the lookup failed (its row says so)',
      inputs: { scanStatus: 'done', lookup: 'failed' },
      phase: 'done',
      autoStart: false,
    },
    {
      name: 'hides when the rest timer or a connect holds the scan, rather than claim "no boards"',
      inputs: { scanStatus: 'busy' },
      phase: 'hidden',
      autoStart: false,
    },
    {
      name: 'hides a finished scan once the phone connects to a board',
      inputs: { scanStatus: 'done', lookup: 'resolved', connectedToBoard: true },
      phase: 'hidden',
      autoStart: false,
    },

    // Why a scan could not run.
    {
      name: 'hides without Bluetooth LE (a simulator, after trying)',
      inputs: { scanStatus: 'unavailable', unavailableReason: 'unsupported' },
      phase: 'hidden',
      autoStart: false,
    },
    {
      name: 'sends a refusal for good to Settings (iOS denied, Android never-ask-again)',
      inputs: { scanStatus: 'unavailable', unavailableReason: 'unauthorized' },
      phase: 'blocked_denied',
      autoStart: false,
    },
    {
      name: 'asks again after an Android "Don’t allow" in the dialog',
      inputs: { scanStatus: 'unavailable', unavailableReason: 'permission_denied' },
      phase: 'needs_permission',
      autoStart: false,
    },
    {
      name: 'asks again after an iOS alert left unanswered',
      inputs: { scanStatus: 'unavailable', unavailableReason: 'not_asked' },
      phase: 'needs_permission',
      autoStart: false,
    },
    {
      name: 'says Bluetooth is off',
      inputs: { scanStatus: 'unavailable', unavailableReason: 'powered_off' },
      phase: 'blocked_off',
      autoStart: false,
    },
    {
      name: 'treats a radio it could not read as off, whose Scan again can help',
      inputs: { scanStatus: 'unavailable', unavailableReason: 'unknown' },
      phase: 'blocked_off',
      autoStart: false,
    },
    {
      name: 'still hides in a browser whatever the scan said',
      inputs: { canScan: false, scanStatus: 'unavailable', unavailableReason: 'powered_off' },
      phase: 'hidden',
      autoStart: false,
    },
  ];

  it.each(cases)('$name', ({ inputs, phase, autoStart }) => {
    expect(resolvePickerScan({ ...READY, ...inputs })).toEqual({ phase, autoStart });
  });

  it('reaches every phase', () => {
    const phases = new Set(cases.map((testCase) => testCase.phase));
    expect([...phases].sort()).toEqual(
      ['blocked_denied', 'blocked_off', 'done', 'hidden', 'needs_permission', 'scanning', 'tap_to_scan'].sort(),
    );
  });
});

describe('pickerScanPermissionFromAuthorization', () => {
  it.each([
    { authorization: 'notDetermined', permission: 'not_asked' },
    { authorization: 'allowedAlways', permission: 'granted' },
    { authorization: 'denied', permission: 'blocked' },
    { authorization: 'restricted', permission: 'blocked' },
    // A binary without the native read asked at launch: a scan never prompts there.
    { authorization: null, permission: 'granted' },
  ] as const)('reads iOS $authorization as $permission', ({ authorization, permission }) => {
    expect(pickerScanPermissionFromAuthorization(authorization)).toBe(permission);
  });
});

describe('isWithinPickerScanCooldown', () => {
  const now = 1_000_000;
  it.each([
    { name: 'no picker scan yet', lastEndedAt: null, within: false },
    { name: 'one that just ended', lastEndedAt: now, within: true },
    { name: 'one that ended 29.9 s ago', lastEndedAt: now - (PICKER_SCAN_COOLDOWN_MS - 100), within: true },
    { name: 'one that ended exactly 30 s ago', lastEndedAt: now - PICKER_SCAN_COOLDOWN_MS, within: false },
    { name: 'one that ended a minute ago', lastEndedAt: now - 60_000, within: false },
  ])('$name: $within', ({ lastEndedAt, within }) => {
    expect(isWithinPickerScanCooldown(lastEndedAt, now)).toBe(within);
  });
});
