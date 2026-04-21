package com.example.application

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = context.getSharedPreferences(KioskPrefs.FILE_NAME, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KioskPrefs.KEY_LAUNCH_ON_BOOT, true)) return
        context.startActivity(
            Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        )
    }
}
