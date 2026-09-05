// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

package com.boardsesh.boardrenderer

import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Covers [CacheDirRecovery] in isolation. The guard's single call site —
 * `CacheDirRecovery.retryOnceAfterRecreating(cacheDir) { … }` wrapping the
 * `FileOutputStream` write in `BoardRendererModule.renderOverlay` — is *not*
 * covered here: exercising it needs a real `Bitmap` (JNI) plus a `Module`
 * appContext, i.e. a Robolectric harness, which is disproportionate for this
 * fix. Keep the wrapper at that one write site; deleting it re-opens #3182
 * without failing anything below.
 */
class CacheDirRecoveryTest {
    private lateinit var cacheDir: File

    @Before
    fun createCacheDir() {
        cacheDir = File.createTempFile("board-thumbnails", "").let { placeholder ->
            placeholder.delete()
            placeholder.also { it.mkdirs() }
        }
    }

    @After
    fun removeCacheDir() {
        cacheDir.deleteRecursively()
    }

    /**
     * The real failure: the OS reclaimed the cache dir mid-session, so the
     * first write fails with FileNotFoundException. Reverting the guard makes
     * that first failure propagate and the PNG never lands.
     */
    @Test
    fun `recreates a reclaimed cache dir and lands the write on the retry`() {
        val outputFile = File(cacheDir, "climb.png")
        assertTrue("precondition: dir was reclaimed", cacheDir.deleteRecursively())

        var attempts = 0
        var recoveredFrom: IOException? = null
        val writtenPath = CacheDirRecovery.retryOnceAfterRecreating(
            cacheDir,
            onRecovered = { writeFailure -> recoveredFrom = writeFailure },
        ) {
            attempts++
            FileOutputStream(outputFile).use { it.write(byteArrayOf(1, 2, 3)) }
            outputFile.absolutePath
        }

        assertEquals("write is retried exactly once", 2, attempts)
        assertTrue("cache dir was re-created", cacheDir.isDirectory)
        assertEquals(outputFile.absolutePath, writtenPath)
        assertTrue("PNG landed on disk", outputFile.exists())
        assertEquals(3, outputFile.length())
        assertTrue(
            "the call site gets the original failure to log",
            recoveredFrom is FileNotFoundException,
        )
    }

    /**
     * The gate is "is the dir there now", not "did we create it": if anything
     * else restores the directory between the failed write and the catch block,
     * `mkdirs()` returns false and a did-we-create-it gate would drop the
     * overlay even though the retry would now succeed.
     */
    @Test
    fun `retries when something else restored the cache dir first`() {
        val outputFile = File(cacheDir, "climb.png")
        assertTrue(cacheDir.deleteRecursively())

        var attempts = 0
        CacheDirRecovery.retryOnceAfterRecreating(cacheDir) {
            attempts++
            if (attempts == 1) {
                // Another actor puts the directory back as our write fails.
                cacheDir.mkdirs()
                throw FileNotFoundException("$outputFile (No such file or directory)")
            }
            FileOutputStream(outputFile).use { it.write(byteArrayOf(1, 2, 3)) }
        }

        assertEquals(2, attempts)
        assertTrue("PNG landed on the retry", outputFile.exists())
    }

    @Test
    fun `propagates without retrying when the path cannot be a directory`() {
        assertTrue(cacheDir.deleteRecursively())
        // A regular file where the cache dir should be: mkdirs() can never win.
        FileOutputStream(cacheDir).use { it.write(byteArrayOf(0)) }

        var attempts = 0
        var recovered = false
        val failure = try {
            CacheDirRecovery.retryOnceAfterRecreating(
                cacheDir,
                onRecovered = { recovered = true },
            ) {
                attempts++
                throw IOException("Not a directory")
            }
            null
        } catch (thrown: IOException) {
            thrown
        }

        assertEquals("an unusable cache path is not transient", 1, attempts)
        assertFalse("nothing to log when there was no recovery", recovered)
        assertEquals("Not a directory", failure?.message)
        assertTrue(cacheDir.delete())
    }

    @Test
    fun `a second failure propagates instead of looping`() {
        var attempts = 0
        assertTrue(cacheDir.deleteRecursively())

        val failure = try {
            CacheDirRecovery.retryOnceAfterRecreating(cacheDir) {
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
    fun `passes the value through untouched on the happy path`() {
        var attempts = 0
        var recoveredFrom: IOException? = null
        val result = CacheDirRecovery.retryOnceAfterRecreating(
            cacheDir,
            onRecovered = { writeFailure -> recoveredFrom = writeFailure },
        ) {
            attempts++
            "file://${cacheDir.absolutePath}/climb.png"
        }

        assertEquals(1, attempts)
        assertEquals("file://${cacheDir.absolutePath}/climb.png", result)
        assertFalse(File(cacheDir, "climb.png").exists())
        assertNull("no recovery on the hot path", recoveredFrom)
    }
}
