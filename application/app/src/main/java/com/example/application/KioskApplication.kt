package com.example.application

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.webkit.WebView

class KioskApplication : Application() {

    override fun onCreate() {
        super.onCreate()
        // Schedule WebView engine initialization as early as possible so the
        // rendering process is ready before MainActivity needs it.
        Handler(Looper.getMainLooper()).post {
            WebView(applicationContext).destroy()
        }
    }
}
