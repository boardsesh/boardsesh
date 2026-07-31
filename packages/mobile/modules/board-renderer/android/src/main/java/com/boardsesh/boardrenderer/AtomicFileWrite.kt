package com.boardsesh.boardrenderer

import java.io.File
import java.io.IOException

/**
 * Writes a file by writing to a temp file next to the destination first, then
 * renaming it into place. A thrown exception from [write] — or a failed rename
 * — deletes the temp file and leaves [destination] completely untouched: either
 * its prior contents (if any) survive unchanged, or nothing was ever created.
 * There is no window where a reader can observe a partially-written file at
 * [destination]'s path.
 *
 * `File.renameTo` is an atomic `rename(2)` when the source and destination are
 * on the same filesystem, which they are here — the temp file is created in
 * [destination]'s own parent directory.
 *
 * Fixes #3748: `BoardRendererModule.renderOverlay` used to write the overlay
 * PNG directly to its final cache path via `FileOutputStream`, and only
 * cleaned up when `compress()` returned `false` — not when it (or the
 * underlying stream write) *threw*, e.g. an IO interruption, a storage-full
 * condition, or the process getting killed mid-write. That left a truncated
 * PNG on disk, and the cache's `exists()`-only fast path then served it as a
 * permanent "successful" render forever.
 *
 * Pure `java.io` on purpose — no Android framework calls — so
 * [AtomicFileWriteTest] needs neither Robolectric nor a real Bitmap, matching
 * [CacheDirRecovery]'s approach for its sibling helper.
 */
object AtomicFileWrite {
    /**
     * Temp-file suffix used for the in-flight write. Shared with
     * [CachePruner], which sweeps any file ending in this suffix as an
     * orphaned artifact of a crash between [write] and the rename.
     */
    const val TEMP_SUFFIX: String = ".tmp"

    fun writeAtomically(destination: File, write: (tempFile: File) -> Unit) {
        val tempFile = File(destination.parentFile, "${destination.name}$TEMP_SUFFIX")
        try {
            write(tempFile)
            if (!tempFile.renameTo(destination)) {
                throw IOException(
                    "Failed to move ${tempFile.absolutePath} into place at ${destination.absolutePath}"
                )
            }
        } finally {
            // No-op if the rename already moved it away; cleans up any partial
            // temp file left by a throw above (from `write` or the rename check).
            tempFile.delete()
        }
    }
}
