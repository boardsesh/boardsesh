package com.boardsesh.boardrenderer

import java.io.File
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Covers [CachePruner] in isolation: the orphaned-temp-file sweep (a process
 * kill between [AtomicFileWrite]'s compress and rename leaves a
 * "$cacheKey.png.tmp" behind — #3748) and the size-based LRU eviction it runs
 * alongside.
 */
class CachePrunerTest {
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

    @Test
    fun `sweeps an orphaned temp file regardless of the size cap`() {
        val orphan = File(cacheDir, "abc123.png${AtomicFileWrite.TEMP_SUFFIX}")
        orphan.writeBytes(byteArrayOf(1))
        val validEntry = File(cacheDir, "def456.png")
        validEntry.writeBytes(byteArrayOf(1, 2, 3))

        val result = CachePruner.pruneCacheIfNeeded(cacheDir, maxBytes = 1_000_000)

        assertEquals(1, result.orphanedTempFilesRemoved)
        assertEquals(0, result.cacheEntriesEvicted)
        assertFalse("orphaned temp file is gone", orphan.exists())
        assertTrue("valid cache entry survives (well under cap)", validEntry.exists())
    }

    @Test
    fun `does nothing when the cache is empty`() {
        val result = CachePruner.pruneCacheIfNeeded(cacheDir, maxBytes = 1_000_000)

        assertEquals(0, result.orphanedTempFilesRemoved)
        assertEquals(0, result.cacheEntriesEvicted)
        assertEquals(0L, result.finalTotalBytes)
    }

    @Test
    fun `evicts oldest-first once the cap is exceeded, on top of the temp sweep`() {
        val orphan = File(cacheDir, "orphan.png${AtomicFileWrite.TEMP_SUFFIX}")
        orphan.writeBytes(ByteArray(10))

        val oldest = File(cacheDir, "oldest.png")
        oldest.writeBytes(ByteArray(10))
        oldest.setLastModified(1_000)

        val newest = File(cacheDir, "newest.png")
        newest.writeBytes(ByteArray(10))
        newest.setLastModified(2_000)

        val result = CachePruner.pruneCacheIfNeeded(cacheDir, maxBytes = 15)

        assertEquals(1, result.orphanedTempFilesRemoved)
        assertEquals(1, result.cacheEntriesEvicted)
        assertFalse("orphan swept", orphan.exists())
        assertFalse("oldest entry evicted by LRU", oldest.exists())
        assertTrue("newest entry survives", newest.exists())
        assertEquals(10L, result.finalTotalBytes)
    }

    @Test
    fun `a temp file never counts toward the size cap for real cache entries`() {
        // Even a huge orphaned temp file must not push a well-under-cap real
        // entry into eviction — it's swept unconditionally, before the cap
        // check ever runs against the remaining entries.
        val orphan = File(cacheDir, "huge.png${AtomicFileWrite.TEMP_SUFFIX}")
        orphan.writeBytes(ByteArray(1_000))
        val validEntry = File(cacheDir, "small.png")
        validEntry.writeBytes(ByteArray(5))

        val result = CachePruner.pruneCacheIfNeeded(cacheDir, maxBytes = 10)

        assertEquals(1, result.orphanedTempFilesRemoved)
        assertEquals(0, result.cacheEntriesEvicted)
        assertTrue("real entry untouched", validEntry.exists())
        assertEquals(5L, result.finalTotalBytes)
    }
}
