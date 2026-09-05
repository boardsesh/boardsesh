// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

package com.boardsesh.boardrenderer

import java.io.File
import java.io.IOException

/**
 * The overlay PNG cache lives under `context.cacheDir`, which Android is free to
 * reclaim at any time under storage pressure — including while our process is
 * alive. The directory is created once when [BoardRendererModule.cacheDir] is
 * first touched, so once the OS deletes it every later write fails with
 * `FileNotFoundException` (ENOENT on the parent) and the render promise rejects:
 * hold overlays silently stop drawing until the app is restarted.
 *
 * This re-creates the directory and retries the write exactly once.
 *
 * Pure `java.io` on purpose — no Android framework calls — so the JVM unit tests
 * in `CacheDirRecoveryTest` need neither Robolectric nor a module-wide
 * `unitTests.returnDefaultValues` escape hatch (which would silently no-op any
 * Android API a future test touches). The diagnostic log lives at the call site
 * in [BoardRendererModule], through the `onRecovered` callback.
 */
object CacheDirRecovery {
    /**
     * Runs [action]. If it fails with an [IOException] and [cacheDir] is a
     * directory again afterwards, invokes [onRecovered] and runs [action] one
     * more time.
     *
     * The gate is "is the directory there now", not "did *this* call create
     * it": `mkdirs()` returns false both when the directory is already back
     * (something else restored it between the failure and here) and when it
     * can't be created at all, and only the second case should give up. A path
     * we genuinely can't turn into a directory — read-only volume, a regular
     * file sitting on the path — rethrows the original failure. That matches
     * the iOS twin's rule, and the retry is bounded to a single extra attempt
     * either way, so a persistently broken filesystem still fails fast.
     */
    fun <T> retryOnceAfterRecreating(
        cacheDir: File,
        onRecovered: (IOException) -> Unit = {},
        action: () -> T,
    ): T {
        return try {
            action()
        } catch (writeFailure: IOException) {
            cacheDir.mkdirs()
            if (!cacheDir.isDirectory) throw writeFailure
            onRecovered(writeFailure)
            action()
        }
    }
}
