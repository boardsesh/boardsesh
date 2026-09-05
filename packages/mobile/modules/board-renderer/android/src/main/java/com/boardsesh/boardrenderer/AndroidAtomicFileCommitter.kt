// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

package com.boardsesh.boardrenderer

import android.system.ErrnoException
import android.system.Os
import java.io.File
import java.io.IOException

/** Android's API-21+ atomic same-filesystem publisher for completed overlay PNGs. */
object AndroidAtomicFileCommitter : AtomicFileCommitter {
    override fun commit(source: File, destination: File) {
        try {
            // AtomicFileWrite always creates source in destination.parentFile,
            // so this is one same-filesystem rename that safely replaces an
            // existing regular destination even under concurrent publication.
            Os.rename(source.absolutePath, destination.absolutePath)
        } catch (failure: ErrnoException) {
            // CacheDirRecovery deliberately retries IOException only. Preserve
            // errno as the cause while presenting the filesystem contract it
            // expects at the module boundary.
            throw IOException(
                "Failed to publish ${source.absolutePath} at ${destination.absolutePath}",
                failure,
            )
        } catch (failure: SecurityException) {
            throw IOException(
                "Permission denied publishing ${source.absolutePath} at ${destination.absolutePath}",
                failure,
            )
        }
    }
}
