package com.boardsesh.sprayeditorinput

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SprayShortcutMatcherTest {
    // The editor's map, in the shape JS sends it (spray-editor-shortcuts.ts).
    private val keys = listOf(
        ShortcutKey("undo", "z", setOf("command")),
        ShortcutKey("redo", "z", setOf("command", "shift")),
        ShortcutKey("delete", "backspace", emptySet()),
        ShortcutKey("delete", "delete", emptySet()),
        ShortcutKey("escape", "escape", emptySet()),
        ShortcutKey("add", "a", emptySet()),
        ShortcutKey("smaller", "-", emptySet()),
        ShortcutKey("bigger", "=", emptySet()),
        ShortcutKey("previous", "[", emptySet()),
        ShortcutKey("primary", "return", setOf("command")),
    )

    private fun press(
        keyCode: Int,
        baseChar: Char? = null,
        ctrl: Boolean = false,
        meta: Boolean = false,
        shift: Boolean = false,
        alt: Boolean = false,
    ): String? = SprayShortcutMatcher.match(keys, keyCode, baseChar?.code ?: 0, ctrl, meta, shift, alt)

    @Test
    fun `ctrl or meta plays command`() {
        assertEquals("undo", press(KeyEvent.KEYCODE_Z, 'z', ctrl = true))
        assertEquals("undo", press(KeyEvent.KEYCODE_Z, 'z', meta = true))
    }

    @Test
    fun `shift tells redo from undo`() {
        assertEquals("redo", press(KeyEvent.KEYCODE_Z, 'z', ctrl = true, shift = true))
        assertNull(press(KeyEvent.KEYCODE_Z, 'z'))
    }

    @Test
    fun `named keys match by key code`() {
        assertEquals("delete", press(KeyEvent.KEYCODE_DEL))
        assertEquals("delete", press(KeyEvent.KEYCODE_FORWARD_DEL))
        assertEquals("escape", press(KeyEvent.KEYCODE_ESCAPE))
        assertEquals("primary", press(KeyEvent.KEYCODE_ENTER, ctrl = true))
        assertEquals("primary", press(KeyEvent.KEYCODE_NUMPAD_ENTER, meta = true))
        assertNull(press(KeyEvent.KEYCODE_ENTER))
    }

    @Test
    fun `characters match by their unmodified character, any case`() {
        assertEquals("add", press(KeyEvent.KEYCODE_A, 'a'))
        assertEquals("add", press(KeyEvent.KEYCODE_A, 'A'))
        assertEquals("smaller", press(KeyEvent.KEYCODE_MINUS, '-'))
        assertEquals("bigger", press(KeyEvent.KEYCODE_EQUALS, '='))
        assertEquals("previous", press(KeyEvent.KEYCODE_LEFT_BRACKET, '['))
    }

    @Test
    fun `an extra modifier is a different shortcut`() {
        assertNull(press(KeyEvent.KEYCODE_A, 'a', alt = true))
        assertNull(press(KeyEvent.KEYCODE_A, 'a', ctrl = true))
        assertNull(press(KeyEvent.KEYCODE_EQUALS, '=', shift = true))
    }

    @Test
    fun `a key outside the map is left alone`() {
        assertNull(press(KeyEvent.KEYCODE_Q, 'q'))
        assertNull(press(KeyEvent.KEYCODE_TAB))
    }
}
