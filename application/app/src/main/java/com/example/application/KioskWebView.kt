package com.example.application

import android.content.Context
import android.os.Build
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
import android.webkit.URLUtil
import androidx.core.net.toUri

/**
 * Kiosk [WebView] tuned for a single HTTPS SPA that may use **WebSockets** (same Chromium stack as
 * the page — `wss://` uses the same TLS path as `https://`).
 *
 * - Avoids full reloads on transient network blips when the document already loaded (lets JS
 *   reconnect WebSockets; still fires a synthetic `online` event).
 * - Retries only for real main-frame failures, not user-cancelled navigations.
 * - Clears pending retries when a load succeeds.
 */
class KioskWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : WebView(context, attrs, defStyleAttr) {

    private val handler = Handler(Looper.getMainLooper())
    private var kioskUrl: String = ""
    private var retryAttempt = 0
    private val retryRunnable = Runnable {
        if (kioskUrl.isNotBlank()) {
            loadUrlIgnoringCache(kioskUrl)
        }
    }

    /** True after a main-frame load error until [onPageFinished] succeeds. */
    private var mainFrameLoadFailed = false

    // Tap detection for admin gesture (5 taps within 1 second).
    var onAdminGestureDetected: (() -> Unit)? = null
    private val tapTimestamps = mutableListOf<Long>()

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        setOnLongClickListener { true }
        isHapticFeedbackEnabled = false
        setLayerType(LAYER_TYPE_HARDWARE, null)
        applyKioskSettings()
    }

    override fun performClick(): Boolean {
        return super.performClick()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_DOWN) {
            val now = SystemClock.uptimeMillis()
            tapTimestamps.removeAll { now - it > TAP_WINDOW_MS }
            tapTimestamps.add(now)
            if (tapTimestamps.size >= REQUIRED_TAPS) {
                tapTimestamps.clear()
                onAdminGestureDetected?.invoke()
                performClick()
            }
        }
        return super.onTouchEvent(event)
    }

    private fun applyKioskSettings() {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = false
            blockNetworkLoads = false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            }
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (kioskUrl.isBlank()) return false
                val kioskHost = kioskUrl.toUri().host ?: return true
                if (request.url.host == kioskHost) {
                    return false
                }
                view.loadUrl(kioskUrl, NO_CACHE_HEADERS)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                handler.removeCallbacks(retryRunnable)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                mainFrameLoadFailed = false
                retryAttempt = 0
                handler.removeCallbacks(retryRunnable)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (!request.isForMainFrame) return
                if (isNonRetryableMainFrameError(error)) return
                mainFrameLoadFailed = true
                scheduleRetry()
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse
            ) {
                if (!request.isForMainFrame) return
                val code = errorResponse.statusCode
                // Do not full-retry on client errors; SPA/WebSocket can recover without navigation.
                if (code in 400..499) return
                if (code >= 500) {
                    mainFrameLoadFailed = true
                    scheduleRetry()
                }
            }
        }
    }

    private fun isNonRetryableMainFrameError(error: WebResourceError): Boolean {
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            error.errorCode
        } else {
            WebViewClient.ERROR_UNKNOWN
        }
        return when (code) {
            // net::ERR_ABORTED is handled internally by WebView; there is no ERROR_ABORTED in WebViewClient.
            WebViewClient.ERROR_REDIRECT_LOOP,
            WebViewClient.ERROR_UNSUPPORTED_SCHEME -> true
            else -> false
        }
    }

    fun loadKioskUrl(url: String) {
        if (!URLUtil.isHttpsUrl(url)) return
        val host = url.toUri().host
        if (host.isNullOrBlank()) return
        kioskUrl = url
        retryAttempt = 0
        mainFrameLoadFailed = false
        stopRetry()
        loadUrl(url, NO_CACHE_HEADERS)
    }

    private fun loadUrlIgnoringCache(url: String) {
        loadUrl(url, NO_CACHE_HEADERS)
    }

    /**
     * When the default network comes back: reload only if the last main-frame load failed;
     * otherwise notify the page so JS can reopen WebSockets without tearing down the document.
     */
    fun onDefaultNetworkRestored() {
        if (kioskUrl.isBlank()) return
        if (mainFrameLoadFailed) {
            loadKioskUrl(kioskUrl)
        } else {
            post {
                evaluateJavascript(DISPATCH_ONLINE_JS, null)
            }
        }
    }

    fun stopRetry() {
        handler.removeCallbacks(retryRunnable)
    }

    private fun scheduleRetry() {
        handler.removeCallbacks(retryRunnable)
        val delayMs = (RETRY_INITIAL_MS shl retryAttempt.coerceAtMost(MAX_RETRY_SHIFT)).coerceAtMost(RETRY_MAX_MS)
        retryAttempt++
        handler.postDelayed(retryRunnable, delayMs)
    }

    companion object {
        private const val RETRY_INITIAL_MS = 3_000L
        private const val RETRY_MAX_MS = 60_000L
        private const val MAX_RETRY_SHIFT = 4
        private const val TAP_WINDOW_MS = 1_000L
        private const val REQUIRED_TAPS = 5

        private val NO_CACHE_HEADERS = mapOf(
            "Cache-Control" to "no-cache",
            "Pragma" to "no-cache"
        )

        private const val DISPATCH_ONLINE_JS = """
            (function(){try{
              window.dispatchEvent(new Event('online'));
              window.dispatchEvent(new CustomEvent('kiosk-network-restored'));
            }catch(e){}})()
        """
    }
}
