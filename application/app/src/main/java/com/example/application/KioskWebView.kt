package com.example.application

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AttributeSet
import android.view.MotionEvent
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

class KioskWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : WebView(context, attrs, defStyleAttr) {

    private val handler = Handler(Looper.getMainLooper())
    private var kioskUrl: String = ""
    private val retryRunnable = Runnable { loadUrlIgnoringCache(kioskUrl) }

    // Tap detection for admin gesture (5 taps within 1 second).
    var onAdminGestureDetected: (() -> Unit)? = null
    private val tapTimestamps = mutableListOf<Long>()

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        // Suppress long-press context menu (select / copy / paste popup)
        setOnLongClickListener { true }
        isHapticFeedbackEnabled = false
        applyKioskSettings()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_DOWN) {
            val now = SystemClock.uptimeMillis()
            tapTimestamps.removeAll { now - it > TAP_WINDOW_MS }
            tapTimestamps.add(now)
            if (tapTimestamps.size >= REQUIRED_TAPS) {
                tapTimestamps.clear()
                onAdminGestureDetected?.invoke()
            }
        }
        return super.onTouchEvent(event)
    }

    private fun applyKioskSettings() {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Prefer network + HTTP cache headers. LOAD_CACHE_ELSE_NETWORK kept stale
            // HTML/API responses after dashboard changes until the user cleared cache.
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val kioskHost = Uri.parse(kioskUrl).host
                if (request.url.host == kioskHost) {
                    // Same-origin navigation — let the web app handle its own routing
                    return false
                }
                // External URL — block and stay on kiosk
                view.loadUrl(kioskUrl, NO_CACHE_HEADERS)
                return true
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) scheduleRetry()
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse
            ) {
                if (request.isForMainFrame && errorResponse.statusCode >= 400) scheduleRetry()
            }
        }
    }

    fun loadKioskUrl(url: String) {
        kioskUrl = url
        stopRetry()
        // Ask origin/CDN for a fresh document; avoids stale kiosk shell after remote settings change.
        loadUrl(url, NO_CACHE_HEADERS)
    }

    private fun loadUrlIgnoringCache(url: String) {
        loadUrl(url, NO_CACHE_HEADERS)
    }

    fun stopRetry() {
        handler.removeCallbacks(retryRunnable)
    }

    private fun scheduleRetry() {
        handler.removeCallbacks(retryRunnable)
        handler.postDelayed(retryRunnable, RETRY_DELAY_MS)
    }

    companion object {
        private const val RETRY_DELAY_MS = 10_000L
        private const val TAP_WINDOW_MS = 1_000L
        private const val REQUIRED_TAPS = 5

        private val NO_CACHE_HEADERS = mapOf(
            "Cache-Control" to "no-cache",
            "Pragma" to "no-cache"
        )
    }
}
