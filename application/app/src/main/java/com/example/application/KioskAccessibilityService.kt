package com.example.application

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent

class KioskAccessibilityService : AccessibilityService() {

    private val prefs by lazy {
        getSharedPreferences(KioskPrefs.FILE_NAME, Context.MODE_PRIVATE)
    }

    /** Last time we sent BACK to dismiss the shade (avoid event storms). */
    private var lastShadeDismissUptimeMs = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return

        val isKioskActive = prefs.getBoolean(KioskPrefs.KEY_KIOSK_ACTIVE, true)
        if (!isKioskActive) return

        // Don't act while the screen is off (lock screen handles that)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) return

        val foreground = event.packageName?.toString() ?: return

        // Prefer class names: some builds leave packageName as the foreground app while the shade is up.
        if (isNotificationShadeOrStatusUi(foreground, event)) {
            dismissNotificationShade()
            return
        }

        if (foreground == packageName) return

        when {
            // Allowed system packages (Device Admin dialog, etc.) — let them show
            foreground in ALLOWED_SYSTEM_PACKAGES -> return

            // Any other app came to foreground — return to kiosk instantly
            else -> bringKioskToFront()
        }
    }

    override fun onInterrupt() { }

    /**
     * Third-party apps cannot obtain [android.app.StatusBarManager] (service is null), so reflection
     * on collapsePanels never worked. GLOBAL_ACTION_BACK is the supported way for an
     * AccessibilityService to close the notification shade / status bar expansion.
     */
    private fun dismissNotificationShade() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastShadeDismissUptimeMs < SHADE_DISMISS_DEBOUNCE_MS) return
        lastShadeDismissUptimeMs = now
        performGlobalAction(GLOBAL_ACTION_BACK)
    }

    private fun isNotificationShadeOrStatusUi(foreground: String, event: AccessibilityEvent): Boolean {
        val className = event.className?.toString().orEmpty()
        if (className.contains("StatusBar", ignoreCase = true) ||
            className.contains("NotificationShade", ignoreCase = true) ||
            className.contains("ExpandedNotification", ignoreCase = true)
        ) {
            return true
        }
        if (foreground == "com.android.systemui") return true
        if (foreground in SYSTEM_UI_PACKAGES) return true
        return false
    }

    private fun bringKioskToFront() {
        val intent = Intent(this, MainActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
        }
        startActivity(intent)
    }

    companion object {
        private const val SHADE_DISMISS_DEBOUNCE_MS = 350L

        private val ALLOWED_SYSTEM_PACKAGES = setOf(
            "android",
            "com.android.settings",
            "com.google.android.packageinstaller"
        )

        /** OEM / variant packages that host the status bar or shade (non-exhaustive). */
        private val SYSTEM_UI_PACKAGES = setOf(
            "com.google.android.systemui"
        )
    }
}
