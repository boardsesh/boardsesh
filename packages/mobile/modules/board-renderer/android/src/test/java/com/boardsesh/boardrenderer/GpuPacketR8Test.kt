package com.boardsesh.boardrenderer

import androidx.annotation.Keep
import java.io.File
import java.net.URLClassLoader
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.Properties
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.jar.JarEntry
import java.util.jar.JarOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class GpuPacketR8Test {
    @Test
    fun minifiedResultCanBeConstructedByJniAndConsumedWithoutLosingValues() {
        val directory = File(requiredProperty("boardsesh.packet.r8.reports"), UUID.randomUUID().toString())
        check(directory.mkdirs())
        val r8Jar = File(requiredProperty("boardsesh.packet.r8.jar"))
        val androidJar = File(requiredProperty("boardsesh.packet.android.jar"))
        check(r8Jar.isFile && androidJar.isFile)
        val kotlinLibrary = codeLocation(kotlin.Unit::class.java)
        val annotationLibrary = codeLocation(Keep::class.java)
        val resultLocation = codeLocation(GpuPacketResult::class.java)
        val fixtureClasses = File(directory, "fixture-classes").apply { check(mkdirs()) }
        val fixtureSource = File(directory, "NativeBoundary.java").apply {
            writeText(
                """
                package packetfixture;
                import com.boardsesh.boardrenderer.GpuPacketResult;
                public final class NativeBoundary {
                    public static native GpuPacketResult nativeResult();
                    public static int consume(GpuPacketResult result) {
                        return result.getStatus() + (int)result.getHandle() + result.getBuffers().length;
                    }
                }
                """.trimIndent(),
            )
        }
        val compilerLog = File(directory, "javac.log")
        val compiler = ProcessBuilder(
            File(System.getProperty("java.home"), "bin/javac").absolutePath,
            "--release", "17", "-classpath",
            listOf(resultLocation, kotlinLibrary, annotationLibrary).joinToString(File.pathSeparator),
            "-d", fixtureClasses.absolutePath, fixtureSource.absolutePath,
        ).directory(directory).redirectOutput(compilerLog).redirectErrorStream(true).start()
        if (!compiler.waitFor(45, TimeUnit.SECONDS)) {
            compiler.destroyForcibly()
            check(compiler.waitFor(5, TimeUnit.SECONDS)) { "Owned javac process did not exit" }
            error("Owned javac process timed out: $directory")
        }
        assertEquals("Native descriptor fixture must compile: ${compilerLog.readText()}", 0, compiler.exitValue())

        val resultPath = "com/boardsesh/boardrenderer/GpuPacketResult.class"
        val resultBytes = checkNotNull(GpuPacketResult::class.java.getResourceAsStream("/$resultPath")).use { it.readBytes() }
        val program = File(directory, "program.jar")
        JarOutputStream(program.outputStream()).use { jar ->
            jar.putNextEntry(JarEntry(resultPath))
            jar.write(resultBytes)
            jar.closeEntry()
            jar.putNextEntry(JarEntry("packetfixture/NativeBoundary.class"))
            jar.write(File(fixtureClasses, "packetfixture/NativeBoundary.class").readBytes())
            jar.closeEntry()
        }
        val consumerRules = checkNotNull(checkNotNull(Keep::class.java.classLoader).getResourceAsStream("META-INF/proguard/androidx-annotations.pro")) {
            "The actual AndroidX annotation consumer rules are required"
        }.bufferedReader().use { it.readText() }
        val rules = File(directory, "rules.pro").apply {
            writeText(
                consumerRules + "\n" +
                    """
                    -keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }
                    -keep,allowoptimization class packetfixture.NativeBoundary { public static int consume(...); }
                    -dontwarn org.jetbrains.annotations.**
                    """.trimIndent(),
            )
        }
        val minified = File(directory, "minified.jar")
        val stdout = File(directory, "r8.stdout")
        val stderr = File(directory, "r8.stderr")
        val process = ProcessBuilder(
            File(System.getProperty("java.home"), "bin/java").absolutePath,
            "-Xmx512m", "-cp", r8Jar.absolutePath, "com.android.tools.r8.R8",
            "--classfile", "--release", "--output", minified.absolutePath,
            "--lib", androidJar.absolutePath, "--lib", kotlinLibrary.absolutePath,
            "--lib", annotationLibrary.absolutePath, "--pg-conf", rules.absolutePath,
            "--pg-map-output", File(directory, "mapping.txt").absolutePath, program.absolutePath,
        ).directory(directory).redirectOutput(stdout).redirectError(stderr).start()
        if (!process.waitFor(90, TimeUnit.SECONDS)) {
            process.destroyForcibly()
            check(process.waitFor(5, TimeUnit.SECONDS)) { "Owned R8 process did not exit" }
            error("Owned R8 process timed out: $directory")
        }
        assertEquals("R8 must succeed: ${stderr.readText().takeLast(4000)}", 0, process.exitValue())

        // The reflection driver is deliberately NOT an R8 input: JNI lookups are
        // invisible to the optimizer. A parent classloader must not supply the
        // original, unminified DTO and accidentally make this test pass.
        URLClassLoader(arrayOf(minified.toURI().toURL(), kotlinLibrary.toURI().toURL()), null).use { loader ->
            val resultType = Class.forName("com.boardsesh.boardrenderer.GpuPacketResult", true, loader)
            val constructor = resultType.getConstructor(Int::class.javaPrimitiveType, Long::class.javaPrimitiveType, Array<ByteBuffer>::class.java)
            assertTrue(resultType.declaredFields.map { it.name }.containsAll(listOf("status", "handle", "buffers")))
            val consume = Class.forName("packetfixture.NativeBoundary", true, loader).getMethod("consume", resultType)
            for ((status, handle) in listOf(0 to 0L, -5 to 37L)) {
                val buffers = arrayOf(ByteBuffer.allocateDirect(0), ByteBuffer.wrap(byteArrayOf(1, 2, 3)), ByteBuffer.allocateDirect(8))
                val result = constructor.newInstance(status, handle, buffers as Any)
                assertEquals(status, resultType.getMethod("getStatus").invoke(result))
                assertEquals(handle, resultType.getMethod("getHandle").invoke(result))
                assertSame(buffers, resultType.getMethod("getBuffers").invoke(result))
                assertEquals(status + handle.toInt() + buffers.size, consume.invoke(null, result))
            }
        }
        Properties().apply {
            setProperty("status", "PASS_ACTUAL_R8_JNI_CONSTRUCTOR_FIELDS_AND_CONSUMER")
            setProperty("resultClassSha256", digest(resultBytes))
            setProperty("r8JarSha256", digest(r8Jar.readBytes()))
            setProperty("consumerRulesSha256", digest(consumerRules.toByteArray()))
            setProperty("minifiedJarSha256", digest(minified.readBytes()))
            File(directory, "result.properties").outputStream().use { store(it, "Actual production class; external reflection driver") }
        }
    }

    private fun requiredProperty(name: String): String = checkNotNull(System.getProperty(name)) { "$name is required" }
    private fun codeLocation(type: Class<*>): File = File(checkNotNull(checkNotNull(type.protectionDomain).codeSource).location.toURI())
    private fun digest(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
