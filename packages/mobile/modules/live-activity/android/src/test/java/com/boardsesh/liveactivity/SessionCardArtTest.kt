package com.boardsesh.liveactivity

import android.graphics.Color
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.abs
import kotlin.math.roundToInt

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class SessionCardArtTest {

    @Test
    fun `parses a payload and reads JSON nulls as absent`() {
        val payload = CardPayload.parse(
            """{"expanded":[{"x":1.5,"y":2,"r":3,"peak":0.5,"color":"#00FF00"}],"collapsed":[],
                "gradeLabel":null,"gradeColor":null,"angleLabel":"40°"}""",
        )

        assertNotNull(payload)
        assertEquals(CardBlob(1.5f, 2f, 3f, 0.5f, Color.GREEN), payload?.expanded?.single())
        assertEquals(emptyList<CardBlob>(), payload?.collapsed)
        assertNull(payload?.gradeLabel)
        assertNull(payload?.gradeColor)
        assertEquals("40°", payload?.angleLabel)
    }

    @Test
    fun `anything malformed parses to null`() {
        for (json in listOf("", "{not json", "{}", """{"expanded":[{"x":1}],"collapsed":[]}""")) {
            assertNull(json, CardPayload.parse(json))
        }
        val badColour = """{"expanded":[{"x":1,"y":2,"r":3,"peak":1,"color":"green-ish"}],"collapsed":[]}"""
        assertNull(CardPayload.parse(badColour))
    }

    @Test
    fun `the grey tone takes every hold to a true grey at its own brightness`() {
        val grey = SessionCardPainter.toneColor(Color.rgb(0x27, 0xED, 0x2A), CardTone.Grey)

        assertEquals(Color.red(grey), Color.green(grey))
        assertEquals(Color.green(grey), Color.blue(grey))
        assertTrue(Color.green(grey) > 0x80)
        assertEquals(Color.RED, SessionCardPainter.toneColor(Color.RED, CardTone.Colour))
    }

    // card-art-golden.json comes from `bokehPixel`, and a vitest case keeps it in
    // step with the TypeScript, so this ties the painter to the app's bokeh.
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `the painted glow matches the app's bokeh`() {
        val fixture = JSONObject(
            requireNotNull(javaClass.classLoader?.getResourceAsStream("card-art-golden.json")).reader().use { it.readText() },
        )
        val blobs = fixture.getJSONArray("blobs").let { array ->
            List(array.length()) { index ->
                val blob = array.getJSONObject(index)
                CardBlob(
                    x = blob.getDouble("x").toFloat(),
                    y = blob.getDouble("y").toFloat(),
                    radius = blob.getDouble("r").toFloat(),
                    peak = blob.getDouble("peak").toFloat(),
                    color = Color.parseColor(blob.getString("color")),
                )
            }
        }
        val glow = SessionCardPainter.paintGlow(
            fixture.getInt("width"), fixture.getInt("height"), 1f, blobs, CardTone.Colour,
        )

        val samples = fixture.getJSONArray("samples")
        for (index in 0 until samples.length()) {
            val sample = samples.getJSONObject(index)
            val painted = glow.getPixel(sample.getInt("x"), sample.getInt("y"))
            val expected = Color.parseColor(sample.getString("hex"))
            // `bokehPixel` includes the grain at its worst. The card draws grain as a
            // separate view, so add it here before comparing.
            fun withGrain(channel: Int) = (channel * (1 - GRAIN_ALPHA) + 255 * GRAIN_ALPHA).roundToInt()
            val where = "sample $index"
            assertTrue(where, abs(withGrain(Color.red(painted)) - Color.red(expected)) <= TOLERANCE)
            assertTrue(where, abs(withGrain(Color.green(painted)) - Color.green(expected)) <= TOLERANCE)
            assertTrue(where, abs(withGrain(Color.blue(painted)) - Color.blue(expected)) <= TOLERANCE)
        }
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `the grey tone has no hold colour at a blob's centre`() {
        val blob = CardBlob(40f, 40f, 40f, 0.9f, Color.rgb(0x27, 0xED, 0x2A))
        fun chroma(tone: CardTone): Int {
            val pixel = SessionCardPainter.paintGlow(80, 80, 1f, listOf(blob), tone).getPixel(40, 40)
            return Color.green(pixel) - Color.red(pixel)
        }

        assertTrue(chroma(CardTone.Colour) > 100)
        assertTrue(abs(chroma(CardTone.Grey)) <= 3)
    }

    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun `the panels fade into the surface at their edges`() {
        val blob = CardBlob(173f, 70f, 400f, 0.9f, Color.GREEN)
        val art = SessionCardPainter.compose(
            CardPayload(listOf(blob), listOf(blob), gradeLabel = null, gradeColor = null, angleLabel = null),
        )
        val panel = art.forTone(CardTone.Colour).expanded
        val surface = SessionCardPainter.surfaceFor(CardTone.Colour)

        for ((x, y) in listOf(0 to panel.height / 2, panel.width - 1 to panel.height / 2, panel.width / 2 to 0, panel.width / 2 to panel.height - 1)) {
            val pixel = panel.getPixel(x, y)
            assertTrue("$x,$y", abs(Color.green(pixel) - Color.green(surface)) <= 12)
        }
        assertTrue(Color.green(panel.getPixel(panel.width / 2, panel.height / 2)) > Color.green(surface) + 12)
    }

    private companion object {
        const val GRAIN_ALPHA = 0.06
        const val TOLERANCE = 3
    }
}
