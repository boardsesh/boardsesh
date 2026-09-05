// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Boardsesh

package com.boardsesh.boardrenderer

import java.io.File

/**
 * Pure file-system bookkeeping for the overlay PNG cache directory:
 *
 * 1. Sweep orphaned [AtomicFileWrite] temp files — a process kill between the
 *    compress and rename leaves one behind. Only files carrying that helper's
 *    private prefix *and* suffix are swept; unrelated `.tmp` files are not ours
 *    to delete.
 * 2. Count and evict final `.png` overlay entries oldest-first by mtime until
 *    those managed entries are back under [pruneCacheIfNeeded]'s `maxBytes`.
 *    Every other file is excluded from both size accounting and eviction.
 *
 * Pure `java.io` on purpose — no Android framework calls (in particular, no
 * `android.util.Log`) — so [CachePrunerTest] can run as a plain JUnit test.
 * `BoardRendererModule` does the Android logging at the call site using the
 * counts in the returned [Result].
 */
object CachePruner {
    private const val CACHE_ENTRY_SUFFIX = ".png"

    data class Result(
        val orphanedTempFilesRemoved: Int,
        val cacheEntriesEvicted: Int,
        val finalTotalBytes: Long,
    )

    fun pruneCacheIfNeeded(cacheDir: File, maxBytes: Long): Result {
        val files = cacheDir.listFiles()?.toList() ?: return Result(0, 0, 0)

        val staleTempFiles = files.filter(AtomicFileWrite::isManagedTempFile)
        val cacheEntries = files.filter { file ->
            file.isFile && file.name.endsWith(CACHE_ENTRY_SUFFIX)
        }
        var orphanedRemoved = 0
        for (tempFile in staleTempFiles) {
            if (tempFile.delete()) orphanedRemoved++
        }

        var totalBytes = cacheEntries.sumOf { it.length() }
        if (totalBytes <= maxBytes) {
            return Result(orphanedRemoved, 0, totalBytes)
        }

        // Android's File.lastModified() is our LRU proxy — atime is not
        // reliably available on the filesystems Android caches live on.
        val sorted = cacheEntries.sortedBy { it.lastModified() }
        var evicted = 0
        for (file in sorted) {
            if (totalBytes <= maxBytes) break
            val size = file.length()
            if (file.delete()) {
                totalBytes -= size
                evicted++
            }
        }
        return Result(orphanedRemoved, evicted, totalBytes)
    }
}
