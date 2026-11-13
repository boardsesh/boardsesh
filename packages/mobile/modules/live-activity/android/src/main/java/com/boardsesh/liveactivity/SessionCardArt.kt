package com.boardsesh.liveactivity

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.Shader
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/** Which art one post can carry and still fit the Binder budget. */
internal data class ArtPlan(val thumbnail: Boolean, val cardArt: Boolean)

/** Full colour while this phone drives the wall, grey otherwise. */
internal enum class CardTone { Colour, Grey }

internal data class CardBlob(val x: Float, val y: Float, val radius: Float, val peak: Float, val color: Int)

/** What only JS knows about the card: built by `buildAndroidCardPayload`. */
internal data class CardPayload(
    val expanded: List<CardBlob>,
    val collapsed: List<CardBlob>,
    val gradeLabel: String?,
    val gradeColor: Int?,
    val angleLabel: String?,
) {
    companion object {
        /** Null for anything malformed, which keeps the classic card. */
        fun parse(json: String): CardPayload? = try {
            val root = JSONObject(json)
            CardPayload(
                expanded = blobs(root.getJSONArray("expanded")),
                collapsed = blobs(root.getJSONArray("collapsed")),
                gradeLabel = root.nullableString("gradeLabel"),
                gradeColor = root.nullableString("gradeColor")?.let(Color::parseColor),
                angleLabel = root.nullableString("angleLabel"),
            )
        } catch (_: Exception) {
            null
        }

        private fun blobs(array: JSONArray): List<CardBlob> = List(array.length()) { index ->
            val blob = array.getJSONObject(index)
            CardBlob(
                x = blob.getDouble("x").toFloat(),
                y = blob.getDouble("y").toFloat(),
                radius = blob.getDouble("r").toFloat(),
                peak = blob.getDouble("peak").toFloat(),
                color = Color.parseColor(blob.getString("color")),
            )
        }

        private fun JSONObject.nullableString(name: String): String? =
            if (isNull(name)) null else getString(name)
    }
}

internal data class CardPanels(val expanded: Bitmap, val collapsed: Bitmap) {
    val byteCount: Int get() = expanded.byteCount + collapsed.byteCount
}

/** Both tones, painted together: a timed drive's end re-posts without composing. */
internal class CardArt(private val colour: CardPanels, private val grey: CardPanels) {
    fun forTone(tone: CardTone): CardPanels = if (tone == CardTone.Colour) colour else grey
    val byteCount: Int get() = colour.byteCount + grey.byteCount
}

/** Paints the frosted bokeh that RemoteViews can't draw, as `FrostedBokeh.tsx` does in the app. */
internal object SessionCardPainter {
    // JS lays blobs out on these panels, in dp (ANDROID_CARD_* in android-card-payload.ts).
    private const val PANEL_WIDTH = 347f
    private const val EXPANDED_HEIGHT = 140f
    private const val COLLAPSED_HEIGHT = 48f

    // Blurred content tolerates a small bitmap, and each one is parcelled per post.
    private const val BITMAP_WIDTH = 200

    private const val FROST_ALPHA = 0.08f
    private const val TEXT_SCRIM = 0.80f
    private const val CONTROL_SCRIM = 0.60f

    // BOKEH_FALLOFF in @boardsesh/frosted-bokeh.
    private val FALLOFF_POSITIONS = floatArrayOf(0f, 0.3f, 0.55f, 0.8f, 1f)
    private val FALLOFF_SHARES = floatArrayOf(1f, 0.8f, 0.4f, 0.12f, 0f)

    private const val GREY_BLOB_ALPHA = 0.80f
    private const val EDGE_FEATHER_DP = 14f
    val COLOUR_SURFACE: Int = Color.rgb(0x0E, 0x0D, 0x12)
    val GREY_SURFACE: Int = Color.rgb(0x10, 0x10, 0x12)

    fun surfaceFor(tone: CardTone): Int = if (tone == CardTone.Colour) COLOUR_SURFACE else GREY_SURFACE

    /**
     * What the card's feathered edge ends up as: the surface under the grain view
     * (alpha 0.06, mean grey 127). The notification is colorized to this, because
     * anything else shows the content slot as a box inside the card.
     */
    fun edgeColorFor(tone: CardTone): Int =
        if (tone == CardTone.Colour) Color.rgb(0x15, 0x14, 0x19) else Color.rgb(0x17, 0x17, 0x19)

    /** Not driving: every hold goes to its own luma, so the state reads at a glance. */
    fun toneColor(color: Int, tone: CardTone): Int {
        if (tone == CardTone.Colour) return color
        val red = Color.red(color).toFloat()
        val green = Color.green(color).toFloat()
        val blue = Color.blue(color).toFloat()
        val luma = 0.213f * red + 0.715f * green + 0.072f * blue
        val grey = luma.roundToInt().coerceIn(0, 255)
        return Color.rgb(grey, grey, grey)
    }

