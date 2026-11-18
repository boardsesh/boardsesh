package com.boardsesh.climboverlaygpu

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The base program draws every frame without the swap look, so its source stays
 * byte for byte what main shipped before the look existed (#7775): those frames
 * meet no driver code they had not met before. The look is a second program
 * ([OverlayShader.lookFragment]) that only frames with the look bind.
 *
 * To change the base program on purpose, do it in its own PR: change
 * [OverlayShader.vertex] or [OverlayShader.fragment], re-run the Aura transition
 * golden (`scripts/aura-transition-golden`) and the 42-sample look-off parity
 * (`scripts/board-motion-preview/gles.mjs --golden`), then paste the hashes this
 * test prints into [VERTEX_SHA256] and [FRAGMENT_SHA256].
 */
class OverlayShaderTest {
    private fun sha256(source: String): String =
        MessageDigest.getInstance("SHA-256").digest(source.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    @Test
    fun theBaseProgramIsMainsSourceByteForByte() {
        assertEquals("OverlayShader.vertex changed; see the class comment", VERTEX_SHA256, sha256(OverlayShader.vertex))
        assertEquals("OverlayShader.fragment changed; see the class comment", FRAGMENT_SHA256, sha256(OverlayShader.fragment))
    }

    @Test
    fun onlyTheLookProgramReadsTheLook() {
        assertFalse(OverlayShader.fragment.contains("Look"))
        assertTrue(OverlayShader.lookFragment.contains("uniform Look"))
        assertTrue(OverlayShader.lookFragment.startsWith("#version 310 es\n"))
        // The look program keeps the base program's storage and uniform contract.
        for (line in OverlayShader.fragment.lines().filter { it.trim().startsWith("layout(") }) {
            assertTrue(line, OverlayShader.lookFragment.lines().contains(line))
        }
    }

    private companion object {
        /** SHA-256 of origin/main's `OverlayShader.vertex` (1a52595646, the swap look's base). */
        const val VERTEX_SHA256 = "cfc608c382c0cc3fef0ef64d5492c83ef4e9bb02d978cb17cf9028d7ccb322df"

        /** SHA-256 of origin/main's `OverlayShader.fragment` (1a52595646), 12,121 bytes. */
        const val FRAGMENT_SHA256 = "9124c4907d5d4453da7e53634e6e45e052802e670440ff5ff12fe5747aeb320c"
    }
}
