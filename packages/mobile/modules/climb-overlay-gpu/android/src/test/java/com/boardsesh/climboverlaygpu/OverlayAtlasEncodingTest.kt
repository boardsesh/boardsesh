package com.boardsesh.climboverlaygpu

import org.junit.Assert.*
import org.junit.Test

class OverlayAtlasEncodingTest {
    @Test
    fun immutableSceneMasksKeepLaterPassesAndAnnotationLayersThroughMirroringAndEndpoints() {
        fun stamp(offset: Int) = AtlasStamp(offset, intArrayOf(1, 2, 3, 4))
        fun role(stamps: List<AtlasStamp?>, extra: List<AtlasStamp?>, annotation: Boolean = false) =
            AtlasRole(42, floatArrayOf(0f, 255f, 0f), stamps, extra, annotation)
        fun active(role: AtlasRole, id: Long = 123, mirror: Long? = null) =
            ActiveHold(AtlasHold(id, mirror, floatArrayOf(1f, 2f, 3f, 4f), intArrayOf(0, 0, 20, 30), 4, 12f, mapOf(42L to role)), role)
        val missing = listOf<AtlasStamp?>(null, null, null)
        val extraMissing = listOf<AtlasStamp?>(null, null, null, null)
        val empty = ActiveScene(emptyList(), 1)
        assertEquals(0, empty.stampLayers)
        for (pass in 0..3) {
            val first = missing.toMutableList()
            val extra = extraMissing.toMutableList()
            if (pass == 0) first[0] = stamp(0) else extra[pass - 1] = stamp(0)
            assertEquals(1, ActiveScene(listOf(active(role(first, extra))), 1).stampLayers)
            assertEquals(0, ActiveScene(listOf(active(role(first, extra, true))), 1).stampLayers)
        }
        for (pass in 0..1) {
            val first = missing.toMutableList()
            val extra = extraMissing.toMutableList()
            if (pass == 0) first[2] = stamp(0) else extra[3] = stamp(0)
            assertEquals(4, ActiveScene(listOf(active(role(first, extra))), 1).stampLayers)
            assertEquals(8, ActiveScene(listOf(active(role(first, extra, true))), 1).stampLayers)
        }
        val plate = role(listOf(null, stamp(0), null), extraMissing)
        val annotation = role(missing, listOf(null, null, null, stamp(12)), true)
        val lower = ActiveScene(listOf(active(plate)), 1)
        val upper = ActiveScene(listOf(active(annotation)), 1)
        assertEquals(2, lower.stampLayers)
        assertEquals(8, upper.stampLayers)
        assertEquals(10, ActiveScene(listOf(active(plate), active(annotation)), 1).stampLayers)
        assertEquals(lower.stampLayers, ActiveScene(listOf(active(plate, 456, 123)), 1).stampLayers)
        assertEquals(2, OverlayPolicy.selectStampLayers(lower.stampLayers, upper.stampLayers, 0f))
        assertEquals(8, OverlayPolicy.selectStampLayers(lower.stampLayers, upper.stampLayers, 1f))
        assertEquals(10, OverlayPolicy.selectStampLayers(lower.stampLayers, upper.stampLayers, .5f))
        assertEquals(0, OverlayPolicy.selectStampLayers(empty.stampLayers, upper.stampLayers, 0f))
        assertEquals(8, OverlayPolicy.selectStampLayers(empty.stampLayers, upper.stampLayers, .5f))
        assertEquals(2, OverlayPolicy.selectStampLayers(lower.stampLayers, empty.stampLayers, .5f))
        assertEquals(0, OverlayPolicy.selectStampLayers(lower.stampLayers, empty.stampLayers, 1f))
    }

    @Test
    fun malformedOffsetsCannotWrapIntoAnAdmittedNativeSlice() {
        assertEquals(4, checkedAtlasOffset(4, 12, 16))
        assertThrows(IllegalArgumentException::class.java) { checkedAtlasOffset(Long.MAX_VALUE - 3, 16, 16) }
        assertThrows(IllegalArgumentException::class.java) { checkedAtlasOffset(4, Long.MAX_VALUE, 16) }
        assertThrows(IllegalArgumentException::class.java) { checkedAtlasOffset(4, 13, 16) }
        assertThrows(IllegalArgumentException::class.java) { checkedAtlasOffset(-4, 4, 16) }
        assertThrows(IllegalArgumentException::class.java) { checkedAtlasOffset(3, 4, 16) }
    }

