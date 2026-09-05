// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Marco de Jongh

package com.boardsesh.boardrenderer

import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Plain-JVM coverage for the fresh-temp -> write -> close -> commit pipeline
 * used by BoardRendererModule. Android's production committer is injected at
 * the call site; these tests use the JVM's same-directory atomic move so no
 * Android framework method is executed under the unmocked android.jar stubs.
 */
class AtomicFileWriteTest {
    private lateinit var cacheDir: File

    private val jvmAtomicCommitter = AtomicFileCommitter { source, destination ->
        Files.move(
            source.toPath(),
            destination.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING,
        )
    }

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

    private fun managedTempFiles(): List<File> =
        cacheDir.listFiles()?.filter(AtomicFileWrite::isManagedTempFile) ?: emptyList()

    private fun writeBytes(
        destination: File,
        bytes: ByteArray,
        committer: AtomicFileCommitter = jvmAtomicCommitter,
        observedTempFiles: MutableList<File>? = null,
    ) {
        AtomicFileWrite.writeAtomically(
            destination = destination,
            committer = committer,
            outputStreamFactory = { tempFile ->
                observedTempFiles?.add(tempFile)
                FileOutputStream(tempFile)
            },
        ) { outputStream ->
            outputStream.write(bytes)
            true
        }
    }

    @Test
    fun `uses a fresh unique private temp in the destination directory`() {
        val destination = File(cacheDir, "climb.png")
        val observedTempFiles = mutableListOf<File>()

        writeBytes(destination, byteArrayOf(1, 2, 3), observedTempFiles = observedTempFiles)
        writeBytes(destination, byteArrayOf(4, 5, 6), observedTempFiles = observedTempFiles)

        assertEquals(2, observedTempFiles.size)
        for (tempFile in observedTempFiles) {
            assertEquals(cacheDir.canonicalFile, tempFile.parentFile.canonicalFile)
            assertTrue(tempFile.name.startsWith(AtomicFileWrite.TEMP_PREFIX))
            assertTrue(tempFile.name.endsWith(AtomicFileWrite.TEMP_SUFFIX))
            assertFalse("an in-flight file must not look like a PNG", tempFile.name.contains(".png"))
        }
        assertNotEquals("each attempt gets a collision-proof path", observedTempFiles[0].name, observedTempFiles[1].name)
        assertArrayEquals(byteArrayOf(4, 5, 6), destination.readBytes())
        assertTrue("successful commits leave no private temp", managedTempFiles().isEmpty())
    }

    @Test
    fun `a writer IOException is preserved and leaves the destination untouched`() {
        val destination = File(cacheDir, "climb.png")
        destination.writeBytes(byteArrayOf(9, 9, 9))
        val writerFailure = IOException("simulated mid-compress write failure")

        val thrown = try {
            AtomicFileWrite.writeAtomically(destination, jvmAtomicCommitter) { outputStream ->
                outputStream.write(byteArrayOf(1, 2, 3))
                throw writerFailure
            }
            null
        } catch (failure: IOException) {
            failure
        }

        assertSame("the original IOException reaches CacheDirRecovery", writerFailure, thrown)
        assertArrayEquals(byteArrayOf(9, 9, 9), destination.readBytes())
        assertTrue("partial temp is cleaned up", managedTempFiles().isEmpty())
    }

    @Test
    fun `a false compressor result emerges as IOException`() {
        val destination = File(cacheDir, "climb.png")

        val thrown = try {
            AtomicFileWrite.writeAtomically(destination, jvmAtomicCommitter) { outputStream ->
                outputStream.write(byteArrayOf(1, 2, 3))
                false
            }
            null
        } catch (failure: IOException) {
            failure
        }

        assertTrue(thrown?.message?.contains("PNG compression failed") == true)
        assertFalse(destination.exists())
        assertTrue(managedTempFiles().isEmpty())
    }

