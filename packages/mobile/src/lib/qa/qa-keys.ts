// Identity of "the thing being tested right now": a branch plus the exact JS
// bundle serving it. A tester who files a verdict, stays on the branch, and
// then pulls the author's next push is testing something new — so the brief
// should show again and the drawer should offer a fresh verdict. Keying on the
// branch alone would suppress both; keying on the updateId alone would collide
// across branches that happen to share an embedded launch.

/**
 * `<branch>:<updateId>`. `embedded` stands in for a launch with no updateId —
 * the bundle baked into the binary, which cannot change without a new build, so
 * one stable token per branch is exactly right there.
 */
export function qaSessionKey(branch: string, updateId: string | null | undefined): string {
  return `${branch}:${updateId ?? 'embedded'}`;
}
