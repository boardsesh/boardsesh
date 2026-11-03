/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-accessory-settler-'));
const executablePath = join(fixtureDirectory, 'accessory-settler');

// Compile the actual header shipped in the dependency patch, rather than a
// TypeScript copy of the native transition policy.
beforeAll(() => {
  const patchLines = readFileSync(
    new URL('../patches/react-native-screens@4.30.0.patch', import.meta.url),
    'utf8',
  ).split('\n');
  const headerStart = patchLines.indexOf('+++ b/ios/tabs/bottom-accessory/RNSAccessoryPresentationSettler.h');
  if (headerStart < 0) throw new Error('The production accessory presentation settler is missing from the patch');
  const nextFile = patchLines.findIndex((line, index) => index > headerStart && line.startsWith('diff --git '));
  const headerLines = patchLines.slice(headerStart + 1, nextFile < 0 ? undefined : nextFile);
  writeFileSync(
    join(fixtureDirectory, 'RNSAccessoryPresentationSettler.h'),
    headerLines
      .filter((line) => line.startsWith('+'))
      .map((line) => line.slice(1))
      .join('\n'),
  );
  const harnessPath = join(fixtureDirectory, 'accessory-settler.cpp');
  writeFileSync(
    harnessPath,
    `
#include "RNSAccessoryPresentationSettler.h"
#include <cstdlib>
#include <iostream>
#include <string>
using rnscreens::AccessoryPresentationSample;
using rnscreens::AccessoryPresentationSettler;

static void require(bool condition, const char *message) {
  if (!condition) { std::cerr << message << std::endl; std::exit(1); }
}

int main(int argc, char **argv) {
  require(argc == 2, "Specify a native scenario");
  const std::string scenario = argv[1];
  AccessoryPresentationSettler settler;
  if (scenario == "coalesce") {
    require(settler.begin(10), "First geometry edge must publish moving");
    require(!settler.begin(10.1), "Repeated edges must not publish moving again");
    require(!settler.begin(10.2), "A third edge must remain coalesced");
  } else if (scenario == "stability") {
    settler.begin(0);
    require(settler.sample(0.1, true) == AccessoryPresentationSample::Pending, "One stable frame is insufficient");
    require(settler.sample(0.2, false) == AccessoryPresentationSample::Pending, "Moving geometry must not settle");
    require(settler.sample(0.3, true) == AccessoryPresentationSample::Pending, "Stability must restart after movement");
    require(settler.sample(0.4, true) == AccessoryPresentationSample::Settled, "Two consecutive stable frames must settle");
    require(settler.sample(0.5, true) == AccessoryPresentationSample::Pending, "Idle sampling must not publish settled repeatedly");
    require(settler.sample(0.6, true) == AccessoryPresentationSample::Pending, "Idle frames must not accumulate new stability");
    require(settler.begin(0.7), "A later transition must publish a new moving edge");
  } else if (scenario == "dirty-edge") {
    settler.begin(0);
    settler.sample(0.1, true);
    require(!settler.begin(0.2), "A dirty edge during movement must remain coalesced");
    require(settler.sample(0.3, true) == AccessoryPresentationSample::Pending, "A dirty edge must discard previous stable frames");
    require(settler.sample(0.4, true) == AccessoryPresentationSample::Settled, "New stable geometry must still settle");
  } else if (scenario == "deadline") {
    settler.begin(10);
    settler.begin(11.9);
    require(settler.sample(12.01, false) == AccessoryPresentationSample::TimedOut, "Repeated geometry edges must not extend the two-second deadline");
    require(settler.sample(12.02, true) == AccessoryPresentationSample::Pending, "A timed-out transition must stop sampling");
    require(settler.begin(12.1), "A later transition must recover after timeout");
  } else if (scenario == "detach") {
    settler.begin(0);
    settler.sample(0.1, true);
    settler.reset();
    require(settler.sample(0.2, true) == AccessoryPresentationSample::Pending, "Detached presentation must remain idle");
    require(settler.sample(0.21, true) == AccessoryPresentationSample::Pending, "Detached frames must not accumulate stability");
    require(settler.begin(0.3), "Reattachment must start a fresh transition");
    require(settler.sample(0.4, true) == AccessoryPresentationSample::Pending, "Reattachment must not reuse stale stability");
    require(settler.sample(0.5, true) == AccessoryPresentationSample::Settled, "Reattachment must settle normally");
  } else {
    require(false, "Unknown native scenario");
  }
  std::cout << scenario << " passed" << std::endl;
}
`,
  );
  execFileSync(process.env.CXX ?? 'c++', ['-std=c++17', harnessPath, '-o', executablePath], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}, 40_000);

afterAll(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

describe('native accessory presentation settlement', () => {
  it('can be imported by the Swift and Objective-C C module parser', () => {
    expect(
      execFileSync(process.env.CC ?? 'cc', ['-std=c11', '-x', 'c', '-fsyntax-only', '-I', fixtureDirectory, '-'], {
        input: '#include "RNSAccessoryPresentationSettler.h"\nint main(void) { return 0; }\n',
        encoding: 'utf8',
        timeout: 5_000,
      }),
    ).toBe('');
  });

  it.each(['coalesce', 'stability', 'dirty-edge', 'deadline', 'detach'])(
    'preserves the %s lifecycle contract',
    (scenario) => {
      expect(execFileSync(executablePath, [scenario], { encoding: 'utf8', timeout: 5_000 })).toBe(
        `${scenario} passed\n`,
      );
    },
  );
});
