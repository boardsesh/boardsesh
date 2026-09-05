// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

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
 * kill between [AtomicFileWrite]'s compress and rename leaves a private
 * ".bsov-*.tmp" behind) and the size-based LRU eviction it runs alongside. The
 * private prefix and final `.png` suffix are part of the safety contract: this
 * helper must never sweep, count, or evict an unrelated component's file.
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
        val orphan = File(cacheDir, "${AtomicFileWrite.TEMP_PREFIX}abc123${AtomicFileWrite.TEMP_SUFFIX}")
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
    fun `sweeps only private-prefix temp files`() {
        val managedOrphan = File(
            cacheDir,
            "${AtomicFileWrite.TEMP_PREFIX}managed${AtomicFileWrite.TEMP_SUFFIX}",
        )
        managedOrphan.writeBytes(byteArrayOf(1))
        val unrelatedTemp = File(cacheDir, "download${AtomicFileWrite.TEMP_SUFFIX}")
        unrelatedTemp.writeBytes(byteArrayOf(2))
        val prefixOnly = File(cacheDir, "${AtomicFileWrite.TEMP_PREFIX}not-a-temp.png")
        prefixOnly.writeBytes(byteArrayOf(3))

        val result = CachePruner.pruneCacheIfNeeded(cacheDir, maxBytes = 1_000_000)

        assertEquals(1, result.orphanedTempFilesRemoved)
        assertFalse(managedOrphan.exists())
        assertTrue("unowned .tmp file survives", unrelatedTemp.exists())
        assertTrue("prefix without the private suffix survives", prefixOnly.exists())
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
        val orphan = File(cacheDir, "${AtomicFileWrite.TEMP_PREFIX}orphan${AtomicFileWrite.TEMP_SUFFIX}")
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
    fun `over-cap eviction preserves unrelated files and temp files`() {
        val unrelatedTemp = File(cacheDir, "download.tmp")
        unrelatedTemp.writeBytes(ByteArray(1_000))
        unrelatedTemp.setLastModified(1_000)

        val unrelatedMetadata = File(cacheDir, "metadata.json")
        unrelatedMetadata.writeBytes(ByteArray(1_000))
        unrelatedMetadata.setLastModified(2_000)

        val oldestManagedEntry = File(cacheDir, "oldest.png")
        oldestManagedEntry.writeBytes(ByteArray(10))
        oldestManagedEntry.setLastModified(3_000)

        val newestManagedEntry = File(cacheDir, "newest.png")
        newestManagedEntry.writeBytes(ByteArray(10))
        newestManagedEntry.setLastModified(4_000)

        val result = CachePruner.pruneCacheIfNeeded(cacheDir, maxBytes = 15)

        assertEquals(0, result.orphanedTempFilesRemoved)
        assertEquals(1, result.cacheEntriesEvicted)
        assertTrue("unrelated .tmp file survives", unrelatedTemp.exists())
        assertTrue("unrelated metadata survives", unrelatedMetadata.exists())
        assertFalse("oldest managed PNG is evicted", oldestManagedEntry.exists())
        assertTrue("newest managed PNG survives", newestManagedEntry.exists())
        assertEquals(10L, result.finalTotalBytes)
    }

    @Test
    fun `a temp file never counts toward the size cap for real cache entries`() {
        // Even a huge orphaned temp file must not push a well-under-cap real
        // entry into eviction — it's swept unconditionally, before the cap
        // check ever runs against the remaining entries.
        val orphan = File(cacheDir, "${AtomicFileWrite.TEMP_PREFIX}huge${AtomicFileWrite.TEMP_SUFFIX}")
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
