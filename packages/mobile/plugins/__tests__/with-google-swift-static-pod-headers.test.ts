import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type GoogleSwiftStaticPodHeadersPlugin = {
  applyGoogleSwiftStaticPodHeaders(contents: string): string;
  MODULAR_HEADER_PODS: string[];
};

const plugin = require('../with-google-swift-static-pod-headers.js') as GoogleSwiftStaticPodHeadersPlugin;

describe('with-google-swift-static-pod-headers', () => {
  it('adds modular header declarations after use_expo_modules', () => {
    const podfile = `
target 'Boardsesh' do
  use_expo_modules!
  use_frameworks! :linkage => :static
end
`;

    const updated = plugin.applyGoogleSwiftStaticPodHeaders(podfile);

    expect(updated).toContain(
      [
        '  use_expo_modules!',
        '  # AppCheckCore is Swift and these transitive ObjC pods need module maps when linked statically.',
        "  pod 'GoogleUtilities', :modular_headers => true",
        "  pod 'RecaptchaInterop', :modular_headers => true",
        '  use_frameworks! :linkage => :static',
      ].join('\n'),
    );
  });

  it('is idempotent when both modular header declarations already exist', () => {
    const podfile = `
target 'Boardsesh' do
  use_expo_modules!
  pod 'GoogleUtilities', :modular_headers => true
  pod 'RecaptchaInterop', :modular_headers => true
end
`;

    expect(plugin.applyGoogleSwiftStaticPodHeaders(podfile)).toBe(podfile);
  });

  it('adds only the missing declaration when one pod is already configured', () => {
    const podfile = `
target 'Boardsesh' do
  use_expo_modules!
  pod 'GoogleUtilities', :modular_headers => true
end
`;

    const updated = plugin.applyGoogleSwiftStaticPodHeaders(podfile);

    expect(updated.match(/pod 'GoogleUtilities'/g)).toHaveLength(1);
    expect(updated.match(/pod 'RecaptchaInterop'/g)).toHaveLength(1);
  });

  it('fails loudly if Expo changes the generated Podfile shape', () => {
    expect(() => plugin.applyGoogleSwiftStaticPodHeaders("target 'Boardsesh' do\nend\n")).toThrow(
      'Could not find use_expo_modules! in generated Podfile.',
    );
  });

  it('fails loudly if the insertion marker has no trailing line break', () => {
    expect(() => plugin.applyGoogleSwiftStaticPodHeaders("target 'Boardsesh' do\n  use_expo_modules!")).toThrow(
      'Could not insert modular-header pods after use_expo_modules!; Podfile has no line break.',
    );
  });
});
