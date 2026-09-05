// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

package com.boardsesh.boardrenderer

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream

/**
 * Publishes [source] at [destination] with one atomic same-filesystem rename.
 * Android supplies [AndroidAtomicFileCommitter]; tests inject a JVM implementation
 * so the write/close/cleanup contract stays testable without Robolectric.
 */
fun interface AtomicFileCommitter {
    @Throws(IOException::class)
    fun commit(source: File, destination: File)
}

/**
 * Writes a file by writing to a temp file next to the destination first, then
 * renaming it into place. A thrown exception from [write] — or a failed rename
 * — deletes the temp file and leaves [destination] completely untouched: either
 * its prior contents (if any) survive unchanged, or nothing was ever created.
 * There is no window where a reader can observe a partially-written file at
 * [destination]'s path.
 *
 * The injected [AtomicFileCommitter] performs the publication. Production uses
 * `android.system.Os.rename`, and the unique temp file is created in
 * [destination]'s own parent directory so the rename stays on one filesystem.
 *
 * Fixes #3748: `BoardRendererModule.renderOverlay` used to write the overlay
 * PNG directly to its final cache path via `FileOutputStream`, and only
 * cleaned up when `compress()` returned `false` — not when it (or the
 * underlying stream write) *threw*, e.g. an IO interruption, a storage-full
 * condition, or the process getting killed mid-write. That left a truncated
 * PNG on disk, and the cache's `exists()`-only fast path then served it as a
 * permanent "successful" render forever.
 *
 * This helper remains pure `java.io` — no Android framework calls — so
 * [AtomicFileWriteTest] needs neither Robolectric nor a real Bitmap, matching
 * [CacheDirRecovery]'s approach for its sibling helper.
 */
object AtomicFileWrite {
    /**
     * A short hidden prefix plus `.tmp` suffix keeps in-flight files private to
     * this cache contract and distinguishable from unrelated temp files. The
     * final `.png` name is deliberately absent: cache readers must never mistake
     * an in-flight write for a renderable overlay.
     */
    const val TEMP_PREFIX: String = ".bsov-"
    const val TEMP_SUFFIX: String = ".tmp"

    fun isManagedTempFile(file: File): Boolean =
        file.name.startsWith(TEMP_PREFIX) && file.name.endsWith(TEMP_SUFFIX)

    /**
     * Creates a fresh same-directory temp file, lets [write] encode into a stream
     * owned by this helper, closes it, then atomically publishes it. Every failure
     * in that pipeline emerges as [IOException], which is the contract consumed
     * by [CacheDirRecovery]. An existing destination is untouched unless commit
     * succeeds.
     */
    fun writeAtomically(
        destination: File,
        committer: AtomicFileCommitter,
        outputStreamFactory: (File) -> OutputStream = { tempFile -> FileOutputStream(tempFile) },
        write: (OutputStream) -> Boolean,
    ) {
        val parentDirectory = destination.parentFile
            ?: throw IOException("Atomic destination has no parent: ${destination.absolutePath}")
        val tempFile = try {
            File.createTempFile(TEMP_PREFIX, TEMP_SUFFIX, parentDirectory)
        } catch (failure: Exception) {
            // Keep a raw temp-creation I/O failure intact for recovery instead
            // of wrapping it with the broader non-I/O normalization below.
            if (failure is IOException) throw failure
            throw IOException(
                "Failed to create an overlay temp file in ${parentDirectory.absolutePath}",
                failure,
            )
        }

        try {
            outputStreamFactory(tempFile).use { outputStream ->
                if (!write(outputStream)) {
                    throw IOException("PNG compression failed for ${destination.absolutePath}")
                }
            }
            committer.commit(tempFile, destination)
        } catch (failure: Exception) {
            // Preserve an existing filesystem failure (and any suppressed close
            // failure) rather than wrapping it inside another IOException.
            if (failure is IOException) throw failure
            // SecurityException and any encoder/publisher exception still need
            // to enter CacheDirRecovery's IOException-only retry contract.
            throw IOException(
                "Failed to write overlay atomically at ${destination.absolutePath}",
                failure,
            )
        } finally {
            // No-op after a successful rename. Cleanup must never replace the
            // original write/close/commit exception; an undeletable orphan is
            // picked up by CachePruner on the next module start.
            tempFile.delete()
        }
    }
}
