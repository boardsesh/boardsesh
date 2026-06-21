import { describe, expect, it } from 'vitest';
import { findMobileBoardArtNetworkViolations, type SourceFile } from '../mobile-board-art-network-check';

function check(text: string): string[] {
  const sourceFiles: SourceFile[] = [{ path: 'packages/mobile/src/example.tsx', text }];
  return findMobileBoardArtNetworkViolations(sourceFiles).map((violation) => violation.rule);
}

describe('mobile board-art network check', () => {
  it('flags hosted board-art URLs', () => {
    expect(check("const src = 'https://www.boardsesh.com/images/kilter/bg.png';")).toContainEqual(
      expect.stringContaining('remote-board-image-host'),
    );
  });

  it('flags WEB_BASE_URL image URL construction', () => {
    expect(check('const url = `${WEB_BASE_URL}/images/${boardName}/${filename}`;')).toContainEqual(
      expect.stringContaining('web-base-board-images'),
    );
  });

  it('flags React Native image prefetches', () => {
    expect(check('Image.prefetch(boardImageUrl);')).toContainEqual(expect.stringContaining('image-prefetch'));
  });

  it('flags react-native-svg image backgrounds', () => {
    expect(check("import Svg, { Image as SvgImage } from 'react-native-svg';")).toContainEqual(
      expect.stringContaining('svg-image-background'),
    );
  });

  // 2.0: the Live Activity thumbnail fetches the server-composited board image
  // (include_background=1), matching the legacy Capacitor app. The
  // `server-rendered-background` rule was removed; re-adding offline board art is
  // tracked in the revisit issue.
  it('allows server-rendered background compositing (include_background)', () => {
    expect(check('URLQueryItem(name: "include_background", value: "1")')).toEqual([]);
  });

  it('allows intended remote user media image sources', () => {
    expect(
      check(`
        <Image source={{ uri: link.thumbnail }} />
        <Image source={{ uri: sizedAvatarUri(uri, size) }} />
      `),
    ).toEqual([]);
  });

  it('allows bundled board image paths and overlay images', () => {
    expect(
      check(`
        <Image source={{ uri: \`file://\${path}\` }} />
        <Image source={{ uri: overlayUri }} />
      `),
    ).toEqual([]);
  });
});
