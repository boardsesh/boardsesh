// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

package com.boardsesh.boardrenderer

import java.io.FileNotFoundException
import java.io.IOException

/**
 * Bounds retry for the *whole* overlay-cache pipeline (fast-path check,
 * render, and write), not just the write step [CacheDirRecovery] already
 * guards.
 *
 * #4107: even with #4041's directory-recreation retry and #3748's atomic
 * write, a single retry can still lose to *sustained* storage pressure —
 * the just-recreated directory (or a freshly created temp file inside it)
 * can vanish a second time before the retried write lands. That second
 * failure was previously unguarded and reached JS as a rejected
 * `renderHoldsOverlay` promise. Investigation for #4107 also confirmed the
 * fast-path cache-hit check (`outputFile.exists()` / `.length()` /
 * `.setLastModified()`) is metadata-only and never throws on its own — so
 * this wrapper exists to survive a second write-side vanish, and as
 * defense-in-depth if a future change to the fast path ever adds a real
 * read.
 *
 * The retry gate is a *vanished cache*, classified two ways:
 *
 * 1. [FileNotFoundException] — the classic "the cache file/dir isn't there
 *    right now" signal, kept as an explicit retry trigger in its own right
 *    (it is an [IOException] subclass, so it would also pass the second
 *    check whenever the directory is gone, but the intent — a missing
 *    *path*, retry-worthy regardless of directory state at catch time — is
 *    preserved explicitly).
 * 2. A plain [IOException] thrown while the cache directory is missing
 *    ([isCacheDirMissing] returns true at catch time). In the current
 *    atomic-write pipeline most second-vanish failures surface this way,
 *    not as FNF: `File.createTempFile` into a vanished directory throws a
 *    plain `IOException("No such file or directory")`, and an ENOENT
 *    `ErrnoException` from `Os.rename` is wrapped in a plain [IOException]
 *    by [AndroidAtomicFileCommitter].
 *
 * A plain [IOException] with the directory still in place — out-of-space,
 * permissions — is deliberately NOT retried: that failure mode is not a
 * vanished cache entry, re-rendering can't fix it, and silently retrying
 * the entire pipeline for it would double the wasted work without fixing
 * anything. This keeps the contract narrower than [CacheDirRecovery]'s
 * broad `IOException` acceptance, which stays that helper's own inner,
 * write-scoped concern.
 *
 * Pure Kotlin, no Android framework calls, no `File`-specific coupling —
 * the directory check is injected as [isCacheDirMissing] (the call site in
 * [BoardRendererModule] supplies the real `!cacheDir.isDirectory`) — so
 * [CacheMissRecoveryTest] needs neither Robolectric nor a real cache
 * directory, matching [CacheDirRecovery]'s approach for its sibling helper.
 */
object CacheMissRecovery {
    /**
     * Runs [action]. If it throws a retryable failure — a
     * [FileNotFoundException], or any other [IOException] while
     * [isCacheDirMissing] reports the cache directory gone — invokes
     * [onRecovered] with the original failure plus the directory-missing
     * verdict (so the call site can log what actually happened), and runs
     * [action] exactly one more time. A non-retryable failure — a plain
     * [IOException] with the directory still present, or anything that isn't
     * an [IOException] at all — propagates immediately, untouched. A second
     * retryable failure also propagates: the retry is bounded to one extra
     * attempt, so a persistently vanished cache path still fails fast
     * instead of looping.
     */
    fun <T> retryOnceOnCacheVanish(
        isCacheDirMissing: () -> Boolean,
        onRecovered: (failure: IOException, cacheDirMissing: Boolean) -> Unit = { _, _ -> },
        action: () -> T,
    ): T {
        return try {
            action()
        } catch (failure: IOException) {
            val cacheDirMissing = isCacheDirMissing()
            if (failure !is FileNotFoundException && !cacheDirMissing) throw failure
            onRecovered(failure, cacheDirMissing)
            action()
        }
    }
}
