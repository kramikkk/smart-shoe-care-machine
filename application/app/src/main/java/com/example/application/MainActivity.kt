package com.example.application

import android.app.AlertDialog
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.drawerlayout.widget.DrawerLayout

class MainActivity : AppCompatActivity() {

    private lateinit var kioskWebView: KioskWebView
    private lateinit var drawerLayout: DrawerLayout
    private lateinit var powerManager: PowerManager
    private lateinit var devicePolicyManager: DevicePolicyManager
    private lateinit var adminComponent: ComponentName
    private lateinit var backCallback: OnBackPressedCallback
    private var wakeLock: PowerManager.WakeLock? = null

    private val prefs by lazy { getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) }
    private var isKioskModeActive = true

    private val chargingReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_POWER_CONNECTED -> onPowerConnected()
                Intent.ACTION_POWER_DISCONNECTED -> onPowerDisconnected()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        setContentView(R.layout.activity_main)

        kioskWebView = findViewById(R.id.kioskWebView)
        drawerLayout = findViewById(R.id.drawerLayout)
        kioskWebView.loadKioskUrl(KIOSK_URL)

        powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        devicePolicyManager = getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        adminComponent = ComponentName(this, KioskDeviceAdminReceiver::class.java)

        setupDrawerMenu()
        setupBackCallback()
        registerChargingReceiver()
        applyInitialPowerState()
        requestDeviceAdminIfNeeded()

        kioskWebView.onAdminGestureDetected = { if (isKioskModeActive) showPinDialog() }

        isKioskModeActive = prefs.getBoolean(PREF_KIOSK_ACTIVE, true)
        if (isKioskModeActive) enableKioskMode() else disableKioskMode()
    }

    override fun onResume() {
        super.onResume()
        applyImmersiveMode()
        if (isKioskModeActive) checkAndPromptPermissions()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersiveMode()
    }

    override fun onDestroy() {
        super.onDestroy()
        releaseWakeLock()
        kioskWebView.stopRetry()
        unregisterReceiver(chargingReceiver)
    }

    // region Drawer

    private fun setupDrawerMenu() {
        val version = packageManager.getPackageInfo(packageName, 0).versionName
        findViewById<TextView>(R.id.tvDrawerVersion).text = "Version $version"

        findViewById<LinearLayout>(R.id.menuGotoUrl).setOnClickListener {
            kioskWebView.loadKioskUrl(KIOSK_URL)
            drawerLayout.closeDrawer(Gravity.START)
        }
        findViewById<LinearLayout>(R.id.menuEnterKiosk).setOnClickListener {
            enableKioskMode()
        }
        findViewById<LinearLayout>(R.id.menuChangePin).setOnClickListener {
            showChangePinDialog()
        }
        findViewById<LinearLayout>(R.id.menuExit).setOnClickListener {
            finishAndRemoveTask()
        }
    }

    // endregion

    // region Kiosk mode

    private fun enableKioskMode() {
        isKioskModeActive = true
        prefs.edit().putBoolean(PREF_KIOSK_ACTIVE, true).apply()
        applyImmersiveMode()
        backCallback.isEnabled = true
        drawerLayout.closeDrawer(Gravity.START)
        drawerLayout.setDrawerLockMode(DrawerLayout.LOCK_MODE_LOCKED_CLOSED)
        checkAndPromptPermissions()
    }

    // Shows only the highest-priority missing permission dialog — never two at once.
    // Home App must be set first (it blocks the home button), then Accessibility Service.
    private fun checkAndPromptPermissions() {
        when {
            !isDefaultHomeApp() -> showSetAsHomePrompt()
            !isAccessibilityServiceEnabled() -> showAccessibilityPrompt()
        }
    }

    private fun isDefaultHomeApp(): Boolean {
        val intent = Intent(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME) }
        val info = packageManager.resolveActivity(intent, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY)
        return info?.activityInfo?.packageName == packageName
    }

    private fun showSetAsHomePrompt() {
        AlertDialog.Builder(this)
            .setTitle("Set as Home App")
            .setMessage(
                "To block the Home button, set \"${getString(R.string.app_name)}\" as " +
                    "your default Home app on the next screen.\n\n" +
                    "Select \"${getString(R.string.app_name)}\" and tap \"Always\"."
            )
            .setPositiveButton("Open Settings") { _, _ ->
                startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
            }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val serviceId = "$packageName/${KioskAccessibilityService::class.java.canonicalName}"
        val enabled = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabled.split(":").any { it.equals(serviceId, ignoreCase = true) }
    }

    private fun showAccessibilityPrompt() {
        AlertDialog.Builder(this)
            .setTitle("Enable Accessibility Service")
            .setMessage(
                "To fully lock the kiosk app to the screen, enable " +
                    "\"${getString(R.string.app_name)}\" in Accessibility Settings.\n\n" +
                    "Tap Open Settings → Accessibility → Installed Services → " +
                    "${getString(R.string.app_name)} → Enable."
            )
            .setPositiveButton("Open Settings") { _, _ ->
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun disableKioskMode() {
        isKioskModeActive = false
        prefs.edit().putBoolean(PREF_KIOSK_ACTIVE, false).apply()
        backCallback.isEnabled = false
        drawerLayout.setDrawerLockMode(DrawerLayout.LOCK_MODE_UNLOCKED)
    }

    private fun showPinDialog() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = "Enter PIN"
        }
        AlertDialog.Builder(this)
            .setTitle("Admin Access")
            .setView(input)
            .setPositiveButton("Confirm") { _, _ ->
                val entered = input.text.toString()
                val stored = prefs.getString(PREF_PIN, DEFAULT_PIN) ?: DEFAULT_PIN
                if (entered == stored) {
                    disableKioskMode()
                } else {
                    Toast.makeText(this, "Incorrect PIN", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showChangePinDialog() {
        val newPinInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = "New PIN"
        }
        val confirmInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = "Confirm new PIN"
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (20 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, 0)
            addView(newPinInput)
            addView(confirmInput)
        }
        AlertDialog.Builder(this)
            .setTitle("Change PIN")
            .setView(container)
            .setPositiveButton("Save") { _, _ ->
                val newPin = newPinInput.text.toString()
                val confirm = confirmInput.text.toString()
                when {
                    newPin.length < 4 ->
                        Toast.makeText(this, "PIN must be at least 4 digits", Toast.LENGTH_SHORT).show()
                    newPin != confirm ->
                        Toast.makeText(this, "PINs do not match", Toast.LENGTH_SHORT).show()
                    else -> {
                        prefs.edit().putString(PREF_PIN, newPin).apply()
                        Toast.makeText(this, "PIN updated", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    // endregion

    // region UI

    private fun applyImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }
    }

    // endregion

    // region Back button

    private fun setupBackCallback() {
        backCallback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { /* no-op in kiosk mode */ }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
    }

    // endregion

    // region Charging / power

    private fun registerChargingReceiver() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        }
        ContextCompat.registerReceiver(this, chargingReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun applyInitialPowerState() {
        val batteryIntent = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = batteryIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        if (plugged != 0) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    @Suppress("DEPRECATION")
    private fun onPowerConnected() {
        releaseWakeLock()
        // ACQUIRE_CAUSES_WAKEUP turns the screen on immediately even if the device is sleeping
        wakeLock = powerManager.newWakeLock(
            PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            WAKE_LOCK_TAG
        ).also { it.acquire(10_000L) }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        kioskWebView.loadKioskUrl(KIOSK_URL)
    }

    private fun onPowerDisconnected() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        releaseWakeLock()
        if (devicePolicyManager.isAdminActive(adminComponent)) {
            devicePolicyManager.lockNow()
        }
    }

    private fun requestDeviceAdminIfNeeded() {
        if (devicePolicyManager.isAdminActive(adminComponent)) return
        val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
            putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComponent)
            putExtra(
                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "Allows the kiosk to turn the screen off immediately when the power cord is unplugged."
            )
        }
        startActivity(intent)
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    // endregion

    companion object {
        private const val KIOSK_URL = "https://smart-shoe-care-machine.onrender.com/kiosk"
        private const val WAKE_LOCK_TAG = "KioskApp:PowerConnectedWakeLock"
        private const val PREFS_NAME = "kiosk_prefs"
        private const val PREF_KIOSK_ACTIVE = "kiosk_mode_active"
        private const val PREF_PIN = "kiosk_pin"
        const val DEFAULT_PIN = "1234"
    }
}
