import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BOARD_QA_RUNNER_ID, prepareBoardQaIosLaunch, stageBoardQaIosDriver } from '../board-qa-ios-driver';
import { IOS_UI_RUNNER_ID, IOS_UI_SOURCE_COMMIT, stageIosUiDriver } from '../mobile-profile-ios-driver';

const git = vi.hoisted(() => ({ dirty: false, calls: [] as string[] }));
vi.mock('node:child_process', async () => {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...original,
    execFileSync: (...argumentsList: unknown[]) => {
      const [executable, argumentsValue] = argumentsList;
      git.calls.push(String(executable));
      if (executable === 'git') {
        const argumentsArray = argumentsValue as string[];
        if (argumentsArray[0] === 'rev-parse') return 'ee71b5903bbaba4f33c150e5e7c5b059f15f6f14\n';
        if (argumentsArray[0] === 'status') return git.dirty ? ' M drivers/ios/WebDriverAgent/source\n' : '';
        throw new Error('Unexpected git operation');
      }
      return Reflect.apply(original.execFileSync, undefined, argumentsList);
    },
  };
});

const temporaryDirectories: string[] = [];
const DEVICE = '00008110-0000000000000001';
const TEAM = 'ABCDE12345';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'boardsesh-wda-stage-test-'));
  temporaryDirectories.push(root);
  const source = join(root, 'source');
  const driver = join(source, 'drivers/ios/WebDriverAgent');
  mkdirSync(join(driver, 'WebDriverAgent.xcodeproj'), { recursive: true });
  mkdirSync(join(driver, 'WebDriverAgentLib/Commands'), { recursive: true });
  writeFileSync(
    join(driver, 'WebDriverAgent.xcodeproj/project.pbxproj'),
    'PRODUCT_BUNDLE_IDENTIFIER = com.facebook.WebDriverAgentRunner;\n',
  );
  writeFileSync(
    join(driver, 'WebDriverAgentLib/Commands/FBSessionCommands.m'),
    '@"productBundleIdentifier" : productBundleIdentifier,\n',
  );
  return { source, stage: join(root, 'stage') };
}
function writePlist(filename: string, specification: unknown): void {
  execFileSync(
    'python3',
    [
      '-c',
      'import json,plistlib,sys; plistlib.dump(json.loads(sys.argv[2]),open(sys.argv[1],"wb"))',
      filename,
      JSON.stringify(specification),
    ],
    { encoding: 'utf8' },
  );
}
function readPlist(filename: string): Record<string, unknown> {
  return JSON.parse(
    execFileSync(
      'python3',
      ['-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', filename],
      { encoding: 'utf8' },
    ),
  ) as Record<string, unknown>;
}
beforeEach(() => {
  git.dirty = false;
  git.calls.length = 0;
});
afterEach(() => {
  temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe('owned iPhone UI-driver staging', () => {
  it('preserves the profiling runner default and its existing handoff shape', () => {
    const { source, stage } = fixture();
    const handoff = stageIosUiDriver(source, stage, DEVICE, TEAM);
    expect(handoff.runnerBundleId).toBe(`${IOS_UI_RUNNER_ID}.xctrunner`);
    expect(handoff.sourceCommit).toBe(IOS_UI_SOURCE_COMMIT);
    expect(handoff.nativeBuildExecuted).toBe(false);
    expect(handoff.buildExecutable).toBe('xcodebuild');
    expect(handoff.buildArguments).toContain(`DEVELOPMENT_TEAM=${TEAM}`);
    expect(Object.keys(handoff)).toEqual([
      'schemaVersion',
      'sourceCommit',
      'source',
      'wdaVersion',
      'runnerBundleId',
      'nativeBuildExecuted',
      'buildExecutable',
      'buildArguments',
      'launchNotes',
      'sourcePatchSha256',
    ]);
    expect(readFileSync(join(stage, 'WebDriverAgent/WebDriverAgent.xcodeproj/project.pbxproj'), 'utf8')).toContain(
      IOS_UI_RUNNER_ID,
    );
    expect(git.calls).toEqual(['git', 'git']);
  });

  it('stages a separately owned board-QA identity without building or contacting a device', () => {
    const { source, stage } = fixture();
    const receipt = stageBoardQaIosDriver(source, stage, DEVICE, TEAM);
    expect(receipt.runnerBundleId).toBe(`${BOARD_QA_RUNNER_ID}.xctrunner`);
    expect(receipt.build.arguments).toContain('build-for-testing');
    expect(receipt.prepareLaunch.arguments).toEqual([
      'exec',
      'tsx',
      'scripts/board-qa-ios-driver.ts',
      'prepare-launch',
      stage,
    ]);
    expect(readFileSync(join(stage, 'WebDriverAgent/WebDriverAgent.xcodeproj/project.pbxproj'), 'utf8')).toContain(
      BOARD_QA_RUNNER_ID,
    );
    expect(
      readFileSync(join(stage, 'WebDriverAgent/WebDriverAgentLib/Commands/FBSessionCommands.m'), 'utf8'),
    ).toContain('profileRunnerPid');
    expect(git.calls).toEqual(['git', 'git']);
  });

  it('refuses dirty source, simulator-style IDs, missing teams, and an existing stage', () => {
    const { source, stage } = fixture();
    expect(() => stageBoardQaIosDriver(source, stage, '11111111-2222-3333-4444-555555555555', TEAM)).toThrow(
      'physical iPhone',
    );
    expect(() => stageBoardQaIosDriver(source, stage, DEVICE, '')).toThrow('team ID');
    git.dirty = true;
    expect(() => stageBoardQaIosDriver(source, stage, DEVICE, TEAM)).toThrow('dirty');
    expect(existsSync(stage)).toBe(false);
    git.dirty = false;
    stageBoardQaIosDriver(source, stage, DEVICE, TEAM);
    expect(() => stageBoardQaIosDriver(source, stage, DEVICE, TEAM)).toThrow('fresh owned');
  });
});

describe('concrete board-QA runner launch preparation', () => {
  it('validates fragmented usbmuxd packets, exact USB identity, network byte order, and bidirectional half-close without devices', () => {
    const tests = String.raw`
import importlib.util, plistlib, socket, threading
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("boardqa_forward", "scripts/board-qa/usb-forward.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def packet(contents, tag, version=1):
    payload = plistlib.dumps(contents)
    return module.HEADER.pack(module.HEADER.size + len(payload), version, 8, tag) + payload
class Connection:
    def __init__(self, payload):
        self.payload, self.sent, self.closed = payload, bytearray(), False
    def recv(self, length):
        received = self.payload[:min(length, 3)]
        self.payload = self.payload[len(received):]
        return received
    def sendall(self, payload): self.sent.extend(payload)
    def connect(self, address): assert address == "/var/run/usbmuxd"
    def settimeout(self, seconds): assert seconds == 10
    def close(self): self.closed = True
def messages(payload):
    parsed = []
    while payload:
        length, version, kind, tag = module.HEADER.unpack(payload[:16])
        assert (version, kind) == (1, 8)
        parsed.append(plistlib.loads(payload[16:length]))
        payload = payload[length:]
    return parsed
connection = Connection(packet({"Number": 0}, 2) + b"HTTP bytes")
assert module.request(connection, {"MessageType": "Connect"}, 2) == {"Number": 0}
assert connection.payload == b"HTTP bytes"
for bad in [packet({}, 3), packet({}, 2, version=2), module.HEADER.pack(module.MAX_PACKET + 1, 1, 8, 2)]:
    try: module.request(Connection(bad), {}, 2)
    except ConnectionError: pass
    else: raise AssertionError("Accepted malformed usbmuxd response")
device = "00008110-0000000000000001"
def entry(identity, connection_type, number):
    return {"DeviceID": number, "Properties": {"SerialNumber": identity, "ConnectionType": connection_type}}
inventory = {"DeviceList": [entry(device, "Network", 1), entry("another-device", "USB", 2), entry(device, "USB", 3)]}
connection = Connection(packet(inventory, 1) + packet({"Number": 0}, 2))
with patch.object(module.socket, "socket", return_value=connection):
    assert module.connect_device(device, 8211) is connection
assert messages(connection.sent)[1]["DeviceID"] == 3
assert messages(connection.sent)[1]["PortNumber"] == socket.htons(8211)
for entries in [[entry(device, "Network", 1)], [entry(device, "USB", 1), entry(device, "USB", 2)]]:
    connection = Connection(packet({"DeviceList": entries}, 1))
    with patch.object(module.socket, "socket", return_value=connection):
        try: module.connect_device(device, 8211)
        except ConnectionError: assert connection.closed
        else: raise AssertionError("Accepted absent or ambiguous USB identity")
caller, client = socket.socketpair()
upstream, peripheral = socket.socketpair()
stopping = threading.Event()
worker = threading.Thread(target=module.bridge, args=(client, upstream, stopping), daemon=True)
try:
    for connection in (caller, client, upstream, peripheral): connection.settimeout(1)
    worker.start()
    caller.sendall(b"request")
    assert peripheral.recv(7) == b"request"
    peripheral.sendall(b"response")
    assert caller.recv(8) == b"response"
    caller.shutdown(socket.SHUT_WR)
    assert peripheral.recv(1) == b""
    peripheral.sendall(b"tail")
    assert caller.recv(4) == b"tail"
    peripheral.shutdown(socket.SHUT_WR)
    worker.join(timeout=1)
    assert not worker.is_alive()
finally:
    stopping.set()
    for connection in (caller, client, upstream, peripheral): connection.close()
    worker.join(timeout=1)
`;
    expect(() => execFileSync('python3', ['-c', tests], { encoding: 'utf8', timeout: 10_000 })).not.toThrow();
  });

  it('requires a build and refuses changed staged source', () => {
    const { source, stage } = fixture();
    stageBoardQaIosDriver(source, stage, DEVICE, TEAM);
    expect(() => prepareBoardQaIosLaunch(stage)).toThrow();
    writeFileSync(join(stage, 'WebDriverAgent/WebDriverAgent.xcodeproj/project.pbxproj'), 'modified');
    expect(() => prepareBoardQaIosLaunch(stage)).toThrow('source changed');
  });

  it('patches only the owned target and preserves the original xctestrun and app environment', () => {
    const { source, stage } = fixture();
    stageBoardQaIosDriver(source, stage, DEVICE, TEAM);
    const products = join(stage, 'derivedData/Build/Products');
    mkdirSync(products, { recursive: true });
    const original = join(products, 'WebDriverAgentRunner.xctestrun');
    const specification = {
      WebDriverAgentRunner: {
        TestHostBundleIdentifier: `${BOARD_QA_RUNNER_ID}.xctrunner`,
        EnvironmentVariables: { EXISTING: 'keep' },
        TestHostPath: '__TESTROOT__/Debug-iphoneos/WebDriverAgentRunner-Runner.app',
      },
      AnotherTarget: { EnvironmentVariables: { USE_PORT: 'unchanged' } },
    };
    writePlist(original, specification);
    const instructions = prepareBoardQaIosLaunch(stage);
    const prepared = readPlist(join(products, 'BoardseshBoardQa.xctestrun'));
    expect(prepared.WebDriverAgentRunner).toEqual({
      ...specification.WebDriverAgentRunner,
      EnvironmentVariables: { EXISTING: 'keep', USE_PORT: '8211' },
    });
    expect(prepared.AnotherTarget).toEqual(specification.AnotherTarget);
    expect(readPlist(original)).toEqual(specification);
    expect(instructions.launch.arguments).toContain(`id=${DEVICE}`);
    expect(instructions.usbForward).toEqual({
      executable: 'vp',
      arguments: ['exec', 'python3', 'scripts/board-qa/usb-forward.py', '--device', DEVICE, '--port', '8211'],
    });
    expect(instructions.statusUrl).toBe('http://127.0.0.1:8211/status');
    expect(() => prepareBoardQaIosLaunch(stage)).not.toThrow();
    expect(git.calls).not.toContain('xcodebuild');
    expect(git.calls).not.toContain('xcrun');
  });

  it('supports the modern TestConfigurations shape and rejects another built runner', () => {
    const { source, stage } = fixture();
    stageBoardQaIosDriver(source, stage, DEVICE, TEAM);
    const products = join(stage, 'derivedData/Build/Products');
    mkdirSync(products, { recursive: true });
    const original = join(products, 'WebDriverAgentRunner.xctestrun');
    writePlist(original, {
      TestConfigurations: [
        {
          TestTargets: [
            { BlueprintName: 'WebDriverAgentRunner', TestHostBundleIdentifier: `${BOARD_QA_RUNNER_ID}.xctrunner` },
          ],
        },
      ],
    });
    expect(() => prepareBoardQaIosLaunch(stage)).not.toThrow();
    writePlist(original, { WebDriverAgentRunner: { TestHostBundleIdentifier: 'someone.else.runner' } });
    expect(() => prepareBoardQaIosLaunch(stage)).toThrow();
  });
});