    @Test
    fun `a close IOException is preserved and commit is never attempted`() {
        val destination = File(cacheDir, "climb.png")
        val previousRender = byteArrayOf(9, 9, 9)
        destination.writeBytes(previousRender)
        val closeFailure = IOException("simulated close failure")
        var commitCalled = false
        val neverCommit = AtomicFileCommitter { _, _ -> commitCalled = true }

        val thrown = try {
            AtomicFileWrite.writeAtomically(
                destination = destination,
                committer = neverCommit,
                outputStreamFactory = { tempFile ->
                    object : FileOutputStream(tempFile) {
                        override fun close() {
                            super.close()
                            throw closeFailure
                        }
                    }
                },
            ) { outputStream ->
                outputStream.write(byteArrayOf(1, 2, 3))
                true
            }
            null
        } catch (failure: IOException) {
            failure
        }

        assertSame(closeFailure, thrown)
        assertFalse(commitCalled)
        assertArrayEquals(previousRender, destination.readBytes())
        assertTrue(managedTempFiles().isEmpty())
    }

    @Test
    fun `an output stream open IOException is preserved`() {
        val destination = File(cacheDir, "climb.png")
        val openFailure = FileNotFoundException("simulated output stream open failure")

        val thrown = try {
            AtomicFileWrite.writeAtomically(
                destination = destination,
                committer = jvmAtomicCommitter,
                outputStreamFactory = { throw openFailure },
            ) { true }
            null
        } catch (failure: IOException) {
            failure
        }

        assertSame(openFailure, thrown)
        assertFalse(destination.exists())
        assertTrue(managedTempFiles().isEmpty())
    }

    @Test
    fun `a writer failure remains primary when close also fails`() {
        val destination = File(cacheDir, "climb.png")
        val writerFailure = IOException("simulated writer failure")
        val closeFailure = IOException("simulated close failure")

        val thrown = try {
            AtomicFileWrite.writeAtomically(
                destination = destination,
                committer = jvmAtomicCommitter,
                outputStreamFactory = { tempFile ->
                    object : FileOutputStream(tempFile) {
                        override fun close() {
                            super.close()
                            throw closeFailure
                        }
                    }
                },
            ) {
                throw writerFailure
            }
            null
        } catch (failure: IOException) {
            failure
        }

        assertSame("writer failure remains the primary exception", writerFailure, thrown)
        assertTrue("close failure is retained for diagnostics", thrown?.suppressed?.contains(closeFailure) == true)
        assertFalse(destination.exists())
        assertTrue(managedTempFiles().isEmpty())
    }

    @Test
    fun `a commit IOException is preserved and leaves an existing destination untouched`() {
        val destination = File(cacheDir, "climb.png")
        destination.writeBytes(byteArrayOf(9, 9, 9))
        val commitFailure = IOException("simulated rename failure")

        val thrown = try {
            writeBytes(
                destination,
                byteArrayOf(1, 2, 3),
                committer = AtomicFileCommitter { _, _ -> throw commitFailure },
            )
            null
        } catch (failure: IOException) {
            failure
        }

        assertSame(commitFailure, thrown)
        assertArrayEquals(byteArrayOf(9, 9, 9), destination.readBytes())
        assertTrue(managedTempFiles().isEmpty())
    }

    @Test
    fun `a non-IO writer failure is normalized with its cause preserved`() {
        val destination = File(cacheDir, "climb.png")
        val encoderFailure = IllegalStateException("encoder rejected bitmap")

        val thrown = try {
            AtomicFileWrite.writeAtomically(destination, jvmAtomicCommitter) {
                throw encoderFailure
            }
            null
        } catch (failure: IOException) {
            failure
        }

        assertSame(encoderFailure, thrown?.cause)
        assertFalse(destination.exists())
        assertTrue(managedTempFiles().isEmpty())
    }

