import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNodeEnv } from '../mobile-patches-check';

// #5296 is fixed upstream in expo-modules-core@57.0.21. Keep guarding the
// installed source after retiring our patch: JS checks cannot see these native
// rejection messages, or Swift's definite-initialization failure.
function exceptionReasonErrors(source: string): string[] {
  const swiftSource = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const errors: string[] = [];
  if (!/let customReason:\s*String\?/.test(swiftSource)) errors.push('missing stored customReason');
  if (!/open var reason:\s*String\s*\{\s*customReason \?\? "undefined reason"\s*\}/.test(swiftSource)) {
    errors.push('reason loses the supplied description');
  }

  const defaultInitializer = swiftSource.match(/public init\(file:[^{]*\{([^}]*)\}/)?.[1] ?? '';
  if (!defaultInitializer.includes('self.customReason = nil'))
    errors.push('default initializer loses the nil fallback');

  const namedInitializer = swiftSource.match(/public init\(name:[^{]*\{([^}]*)\}/)?.[1] ?? '';
  const reasonAssignment = namedInitializer.indexOf('self.customReason = description');
  const nameAssignment = namedInitializer.indexOf('self.name = name');
  if (reasonAssignment < 0) errors.push('named initializer drops the supplied description');
  // name is an open lazy var: its dispatched setter cannot use self until the
  // class's stored properties have been initialized.
  if (nameAssignment < 0 || reasonAssignment < 0 || reasonAssignment > nameAssignment) {
    errors.push('customReason must be initialized before self.name');
  }
  return errors;
}

const FIXED_SOURCE = `
open class Exception {
  open var reason: String {
    customReason ?? "undefined reason"
  }
  let customReason: String?

  public init(file: String = #fileID) {
    self.customReason = nil
  }

  public init(name: String, description: String) {
    self.customReason = description
    self.name = name
  }
}
`;

describe('the upstream ExpoModulesCore exception description fix', () => {
  it('preserves native rejection descriptions and safe initialization in the installed source', () => {
    const mobilePackageJsonPath = resolve(import.meta.dirname, '../../packages/mobile/package.json');
    const env = createNodeEnv(mobilePackageJsonPath, {});
    const installedSource = env.readInstalledFile('expo-modules-core', 'ios/Core/Exceptions/Exception.swift');

    expect(exceptionReasonErrors(installedSource)).toEqual([]);
  });

  it('rejects the pre-#5296 source that discards every rejection description', () => {
    const preFixSource = `
open class Exception {
  open var reason: String {
    "undefined reason"
  }
  public init(file: String = #fileID) {
    self.customCode = nil
  }
  public init(name: String, description: String) {
    self.name = name
    self.description = description
  }
}
`;
    expect(exceptionReasonErrors(preFixSource)).toEqual([
      'missing stored customReason',
      'reason loses the supplied description',
      'default initializer loses the nil fallback',
      'named initializer drops the supplied description',
      'customReason must be initialized before self.name',
    ]);
  });

  it('rejects assigning the reason after the dispatched name setter', () => {
    const reorderedSource = FIXED_SOURCE.replace(
      'self.customReason = description\n    self.name = name',
      'self.name = name\n    self.customReason = description',
    );
    expect(exceptionReasonErrors(FIXED_SOURCE)).toEqual([]);
    expect(exceptionReasonErrors(reorderedSource)).toEqual(['customReason must be initialized before self.name']);
  });

  it('rejects a missing default initialization even when a comment retains the assignment', () => {
    const missingDefaultSource = FIXED_SOURCE.replace('self.customReason = nil', '// self.customReason = nil');
    expect(exceptionReasonErrors(missingDefaultSource)).toEqual(['default initializer loses the nil fallback']);
  });
});