    @Test
    fun nativeDescriptorsMatchFourteenVectorShaderLayoutAndAbsoluteStampCrops() {
        val stamp = AtlasStamp(44, intArrayOf(7, 11, 2, 3))
        val stroke = AtlasStamp(100, intArrayOf(2, 4, 2, 2))
        val role = AtlasRole(46, floatArrayOf(255f, 128f, 0f), listOf(null, null, stamp), listOf(null, null, null, stroke), true)
        val hold = AtlasHold(123, null, floatArrayOf(1f, 2f, 3f, 4f), intArrayOf(0, 0, 20, 30), 4, 12f, mapOf(46L to role))
        val encoded = encodeHolds(listOf(ActiveHold(hold, role)))
        assertEquals(224, encoded.remaining())
        assertEquals(4, encoded.getInt(48))
        assertEquals(-1, encoded.getInt(52))
        assertEquals(-1, encoded.getInt(56))
        assertEquals(44, encoded.getInt(60))
        assertEquals(123, encoded.getInt(80))
        assertEquals(46, encoded.getInt(84))
        assertEquals(1, encoded.getInt(88))
        assertEquals(7, encoded.getInt(128))
        assertEquals(11, encoded.getInt(132))
        assertEquals(2, encoded.getInt(136))
        assertEquals(3, encoded.getInt(140))
        assertEquals(-1, encoded.getInt(144))
        assertEquals(-1, encoded.getInt(148))
        assertEquals(-1, encoded.getInt(152))
        assertEquals(100, encoded.getInt(156))
        assertEquals(2, encoded.getInt(208))
        assertEquals(4, encoded.getInt(212))
        assertEquals(2, encoded.getInt(216))
        assertEquals(2, encoded.getInt(220))
        assertEquals(0f, ActiveScene(listOf(ActiveHold(hold, role)), 1).maxReach, 0f)
    }

    @Test
    fun emptySceneStillBindsOneZeroDescriptor() {
        val encoded = encodeHolds(emptyList())
        assertEquals(224, encoded.remaining())
        while (encoded.hasRemaining()) assertEquals(0, encoded.get().toInt())
    }

    @Test
    fun fillAndGlyphSubpassesKeepTheirOwnOffsetsAndCrops() {
        fun stamp(offset: Int) = AtlasStamp(offset, intArrayOf(offset, 2, 3, 4))
        val role = AtlasRole(42, floatArrayOf(0f, 255f, 0f),
            listOf(stamp(16), null, stamp(80)),
            listOf(stamp(32), stamp(48), stamp(64), stamp(96)), false)
        val hold = AtlasHold(123, null, floatArrayOf(1f, 2f, 3f, 4f), intArrayOf(0, 0, 20, 30), 4, 12f, mapOf(42L to role))
        val encoded = encodeHolds(listOf(ActiveHold(hold, role)))
        assertEquals(16, encoded.getInt(52))
        assertEquals(80, encoded.getInt(60))
        assertEquals(32, encoded.getInt(144))
        assertEquals(48, encoded.getInt(148))
        assertEquals(64, encoded.getInt(152))
        assertEquals(96, encoded.getInt(156))
        assertEquals(32, encoded.getInt(160))
        assertEquals(48, encoded.getInt(176))
        assertEquals(64, encoded.getInt(192))
        assertEquals(96, encoded.getInt(208))
    }

    @Test
    fun semanticAliasesShareMotionIdentityWithoutDiscardingLookupCodes() {
        val first = AtlasRole(13, floatArrayOf(77f, 245f, 253f), listOf(null, null, null),
            listOf(null, null, null, null), false, identity = 13)
        val alias = first.copy(state = 43)
        val changed = first.copy(state = 14, identity = 14)
        val hold = AtlasHold(123, null, floatArrayOf(1f, 2f, 3f, 4f), intArrayOf(0, 0, 20, 30), 4, 12f,
            mapOf(13L to first, 43L to alias, 14L to changed))
        val baseline = ActiveScene(listOf(ActiveHold(hold, first)), 1)
        val aliases = ActiveScene(listOf(ActiveHold(hold, alias)), 2)
        assertEquals(43L, alias.state)
        assertEquals(baseline.roles, aliases.roles)
        assertEquals(13, encodeHolds(aliases.descriptors).getInt(84))
        assertNotEquals(baseline.roles, ActiveScene(listOf(ActiveHold(hold, changed)), 3).roles)
    }
}
