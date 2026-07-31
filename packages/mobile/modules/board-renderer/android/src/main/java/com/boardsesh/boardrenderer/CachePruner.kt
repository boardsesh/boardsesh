package com.boardsesh.boardrenderer

import java.io.File

/**
 * Pure file-system bookkeeping for the overlay PNG cache directory:
 *
 * 1. Sweep any orphaned [AtomicFileWrite] temp file — a process kill between
 *    the compress and the rename (see #3748) leaves one of these behind. It's
 *    never a valid cache entry, so it's removed unconditionally rather than
 *    waiting for the size cap to evict it by LRU.
 * 2. Evict cache entries oldest-first by mtime until the directory is back
 *    under [pruneCacheIfNeeded]'s `maxBytes`.
 *
 * Pure `java.io` on purpose — no Android framework calls (in particular, no
 * `android.util.Log`) — so [CachePrunerTest] can run as a plain JUnit test.
 * `BoardRendererModule` does the Android logging at the call site using the
 * counts in the returned [Result].
 */
object CachePruner {
    data class Result(
        val orphanedTempFilesRemoved: Int,
        val cacheEntriesEvicted: Int,
        val finalTotalBytes: Long,
    )

    fun pruneCacheIfNeeded(cacheDir: File, maxBytes: Long): Result {
        val files = cacheDir.listFiles()?.toList() ?: return Result(0, 0, 0)

        val (staleTempFiles, cacheEntries) = files.partition {
            it.name.endsWith(AtomicFileWrite.TEMP_SUFFIX)
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