    fun compose(payload: CardPayload): CardArt = CardArt(panels(payload, CardTone.Colour), panels(payload, CardTone.Grey))

    private fun panels(payload: CardPayload, tone: CardTone): CardPanels {
        val scale = BITMAP_WIDTH / PANEL_WIDTH
        val expanded = paintGlow(
            BITMAP_WIDTH, (EXPANDED_HEIGHT * scale).roundToInt(), scale, payload.expanded, tone,
        )
        scrim(expanded, tone, expandedScrim(expanded.height))
        featherEdges(expanded, tone, EDGE_FEATHER_DP * scale)
        val collapsed = paintGlow(
            BITMAP_WIDTH, (COLLAPSED_HEIGHT * scale).roundToInt(), scale, payload.collapsed, tone,
        )
        scrim(collapsed, tone, collapsedScrim(collapsed.width))
        featherEdges(collapsed, tone, EDGE_FEATHER_DP * scale)
        return CardPanels(expanded, collapsed)
    }

    /** The base, the blobs and the frost, as `bokehPixel` computes them. */
    fun paintGlow(width: Int, height: Int, scale: Float, blobs: List<CardBlob>, tone: CardTone): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(surfaceFor(tone))
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.SCREEN) }
        val blobAlpha = if (tone == CardTone.Colour) 1f else GREY_BLOB_ALPHA
        for (blob in blobs) {
            if (blob.radius <= 0f) continue
            val color = toneColor(blob.color, tone)
            val stops = IntArray(FALLOFF_SHARES.size) { index ->
                val alpha = (blob.peak * blobAlpha * FALLOFF_SHARES[index] * 255f).roundToInt().coerceIn(0, 255)
                Color.argb(alpha, Color.red(color), Color.green(color), Color.blue(color))
            }
            paint.shader = RadialGradient(
                blob.x * scale, blob.y * scale, blob.radius * scale, stops, FALLOFF_POSITIONS, Shader.TileMode.CLAMP,
            )
            canvas.drawCircle(blob.x * scale, blob.y * scale, blob.radius * scale, paint)
        }
        canvas.drawColor(Color.argb((FROST_ALPHA * 255f).roundToInt(), 255, 255, 255))
        return bitmap
    }

    private fun expandedScrim(height: Int): (Int) -> Shader = { surface ->
        LinearGradient(
            0f, 0f, 0f, height.toFloat(),
            intArrayOf(withAlpha(surface, TEXT_SCRIM), withAlpha(surface, TEXT_SCRIM), withAlpha(surface, CONTROL_SCRIM), withAlpha(surface, CONTROL_SCRIM)),
            floatArrayOf(0f, 76f / EXPANDED_HEIGHT, 92f / EXPANDED_HEIGHT, 1f),
            Shader.TileMode.CLAMP,
        )
    }

    private fun collapsedScrim(width: Int): (Int) -> Shader = { surface ->
        LinearGradient(
            0f, 0f, width.toFloat(), 0f,
            intArrayOf(withAlpha(surface, TEXT_SCRIM), withAlpha(surface, TEXT_SCRIM), withAlpha(surface, CONTROL_SCRIM), withAlpha(surface, CONTROL_SCRIM)),
            floatArrayOf(0f, (PANEL_WIDTH - 104f) / PANEL_WIDTH, (PANEL_WIDTH - 88f) / PANEL_WIDTH, 1f),
            Shader.TileMode.CLAMP,
        )
    }

    private fun scrim(bitmap: Bitmap, tone: CardTone, gradient: (Int) -> Shader) {
        val paint = Paint().apply { shader = gradient(surfaceFor(tone)) }
        Canvas(bitmap).drawRect(0f, 0f, bitmap.width.toFloat(), bitmap.height.toFloat(), paint)
    }

    // The bitmap can't reach the notification's edge, so it fades into the surface
    // instead of ending in a visible rectangle.
    private fun featherEdges(bitmap: Bitmap, tone: CardTone, feather: Float) {
        val canvas = Canvas(bitmap)
        val width = bitmap.width.toFloat()
        val height = bitmap.height.toFloat()
        val solid = surfaceFor(tone)
        val clear = withAlpha(solid, 0f)
        fun fade(x0: Float, y0: Float, x1: Float, y1: Float, left: Float, top: Float, right: Float, bottom: Float) {
            val paint = Paint().apply { shader = LinearGradient(x0, y0, x1, y1, solid, clear, Shader.TileMode.CLAMP) }
            canvas.drawRect(left, top, right, bottom, paint)
        }
        fade(0f, 0f, feather, 0f, 0f, 0f, feather, height)
        fade(width, 0f, width - feather, 0f, width - feather, 0f, width, height)
        fade(0f, 0f, 0f, feather, 0f, 0f, width, feather)
        fade(0f, height, 0f, height - feather, 0f, height - feather, width, height)
    }

    private fun withAlpha(color: Int, alpha: Float): Int =
        Color.argb((alpha * 255f).roundToInt(), Color.red(color), Color.green(color), Color.blue(color))
}
