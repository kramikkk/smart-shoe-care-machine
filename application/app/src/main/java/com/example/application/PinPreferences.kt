package com.example.application

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Stores the admin PIN in [EncryptedSharedPreferences]. Migrates a legacy plaintext PIN
 * from [KioskPrefs.FILE_NAME] once so existing installs keep their PIN.
 */
object PinPreferences {

    const val PREF_PIN_KEY = "kiosk_pin"

    private const val ENC_FILE = "kiosk_pin_encrypted"

    fun pinPrefs(context: Context): SharedPreferences {
        val app = context.applicationContext
        val legacy = app.getSharedPreferences(KioskPrefs.FILE_NAME, Context.MODE_PRIVATE)
        val enc = createEncryptedWithRecovery(app)
        migratePlainPinIfNeeded(legacy, enc)
        return enc
    }

    private fun migratePlainPinIfNeeded(legacy: SharedPreferences, enc: SharedPreferences) {
        if (!legacy.contains(PREF_PIN_KEY)) return
        if (enc.contains(PREF_PIN_KEY)) {
            legacy.edit { remove(PREF_PIN_KEY) }
            return
        }
        val value = legacy.getString(PREF_PIN_KEY, null) ?: return
        enc.edit(commit = true) { putString(PREF_PIN_KEY, value) }
        legacy.edit { remove(PREF_PIN_KEY) }
    }

    private fun createEncryptedWithRecovery(context: Context): SharedPreferences {
        var lastError: Throwable? = null
        repeat(2) { attempt ->
            try {
                return createEncrypted(context)
            } catch (t: Throwable) {
                lastError = t
                if (attempt == 0) {
                    context.deleteSharedPreferences(ENC_FILE)
                }
            }
        }
        throw IllegalStateException("Unable to open encrypted PIN storage", lastError)
    }

    private fun createEncrypted(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            ENC_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
}
