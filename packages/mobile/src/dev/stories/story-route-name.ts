/** The public sitemap's direct-child context keys name this root navigator's routes. */
export function storyRouteName(filename: string): string {
  return filename
    .replace(/^\.\//, '')
    .replace(/\.[jt]sx?$/, '')
    .replace(/\/_layout$/, '');
}
