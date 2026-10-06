package com.boardsesh.sprayeditorinput

import android.content.Context
import android.os.Build
import android.view.KeyEvent
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * An invisible view laid over the hold editor that holds key focus while it is
 * attached and answers the shortcuts it was given.
 *
 * Android delivers a key to the focused view and its ancestors, so this view
 * makes itself focusable (in touch mode too, since a touch screen never leaves
 * it) and takes focus on attach, when its window regains focus (after a dialog,
 * say), and when its shortcut list arrives. It never takes focus from a text
 * field. A key that is not one of the editor's shortcuts goes on as normal.
 *
 * JS renders it with `pointerEvents="none"`, so touches pass through to the
 * editor, and hides it from accessibility services.
 */
class SprayEditorKeyScopeView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
    private val onShortcut by EventDispatcher()

    private var shortcutKeys: List<ShortcutKey> = emptyList()

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        // A focused view gets a highlight drawn over it once a hardware key is
        // pressed. This one covers the whole editor, so that would tint the wall.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            defaultFocusHighlightEnabled = false
        }
    }

    fun setCommands(commands: List<SprayShortcutCommand>) {
        shortcutKeys = commands.map { ShortcutKey(it.id, it.input, it.modifiers.toSet()) }
        claimKeyFocus()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        post { claimKeyFocus() }
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (hasWindowFocus) post { claimKeyFocus() }
    }

    private fun claimKeyFocus() {
        if (!isAttachedToWindow || shortcutKeys.isEmpty() || isFocused) return
        // Someone typing keeps the keyboard.
        if (rootView?.findFocus() is EditText) return
        requestFocus()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val id = SprayShortcutMatcher.match(
            keys = shortcutKeys,
            keyCode = event.keyCode,
            baseChar = event.getUnicodeChar(0),
            ctrlDown = event.isCtrlPressed,
            metaDown = event.isMetaPressed,
            shiftDown = event.isShiftPressed,
            altDown = event.isAltPressed,
        ) ?: return super.dispatchKeyEvent(event)
        // Fires on the press, once: a held key does not repeat an undo. The
        // release is consumed too, so nothing else sees half a shortcut.
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            onShortcut(mapOf("id" to id))
        }
        return true
    }
}
