package com.boardsesh.liveactivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PackagedAssetUriTest {
    @Test
    fun `extracts packaged board art path for notification decoder`() {
        val assetPath = "boardsesh-board-art/static/v1/${"a".repeat(64)}.webp"
        assertEquals(assetPath, packagedAssetPath("$ANDROID_ASSET_URI_PREFIX$assetPath"))
    }

    @Test
    fun `does not treat ordinary files or traversal as packaged assets`() {
        assertNull(packagedAssetPath("file:///data/user/0/overlay.png"))
        assertNull(packagedAssetPath("${ANDROID_ASSET_URI_PREFIX}boardsesh-board-art/../secret"))
        assertNull(
            packagedAssetPath(
                "${ANDROID_ASSET_URI_PREFIX}boardsesh-board-art/static/v1/%2e%2e%2fsecret.webp",
            ),
        )
        assertNull(
            packagedAssetPath(
                "${ANDROID_ASSET_URI_PREFIX}boardsesh-board-art/static/v1/${"a".repeat(64)}.png",
            ),
        )
    }
}
