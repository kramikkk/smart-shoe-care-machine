package com.example.application

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.view.accessibility.AccessibilityEvent

class KioskAccessibilityService : AccessibilityService() {

    private val prefs by lazy {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return

        val isKioskActive = prefs.getBoolean(PREF_KIOSK_ACTIVE, true)
        if (!isKioskActive) return

        val foreground = event.packageName?.toString() ?: return

        // Our own app — nothing to do
        if (foreground == packageName) return

        // Don't act while the screen is off (lock screen handles that)
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) return

        when {
            // Status bar / notification shade opened — collapse it immediately
            foreground == "com.android.systemui" -> collapseStatusBar()

            // Allowed system packages (Device Admin dialog, etc.) — let them show
            foreground in ALLOWED_SYSTEM_PACKAGES -> return

            // Any other app came to foreground — return to kiosk instantly
            else -> bringKioskToFront()
        }
    }

    override fun onInterrupt() { }

    @SuppressLint("WrongConstant")
    private fun collapseStatusBar() {
        try {
            val statusBarService = getSystemService("statusbar")
            val statusBarManager = Class.forName("android.app.StatusBarManager")
            statusBarManager.getMethod("collapsePanels").invoke(statusBarService)
        } catch (_: Exception) { }
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
        private const val PREFS_NAME = "kiosk_prefs"
        private const val PREF_KIOSK_ACTIVE = "kiosk_mode_active"

        private val ALLOWED_SYSTEM_PACKAGES = setOf(
            "android",
            "com.android.settings",
            "com.google.android.packageinstaller"
        )
    }
}
