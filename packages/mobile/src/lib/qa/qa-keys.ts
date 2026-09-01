// Identity of "the thing being tested right now, by this account": a signed-in
// user, a branch, and the exact JS bundle serving it. A tester who files a
// verdict, stays on the branch, and then pulls the author's next push is testing
// something new — so the brief should show again and the drawer should offer a
// fresh verdict. Keying on the branch alone would suppress both; keying on the
// updateId alone would collide across branches that happen to share an embedded
// launch.

/**
 * `<userId>:<branch>:<updateId>`.
 *
 * The account is part of the key because the markers live in one device-wide
 * settings store: on a shared device, tester A signing off `pr-4792` must not
 * cost tester B their brief or hide B's "Finish testing" row after an account
 * switch. Nothing migrates the old two-part keys — they simply stop matching,
 * which re-arms the brief exactly once per branch + bundle and is the right
 * answer for a marker whose owner is unknown.
 *
 * `embedded` stands in for a launch with no updateId — the bundle baked into the
 * binary, which cannot change without a new build, so one stable token per
 * branch is exactly right there.
 */
export function qaSessionKey(userId: string, branch: string, updateId: string | null | undefined): string {
  return `${userId}:${branch}:${updateId ?? 'embedded'}`;
}
