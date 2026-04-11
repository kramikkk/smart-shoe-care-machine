package com.example.application

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
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
    private val retryRunnable = Runnable { loadUrl(kioskUrl) }

    init {
        applyKioskSettings()
    }

    private fun applyKioskSettings() {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.toString() != kioskUrl) {
                    view.loadUrl(kioskUrl)
                }
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
        loadUrl(url)
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
    }
}
