package com.boardsesh.boardrenderer

import java.io.File
import java.io.IOException
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Covers [AtomicFileWrite] in isolation — the temp-file-then-rename machinery
 * that fixes #3748 (a mid-compress crash used to leave a truncated PNG at the
 * final cache path, and the cache's `exists()`-only fast path then served it
 * forever). The actual PNG `compress()` call needs a real `Bitmap` (JNI) and
 * isn't exercised here; this covers the write-atomically wrapper with a plain
 * byte-array stand-in, mirroring [CacheDirRecoveryTest]'s approach for the
 * sibling helper.
 */
class AtomicFileWriteTest {
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

    private fun tempFileFor(destination: File) =
        File(destination.parentFile, "${destination.name}${AtomicFileWrite.TEMP_SUFFIX}")

    @Test
    fun `lands the destination file only after a successful write`() {
        val destination = File(cacheDir, "climb.png")

        AtomicFileWrite.writeAtomically(destination) { tempFile ->
            tempFile.writeBytes(byteArrayOf(1, 2, 3))
        }

        assertTrue("destination exists after a clean write", destination.exists())
        assertArrayEquals(byteArrayOf(1, 2, 3), destination.readBytes())
        assertFalse("temp file is gone once renamed away", tempFileFor(destination).exists())
    }

    /**
     * The regression this fix closes: a crash mid-write must never leave a
     * partial file at the destination path for the cache's `exists()`-only
     * fast path to pick up.
     */
    @Test
    fun `a throw during write leaves no file at the destination`() {
        val destination = File(cacheDir, "climb.png")

        val failure = try {
            AtomicFileWrite.writeAtomically(destination) { tempFile ->
                tempFile.writeBytes(byteArrayOf(1, 2, 3))
                throw IOException("simulated mid-compress crash")
            }
            null
        } catch (thrown: IOException) {
            thrown
        }

        assertEquals("simulated mid-compress crash", failure?.message)
        assertFalse("no partial file at the destination", destination.exists())
        assertFalse("temp file cleaned up on the failure path", tempFileFor(destination).exists())
    }

    /**
     * A throwing write must not clobber whatever was already at the
     * destination — e.g. a still-valid cache entry from a previous render.
     */
    @Test
    fun `a throw during write leaves a pre-existing destination untouched`() {
        val destination = File(cacheDir, "climb.png")
        destination.writeBytes(byteArrayOf(9, 9, 9))

        try {
            AtomicFileWrite.writeAtomically(destination) { tempFile ->
                tempFile.writeBytes(byteArrayOf(1, 2, 3))
                throw IOException("simulated mid-compress crash")
            }
        } catch (expected: IOException) {
            // expected
        }

        assertArrayEquals(
            "pre-existing destination survives a failed re-render untouched",
            byteArrayOf(9, 9, 9),
            destination.readBytes(),
        )
    }

    @Test
    fun `a failed rename propagates and still cleans up the temp file`() {
        // A directory sitting where the destination should be: renameTo can
        // never win.
        val destination = File(cacheDir, "climb.png")
        destination.mkdirs()

        val failure = try {
            AtomicFileWrite.writeAtomically(destination) { tempFile ->
                tempFile.writeBytes(byteArrayOf(1, 2, 3))
            }
            null
        } catch (thrown: IOException) {
            thrown
        }

        assertTrue(
            "rename failure surfaces as an IOException",
            failure?.message?.contains("Failed to move") == true,
        )
        assertFalse(
            "temp file cleaned up even though the rename failed",
            tempFileFor(destination).exists(),
        )
        assertTrue("destination directory itself is untouched", destination.isDirectory)
    }
}
