// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

package com.boardsesh.boardrenderer

import java.io.FileNotFoundException
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers [CacheMissRecovery] in isolation. The guard's single call site —
 * `CacheMissRecovery.retryOnceOnCacheVanish(...) { renderOverlayOnce(...) }`
 * wrapping the whole cache-check-render-write pipeline in
 * `BoardRendererModule.renderOverlay` — is *not* covered here, for the same
 * reason [CacheDirRecoveryTest] doesn't cover its own call site: exercising
 * it needs a real `Bitmap` (JNI) plus a `Module` appContext, i.e. a
 * Robolectric harness, which is disproportionate for this fix. Keep the
 * wrapper at that one call site; deleting it re-opens #4107 without failing
 * anything below.
 */
class CacheMissRecoveryTest {
    @Test
    fun `retries exactly once when the action throws FileNotFoundException`() {
        var attempts = 0
        var recoveredFrom: IOException? = null
        val originalFailure = FileNotFoundException("cache file vanished")

        val result = CacheMissRecovery.retryOnceOnCacheVanish(
            isCacheDirMissing = { true },
            onRecovered = { failure, _ -> recoveredFrom = failure },
        ) {
            attempts++
            if (attempts == 1) throw originalFailure
            "file:///cache/climb.png"
        }

        assertEquals("action ran once, failed, then ran again", 2, attempts)
        assertEquals("file:///cache/climb.png", result)
        assertSame("the call site gets the original failure to log", originalFailure, recoveredFrom)
    }

    @Test
    fun `FileNotFoundException retries even when the cache dir is back at catch time`() {
        // FNF stays an explicit retry signal in its own right: the path was
        // missing when the action ran, and a concurrent CacheDirRecovery (or
        // the OS) restoring the directory before our catch runs must not
        // disqualify the retry.
        var attempts = 0
        var reportedDirMissing: Boolean? = null

        val result = CacheMissRecovery.retryOnceOnCacheVanish(
            isCacheDirMissing = { false },
            onRecovered = { _, cacheDirMissing -> reportedDirMissing = cacheDirMissing },
        ) {
            attempts++
            if (attempts == 1) throw FileNotFoundException("file vanished, dir already restored")
            "file:///cache/climb.png"
        }

        assertEquals(2, attempts)
        assertEquals("file:///cache/climb.png", result)
        assertEquals("the call site is told the dir was present again", false, reportedDirMissing)
    }

    @Test
    fun `a plain IOException with the cache dir missing retries exactly once`() {
        // How a second vanish actually surfaces in the atomic-write pipeline:
        // File.createTempFile into a vanished dir throws plain IOException,
        // and AndroidAtomicFileCommitter wraps Os.rename's ENOENT
        // ErrnoException in plain IOException — neither is an FNF.
        var attempts = 0
        var recoveredFrom: IOException? = null
        var reportedDirMissing: Boolean? = null
        val originalFailure = IOException("No such file or directory")

        val result = CacheMissRecovery.retryOnceOnCacheVanish(
            isCacheDirMissing = { true },
            onRecovered = { failure, cacheDirMissing ->
                recoveredFrom = failure
                reportedDirMissing = cacheDirMissing
            },
        ) {
            attempts++
            if (attempts == 1) throw originalFailure
            "file:///cache/climb.png"
        }

        assertEquals("action ran once, failed, then ran again", 2, attempts)
        assertEquals("file:///cache/climb.png", result)
        assertSame(originalFailure, recoveredFrom)
        assertEquals("the call site can truthfully log the missing dir", true, reportedDirMissing)
    }

    @Test
    fun `a plain IOException with the cache dir present is not retried`() {
        // Out-of-space or permission failures with the directory in place the
        // whole time are not a vanished cache entry; re-rendering can't fix
        // them, so the broad-IOException contract stays rejected here.
        var attempts = 0
        var recovered = false
        var dirChecked = false
        val originalFailure = IOException("disk full")

        val failure = try {
            CacheMissRecovery.retryOnceOnCacheVanish(
                isCacheDirMissing = {
                    dirChecked = true
                    false
                },
                onRecovered = { _, _ -> recovered = true },
            ) {
                attempts++
                throw originalFailure
            }
            null
        } catch (thrown: IOException) {
            thrown
        }

        assertEquals("no retry for a dir-present IOException", 1, attempts)
        assertTrue("the gate consulted the injected dir check", dirChecked)
        assertFalse("nothing to log when there was no recovery", recovered)
        assertSame(originalFailure, failure)
    }

    @Test
    fun `a second FileNotFoundException propagates instead of looping`() {
        var attempts = 0

        val failure = try {
            CacheMissRecovery.retryOnceOnCacheVanish(
                isCacheDirMissing = { true },
            ) {
                attempts++
                throw FileNotFoundException("still gone")
            }
            null
        } catch (thrown: FileNotFoundException) {
            thrown
        }

        assertEquals("retry is bounded to one extra attempt", 2, attempts)
        assertEquals("still gone", failure?.message)
    }

    @Test
    fun `a second dir-missing IOException propagates instead of looping`() {
        var attempts = 0

        val failure = try {
            CacheMissRecovery.retryOnceOnCacheVanish(
                isCacheDirMissing = { true },
            ) {
                attempts++
                throw IOException("dir keeps vanishing")
            }
            null
        } catch (thrown: IOException) {
            thrown
        }

        assertEquals("retry is bounded to one extra attempt", 2, attempts)
        assertEquals("dir keeps vanishing", failure?.message)
    }

    @Test
    fun `a non-IOException failure propagates untouched`() {
        var attempts = 0
        var recovered = false
        val originalFailure = IllegalStateException("Rust render failed")

        val failure = try {
            CacheMissRecovery.retryOnceOnCacheVanish(
                isCacheDirMissing = { true },
                onRecovered = { _, _ -> recovered = true },
            ) {
                attempts++
                throw originalFailure
            }
            null
        } catch (thrown: IllegalStateException) {
            thrown
        }

        assertEquals("no retry for a non-IO failure, even with the dir missing", 1, attempts)
        assertFalse(recovered)
        assertSame(originalFailure, failure)
    }

    @Test
    fun `passes the value through untouched on the happy path`() {
        var attempts = 0
        var recoveredFrom: IOException? = null
        var dirChecked = false

        val result = CacheMissRecovery.retryOnceOnCacheVanish(
            isCacheDirMissing = {
                dirChecked = true
                true
            },
            onRecovered = { failure, _ -> recoveredFrom = failure },
        ) {
            attempts++
            "file:///cache/climb.png"
        }

        assertEquals(1, attempts)
        assertEquals("file:///cache/climb.png", result)
        assertNull("no recovery on the hot path", recoveredFrom)
        assertFalse("the dir check only runs after a failure", dirChecked)
    }
}
