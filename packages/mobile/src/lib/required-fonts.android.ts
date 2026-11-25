// Android Material icons use bundled SVG paths, including Paper and navigation.
// A failed or slow icon-font download must no longer hold the launch screen.
export function loadRequiredFonts(): Promise<void> {
  return Promise.resolve();
}
