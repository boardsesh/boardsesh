package com.boardsesh.climboverlaygpu

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OverlayRoleAliasesTest {
    private fun full(state: Long, identity: Long = state, annotation: Boolean = false): JSONObject =
        JSONObject("""{"state":$state,"identity":$identity,"color":[77,245,253],"annotation":$annotation,
            "fillPasses":[null,{"offset":256,"x":1,"y":2,"width":1,"height":1},null,null],"plate":null,
            "glyphPasses":[null,{"offset":260,"x":1,"y":2,"width":1,"height":1}]}""")

    private fun json(roles: JSONArray, second: JSONArray? = null, mirrored: Boolean = false): String {
        fun hold(id: Int, mirror: Int, rows: JSONArray): JSONObject =
            JSONObject("""{"id":$id,"mirror":$mirror,"x":0,"y":0,"width":8,"height":8,
                "bounds":[1,2,3,4],"field":0,"reach":12}""").put("roles", rows)
        val root = JSONObject("""{"version":2,"width":8,"height":8,"covers":null,"veil":[0,0,0,0],
            "mirrored":$mirrored,"glow":true,"merge":0,"seam":0,"seamMix":0,"seamSharpness":0,
            "fringe":0,"coreShare":0}""")
        root.put("lut", JSONArray(List(257) { 0 }))
        val holds = JSONArray().put(hold(1, 2, roles))
        if (second != null) holds.put(hold(2, 1, second))
        return root.put("holds", holds).toString()
    }

    private fun manifest(roles: JSONArray, second: JSONArray? = null, mirrored: Boolean = false): AtlasManifest =
        AtlasManifest.parse(json(roles, second, mirrored), 512)

    @Test
    fun compactAndExpandedRolesEncodeIdenticalCanonicalDescriptorsIncludingLaterPasses() {
        val compact = manifest(JSONArray().put(full(13)).put(JSONObject("""{"state":43,"alias":13}""")))
        val expanded = manifest(JSONArray().put(full(13)).put(full(43, 13)))
        val alias = selectHolds(compact, "p1r43")
        val canonical = selectHolds(compact, "p1r13")
        val legacy = selectHolds(expanded, "p1r43")
        assertEquals(43L, alias[0].role.state)
        assertEquals(13L, alias[0].role.identity)
        assertEquals(5, ActiveScene(alias, 1).stampLayers)
        fun bytes(holds: List<ActiveHold>): ByteArray = encodeHolds(holds).let { buffer -> ByteArray(buffer.remaining()).also { buffer.get(it) } }
        assertEquals(224, bytes(alias).size)
        assertArrayEquals(bytes(canonical), bytes(alias))
        assertArrayEquals(bytes(legacy), bytes(alias))
        assertEquals(256, encodeHolds(alias).getInt(144))
        assertEquals(260, encodeHolds(alias).getInt(156))
        assertEquals(ActiveScene(canonical, 1).roles, ActiveScene(alias, 2).roles)
    }

    @Test
    fun auxiliaryAliasesPreserveFlagsAndMirrorLookupWithoutGlowCoverage() {
        val rows = JSONArray().put(full(46, annotation = true)).put(JSONObject("""{"state":47,"alias":46}"""))
        val atlas = manifest(rows, rows, mirrored = true)
        val active = selectHolds(atlas, "p1r47")
        assertEquals(2L, active.single().hold.id)
        assertTrue(active.single().role.annotation)
        assertEquals(46L, active.single().role.identity)
        assertEquals(8, ActiveScene(active, 1).stampLayers)
        assertEquals(0f, ActiveScene(active, 1).maxReach, 0f)
        assertEquals(2, encodeHolds(active).getInt(80))
        assertEquals(46, encodeHolds(active).getInt(84))
        assertEquals(1, encodeHolds(active).getInt(88))
    }

    @Test
    fun fullLegacyRowsAndUInt32BoundariesRemainSupportedButNotAliasTargets() {
        assertEquals(13L, manifest(JSONArray().put(full(42, 13))).holds[1L]!!.roles[42L]!!.identity)
        val boundary = manifest(JSONArray().put(full(0xffffffffL)).put(JSONObject("""{"state":0,"alias":4294967295}""")))
        assertEquals(0xffffffffL, boundary.holds[1L]!!.roles[0L]!!.identity)
        val maximum = JSONArray().put(full(0))
        for (state in 1..31) maximum.put(JSONObject().put("state", state).put("alias", 0))
        assertEquals(32, manifest(maximum).holds[1L]!!.roles.size)
        assertThrows(RuntimeException::class.java) { manifest(maximum.put(JSONObject().put("state", 32).put("alias", 0))) }
        assertThrows(RuntimeException::class.java) { manifest(JSONArray().put(full(13)).put(full(42, 13)).put(JSONObject("""{"state":43,"alias":42}"""))) }
    }

    @Test
    fun aliasesRejectOverridesMissingForwardSelfCrossHoldAndAliasChains() {
        for (row in listOf(
            """{"state":43,"alias":13,"color":[0,0,0]}""",
            """{"state":43,"alias":13,"unknownOverride":true}""",
            """{"state":43,"alias":null}""",
            """{"state":13,"alias":13}""",
            """{"state":43,"alias":43}""",
            """{"state":43,"alias":99}""",
        )) assertThrows(RuntimeException::class.java) { manifest(JSONArray().put(full(13)).put(JSONObject(row))) }
        assertThrows(RuntimeException::class.java) { manifest(JSONArray().put(JSONObject("""{"state":43,"alias":13}""")).put(full(13))) }
        assertThrows(RuntimeException::class.java) { manifest(JSONArray().put(full(13)).put(JSONObject("""{"state":43,"alias":13}""")).put(JSONObject("""{"state":44,"alias":43}"""))) }
        assertThrows(RuntimeException::class.java) { manifest(JSONArray().put(full(13)), JSONArray().put(JSONObject("""{"state":43,"alias":13}"""))) }
    }

    @Test
    fun roleNumbersNeverCoerceFractionsStringsBooleansNullOrOverflow() {
        val fullJson = json(JSONArray().put(full(13)))
        val aliasJson = json(JSONArray().put(full(13)).put(JSONObject("""{"state":43,"alias":13}""")))
        for (number in listOf("true", "\"13\"", "null", "-1", "4294967296", "13.5", "13.0", "13e0")) {
            assertThrows("state=$number", RuntimeException::class.java) { AtlasManifest.parse(fullJson.replace("\"state\":13", "\"state\":$number"), 512) }
            assertThrows("identity=$number", RuntimeException::class.java) { AtlasManifest.parse(fullJson.replace("\"identity\":13", "\"identity\":$number"), 512) }
            assertThrows("alias=$number", RuntimeException::class.java) { AtlasManifest.parse(aliasJson.replace("\"alias\":13", "\"alias\":$number"), 512) }
        }
    }

    @Test
    fun invalidFramesLeaveTheSameLayoutAvailableForTheNextValidFrame() {
        val atlas = manifest(JSONArray().put(full(13)))
        val layout = atlas.holds
        val valid = selectHolds(atlas, "p1r13")
        for ((frames, reason) in listOf(
            "p1r999" to "frame-role-unsupported",
            "p999r13" to "frame-no-matching-holds",
            "p1r13".repeat(129) to "frame-active-limit",
            "p".repeat(32 * 1024 + 1) to "frame-too-large",
        )) {
            val failure = assertThrows(AtlasFrameFailure::class.java) { selectHolds(atlas, frames) }
            assertEquals(reason, failure.reasonCode)
            assertTrue(OverlayLifecycle.retainGeometry(failure is AtlasFrameFailure, false, true))
            assertSame(layout, atlas.holds)
            assertEquals(valid, selectHolds(atlas, "p1r13"))
        }
        assertEquals(128, selectHolds(atlas, "p1r13".repeat(128)).size)
    }
}
