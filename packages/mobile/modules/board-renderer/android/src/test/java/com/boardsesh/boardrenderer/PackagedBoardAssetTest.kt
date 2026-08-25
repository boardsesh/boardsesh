package com.boardsesh.boardrenderer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PackagedBoardAssetTest {
    @Test
    fun `content addressed object key becomes expo-image android asset URI`() {
        val objectKey = "static/v1/${"a".repeat(64)}.webp"
        val assetPath = PackagedBoardAsset.assetPath(objectKey)
        assertEquals("boardsesh-board-art/$objectKey", assetPath)
        assertEquals("file:///android_asset/boardsesh-board-art/$objectKey", PackagedBoardAsset.uri(assetPath!!))
    }

    @Test
    fun `rejects traversal and non content addressed keys`() {
        assertNull(PackagedBoardAsset.assetPath("../secret.webp"))
        assertNull(PackagedBoardAsset.assetPath("static/v1/not-a-hash.webp"))
    }
}
