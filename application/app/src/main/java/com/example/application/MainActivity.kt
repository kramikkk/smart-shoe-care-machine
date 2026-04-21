package com.example.application

import android.app.AlertDialog
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Context.CONNECTIVITY_SERVICE
import android.content.Context.DEVICE_POLICY_SERVICE
import android.content.Context.MODE_PRIVATE
import android.content.Context.POWER_SERVICE
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebStorage
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.view.GravityCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.drawerlayout.widget.DrawerLayout

class MainActivity : AppCompatActivity() {

    private lateinit var kioskWebView: KioskWebView
    private lateinit var drawerLayout: DrawerLayout
    private lateinit var powerManager: PowerManager
    private lateinit var devicePolicyManager: DevicePolicyManager
    private lateinit var connectivityManager: ConnectivityManager
    private lateinit var adminComponent: ComponentName
    private lateinit var backCallback: OnBackPressedCallback
    private lateinit var pinPrefs: SharedPreferences
    private var networkWasLost = false
    private var lastScreenOnReloadElapsed: Long = 0L

    private val prefs by lazy { getSharedPreferences(KioskPrefs.FILE_NAME, MODE_PRIVATE) }
    private var isKioskModeActive = true

    // Handles power connect/disconnect and screen-on events
    private val systemReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_POWER_CONNECTED -> onPowerConnected()
                Intent.ACTION_POWER_DISCONNECTED -> onPowerDisconnected()
                Intent.ACTION_SCREEN_ON -> onScreenOnForWebView()
            }
        }
    }

    // After a real disconnect: reload only if the main frame failed; else dispatch `online` for JS/WebSocket.
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            if (networkWasLost) {
                networkWasLost = false
                runOnUiThread {
                    if (::kioskWebView.isInitialized) kioskWebView.onDefaultNetworkRestored()
                }
            }
        }
        override fun onLost(network: Network) {
            networkWasLost = true
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        setContentView(R.layout.activity_main)

        kioskWebView = findViewById(R.id.kioskWebView)
        drawerLayout = findViewById(R.id.drawerLayout)
        kioskWebView.loadKioskUrl(KIOSK_URL)

        powerManager = getSystemService(POWER_SERVICE) as PowerManager
        devicePolicyManager = getSystemService(DEVICE_POLICY_SERVICE) as DevicePolicyManager
        connectivityManager = getSystemService(CONNECTIVITY_SERVICE) as ConnectivityManager
        adminComponent = ComponentName(this, KioskDeviceAdminReceiver::class.java)

        try {
            pinPrefs = PinPreferences.pinPrefs(this)
        } catch (e: Exception) {
            showPinStorageFatalDialog(e)
            return
        }

        setupDrawerMenu()
        setupBackCallback()
        registerSystemReceiver()
        registerNetworkCallback()
        applyInitialPowerState()

        if (!pinPrefs.contains(PinPreferences.PREF_PIN_KEY)) {
            showFirstRunPinSetupDialog()
        } else {
            finishKioskStartup()
        }
    }

    /** Runs after an admin PIN exists (normal start) or after first-run PIN setup. */
    private fun finishKioskStartup() {
        kioskWebView.onAdminGestureDetected = { if (isKioskModeActive) showPinDialog() }

        isKioskModeActive = prefs.getBoolean(KioskPrefs.KEY_KIOSK_ACTIVE, true)
        if (isKioskModeActive) enableKioskMode() else disableKioskMode()
        requestDeviceAdminIfNeeded()
    }

    private fun showPinStorageFatalDialog(error: Throwable) {
        AlertDialog.Builder(this)
            .setTitle(R.string.pin_storage_error_title)
            .setMessage(getString(R.string.pin_storage_error_message, error.message ?: error.javaClass.simpleName))
            .setCancelable(false)
            .setPositiveButton(R.string.ok) { _, _ -> finish() }
            .show()
    }

    override fun onResume() {
        super.onResume()
        if (::kioskWebView.isInitialized) kioskWebView.onResume()
        applyImmersiveMode()
        if (isKioskModeActive) checkAndPromptPermissions()
    }

    override fun onPause() {
        if (::kioskWebView.isInitialized) kioskWebView.onPause()
        super.onPause()
    }

    /** Throttled full reload so every wake does not reset WebSockets unnecessarily. */
    private fun onScreenOnForWebView() {
        if (!::kioskWebView.isInitialized) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastScreenOnReloadElapsed < SCREEN_ON_RELOAD_MIN_INTERVAL_MS) return
        lastScreenOnReloadElapsed = now
        kioskWebView.loadKioskUrl(KIOSK_URL)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersiveMode()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::kioskWebView.isInitialized) kioskWebView.stopRetry()
        try {
            unregisterReceiver(systemReceiver)
        } catch (_: IllegalArgumentException) {
            // Not registered if onCreate failed partway.
        }
        if (::connectivityManager.isInitialized) {
            try {
                connectivityManager.unregisterNetworkCallback(networkCallback)
            } catch (_: IllegalArgumentException) {
                // Not registered if onCreate failed partway.
            }
        }
    }

    // region Drawer

    private fun setupDrawerMenu() {
        val version = readAppVersionName()
        findViewById<TextView>(R.id.tvDrawerVersion).text =
            getString(R.string.drawer_version_format, version)

        findViewById<LinearLayout>(R.id.menuGotoUrl).setOnClickListener {
            kioskWebView.loadKioskUrl(KIOSK_URL)
            drawerLayout.closeDrawer(GravityCompat.START)
        }

        // Update the initial text based on the current mode status
        updateKioskModeStatusText()

        findViewById<LinearLayout>(R.id.menuToggleKiosk).setOnClickListener {
            showKioskModeDialog()
        }
        findViewById<LinearLayout>(R.id.menuChangePin).setOnClickListener {
            showChangePinDialog()
        }
        findViewById<LinearLayout>(R.id.menuClearCache).setOnClickListener {
            kioskWebView.clearCache(true)
            WebStorage.getInstance().deleteAllData()
            kioskWebView.loadKioskUrl(KIOSK_URL)
            drawerLayout.closeDrawer(GravityCompat.START)
            Toast.makeText(this, R.string.cache_cleared, Toast.LENGTH_SHORT).show()
        }
        findViewById<LinearLayout>(R.id.menuExit).setOnClickListener {
            drawerLayout.closeDrawer(GravityCompat.START)
            showExitAppDialog()
        }
    }

    private fun readAppVersionName(): String {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                packageManager.getPackageInfo(
                    packageName,
                    PackageManager.PackageInfoFlags.of(0)
                ).versionName
            } else {
                @Suppress("DEPRECATION")
                packageManager.getPackageInfo(packageName, 0).versionName
            }
        } catch (_: PackageManager.NameNotFoundException) {
            null
        } ?: ""
    }

    private fun updateKioskModeStatusText() {
        val statusText = findViewById<TextView>(R.id.tvKioskModeStatus)
        statusText?.text = if (isKioskModeActive) {
            getString(R.string.kiosk_status_on)
        } else {
            getString(R.string.kiosk_status_off)
        }
    }

    private fun showKioskModeDialog() {
        val builder = AlertDialog.Builder(this)
            .setTitle(R.string.kiosk_mode_dialog_title)
            .setNegativeButton(R.string.cancel, null)

        if (isKioskModeActive) {
            builder
                .setMessage(R.string.kiosk_mode_already_on_message)
                .setPositiveButton(R.string.ok, null)
        } else {
            val view = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(60, 40, 60, 20)

                val details = TextView(this@MainActivity).apply {
                    text = getString(R.string.kiosk_mode_dialog_details)
                    textSize = 14f
                    setTextColor(android.graphics.Color.WHITE)
                    setPadding(0, 0, 0, 12)
                }
                addView(details)
            }
            builder
                .setView(view)
                .setPositiveButton(R.string.kiosk_mode_turn_on) { _, _ ->
                    enableKioskMode()
                    updateKioskModeStatusText()
                    drawerLayout.closeDrawer(GravityCompat.START)
                }
        }

        builder.show()
    }

    // endregion

    // region Kiosk mode

    private fun enableKioskMode() {
        isKioskModeActive = true
        prefs.edit {
            putBoolean(KioskPrefs.KEY_KIOSK_ACTIVE, true)
            putBoolean(KioskPrefs.KEY_LAUNCH_ON_BOOT, true)
        }
        updateKioskModeStatusText()
        applyImmersiveMode()
        backCallback.isEnabled = true
        drawerLayout.closeDrawer(GravityCompat.START)
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
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.resolveActivity(
                intent,
                PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong())
            )
        } else {
            @Suppress("DEPRECATION")
            packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)
        }
        return info?.activityInfo?.packageName == packageName
    }

    private fun showSetAsHomePrompt() {
        AlertDialog.Builder(this)
            .setTitle(R.string.set_as_home_app_title)
            .setMessage(getString(R.string.set_as_home_app_message, getString(R.string.app_name)))
            .setPositiveButton(R.string.open_settings) { _, _ ->
                startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
            }
            .setNegativeButton(R.string.later, null)
            .show()
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val serviceId = "$packageName/${KioskAccessibilityService::class.java.name}"
        val enabled = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabled.split(":").any { it.equals(serviceId, ignoreCase = true) }
    }

    private fun showAccessibilityPrompt() {
        val app = getString(R.string.app_name)
        AlertDialog.Builder(this)
            .setTitle(R.string.enable_accessibility_title)
            .setMessage(getString(R.string.enable_accessibility_message, app))
            .setPositiveButton(R.string.open_settings) { _, _ ->
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            .setNegativeButton(R.string.later, null)
            .show()
    }

    /**
     * @param syncPrefs If true, writes prefs synchronously (needed before [exitAppFully] kills the process).
     */
    private fun disableKioskMode(syncPrefs: Boolean = false) {
        isKioskModeActive = false
        prefs.edit(commit = syncPrefs) { putBoolean(KioskPrefs.KEY_KIOSK_ACTIVE, false) }
        updateKioskModeStatusText()
        backCallback.isEnabled = false
        drawerLayout.setDrawerLockMode(DrawerLayout.LOCK_MODE_UNLOCKED)
    }

    /**
     * Stops WebView/retry work, removes the task, then kills the process so a stuck or wedged
     * kiosk session cannot survive in memory (same effect as force-stop in Settings).
     *
     * Turning off kiosk in prefs stops [KioskAccessibilityService] from calling
     * [KioskAccessibilityService.bringKioskToFront] on the next launch.
     * [KioskPrefs.KEY_LAUNCH_ON_BOOT] is cleared so [BootReceiver] does not auto-start the app after reboot.
     */
    private fun exitAppFully() {
        isKioskModeActive = false
        updateKioskModeStatusText()
        backCallback.isEnabled = false
        drawerLayout.setDrawerLockMode(DrawerLayout.LOCK_MODE_UNLOCKED)
        prefs.edit(commit = true) {
            putBoolean(KioskPrefs.KEY_KIOSK_ACTIVE, false)
            putBoolean(KioskPrefs.KEY_LAUNCH_ON_BOOT, false)
        }
        kioskWebView.stopRetry()
        finishAndRemoveTask()
        Process.killProcess(Process.myPid())
    }

    /**
     * Sidebar exit: full process termination for recovery without rebooting the device.
     */
    private fun showExitAppDialog() {
        AlertDialog.Builder(this)
            .setTitle(R.string.exit_app_title)
            .setMessage(getString(R.string.exit_app_message, getString(R.string.app_name)))
            .setPositiveButton(R.string.exit_app_confirm) { _, _ ->
                exitAppFully()
            }
            .setNeutralButton(R.string.exit_app_accessibility) { _, _ ->
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            .setNegativeButton(R.string.exit_app_home_settings) { _, _ ->
                startActivity(Intent(Settings.ACTION_HOME_SETTINGS))
            }
            .setCancelable(true)
            .show()
    }

    private fun showFirstRunPinSetupDialog() {
        val newPinInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.first_run_pin_hint_new)
        }
        val confirmInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.first_run_pin_hint_confirm)
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (20 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, 0)
            addView(newPinInput)
            addView(confirmInput)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.first_run_pin_title)
            .setMessage(R.string.first_run_pin_message)
            .setView(container)
            .setCancelable(false)
            .setPositiveButton(R.string.first_run_pin_save, null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val newPin = newPinInput.text.toString()
                val confirm = confirmInput.text.toString()
                when {
                    newPin.length < 4 ->
                        Toast.makeText(this, R.string.pin_too_short, Toast.LENGTH_SHORT).show()
                    newPin != confirm ->
                        Toast.makeText(this, R.string.pin_mismatch, Toast.LENGTH_SHORT).show()
                    else -> {
                        pinPrefs.edit(commit = true) { putString(PinPreferences.PREF_PIN_KEY, newPin) }
                        dialog.dismiss()
                        finishKioskStartup()
                    }
                }
            }
        }
        dialog.show()
    }

    private fun showPinDialog() {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (20 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, 0)
        }
        val helper = TextView(this).apply {
            text = getString(R.string.admin_pin_enter_helper)
            textSize = 13f
            setTextColor(ContextCompat.getColor(this@MainActivity, android.R.color.darker_gray))
            setPadding(0, 0, 0, (8 * resources.displayMetrics.density).toInt())
        }
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.enter_pin_hint)
            transformationMethod = PasswordTransformationMethod.getInstance()
            isSingleLine = true
        }
        container.addView(helper)
        container.addView(input)

        AlertDialog.Builder(this)
            .setTitle(R.string.admin_access_title)
            .setView(container)
            .setPositiveButton(R.string.confirm) { _, _ ->
                val entered = input.text.toString()
                val stored = pinPrefs.getString(PinPreferences.PREF_PIN_KEY, null)
                if (stored == null) {
                    Toast.makeText(this, R.string.pin_not_configured, Toast.LENGTH_SHORT).show()
                    return@setPositiveButton
                }
                if (entered.isBlank()) {
                    Toast.makeText(this, R.string.pin_required, Toast.LENGTH_SHORT).show()
                } else if (entered == stored) {
                    disableKioskMode()
                } else {
                    Toast.makeText(this, R.string.pin_incorrect, Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showChangePinDialog() {
        val stored = pinPrefs.getString(PinPreferences.PREF_PIN_KEY, null)
        if (stored == null) {
            Toast.makeText(this, R.string.pin_not_configured, Toast.LENGTH_SHORT).show()
            return
        }
        val currentInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.change_pin_hint_current)
            transformationMethod = PasswordTransformationMethod.getInstance()
            isSingleLine = true
        }
        val newPinInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.change_pin_hint_new)
        }
        val confirmInput = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = getString(R.string.change_pin_hint_confirm)
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (20 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, 0)
            addView(currentInput)
            addView(newPinInput)
            addView(confirmInput)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.change_pin_title)
            .setView(container)
            .setPositiveButton(R.string.save) { _, _ ->
                val current = currentInput.text.toString()
                val newPin = newPinInput.text.toString()
                val confirm = confirmInput.text.toString()
                when {
                    current.isBlank() ->
                        Toast.makeText(this, R.string.pin_required, Toast.LENGTH_SHORT).show()
                    current != stored ->
                        Toast.makeText(this, R.string.pin_incorrect, Toast.LENGTH_SHORT).show()
                    newPin.length < 4 ->
                        Toast.makeText(this, R.string.pin_too_short, Toast.LENGTH_SHORT).show()
                    newPin != confirm ->
                        Toast.makeText(this, R.string.pin_mismatch, Toast.LENGTH_SHORT).show()
                    else -> {
                        pinPrefs.edit { putString(PinPreferences.PREF_PIN_KEY, newPin) }
                        Toast.makeText(this, R.string.pin_updated, Toast.LENGTH_SHORT).show()
                    }
                }
            }
            .setNegativeButton(R.string.cancel, null)
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

    private fun registerSystemReceiver() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        ContextCompat.registerReceiver(this, systemReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun registerNetworkCallback() {
        connectivityManager.registerDefaultNetworkCallback(networkCallback)
    }

    private fun applyInitialPowerState() {
        val batteryIntent = ContextCompat.registerReceiver(
            this,
            null,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        val plugged = batteryIntent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        if (plugged != 0) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun onPowerConnected() {
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setTurnScreenOn(true)
    }

    private fun onPowerDisconnected() {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setTurnScreenOn(false)
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
                getString(R.string.device_admin_explanation)
            )
        }
        startActivity(intent)
    }

    // endregion

    companion object {
        private const val KIOSK_URL = "https://smart-shoe-care-machine.onrender.com/kiosk"
        /** Minimum time between full reloads on [Intent.ACTION_SCREEN_ON] to avoid resetting WebSockets on every wake. */
        private const val SCREEN_ON_RELOAD_MIN_INTERVAL_MS = 300_000L
    }
}