    @Test
    fun `a missing parent directory emerges as IOException`() {
        val destination = File(cacheDir, "climb.png")
        assertTrue(cacheDir.deleteRecursively())

        val thrown = try {
            writeBytes(destination, byteArrayOf(1, 2, 3))
            null
        } catch (failure: IOException) {
            failure
        }

        assertTrue("temp creation failure is recoverable", thrown is IOException)
        assertFalse(destination.exists())
    }

    @Test
    fun `directory disappearance retries the complete pipeline with a fresh temp`() {
        val destination = File(cacheDir, "climb.png")
        val observedTempFiles = mutableListOf<File>()
        var commitAttempts = 0
        var writeAttempts = 0
        var recoveredFrom: IOException? = null
        val disappearingDirectoryCommitter = AtomicFileCommitter { source, finalDestination ->
            commitAttempts++
            if (commitAttempts == 1) {
                assertTrue(source.delete())
                assertTrue(cacheDir.delete())
                throw FileNotFoundException("cache directory disappeared before publish")
            }
            jvmAtomicCommitter.commit(source, finalDestination)
        }

        CacheDirRecovery.retryOnceAfterRecreating(
            cacheDir,
            onRecovered = { failure -> recoveredFrom = failure },
        ) {
            AtomicFileWrite.writeAtomically(
                destination = destination,
                committer = disappearingDirectoryCommitter,
                outputStreamFactory = { tempFile ->
                    observedTempFiles.add(tempFile)
                    FileOutputStream(tempFile)
                },
            ) { outputStream ->
                writeAttempts++
                outputStream.write(byteArrayOf(1, 2, 3))
                true
            }
        }

        assertEquals(2, writeAttempts)
        assertEquals(2, commitAttempts)
        assertTrue(recoveredFrom is FileNotFoundException)
        assertEquals(2, observedTempFiles.size)
        assertNotEquals(observedTempFiles[0].name, observedTempFiles[1].name)
        assertArrayEquals(byteArrayOf(1, 2, 3), destination.readBytes())
        assertTrue(managedTempFiles().isEmpty())
    }

    @Test
    fun `concurrent publications never collide or expose mixed contents`() {
        val destination = File(cacheDir, "climb.png")
        val firstPayload = ByteArray(32 * 1024) { 0x11.toByte() }
        val secondPayload = ByteArray(32 * 1024) { 0x22.toByte() }
        val writersReady = CountDownLatch(2)
        val allowCommit = CountDownLatch(1)
        val failures = Collections.synchronizedList(mutableListOf<Throwable>())

        fun publicationThread(payload: ByteArray): Thread = Thread {
            try {
                AtomicFileWrite.writeAtomically(destination, jvmAtomicCommitter) { outputStream ->
                    outputStream.write(payload)
                    writersReady.countDown()
                    if (!allowCommit.await(5, TimeUnit.SECONDS)) {
                        throw IOException("timed out waiting to publish concurrently")
                    }
                    true
                }
            } catch (failure: Throwable) {
                failures.add(failure)
            }
        }

        val firstThread = publicationThread(firstPayload)
        val secondThread = publicationThread(secondPayload)
        firstThread.start()
        secondThread.start()
        assertTrue("both unique temps were fully written", writersReady.await(5, TimeUnit.SECONDS))
        assertEquals("two in-flight paths coexist", 2, managedTempFiles().size)
        allowCommit.countDown()
        firstThread.join(5_000)
        secondThread.join(5_000)

        assertFalse("first publisher thread timed out", firstThread.isAlive)
        assertFalse("second publisher thread timed out", secondThread.isAlive)
        assertTrue("both atomic renames succeeded: $failures", failures.isEmpty())
        val publishedBytes = destination.readBytes()
        assertTrue(
            "the winner is one complete payload, never an interleaving",
            publishedBytes.contentEquals(firstPayload) || publishedBytes.contentEquals(secondPayload),
        )
        assertTrue(managedTempFiles().isEmpty())
    }
}
