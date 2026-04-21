# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Kiosk entry points + prefs (R8 release)
-keep class com.example.application.MainActivity { *; }
-keep class com.example.application.KioskWebView { *; }
-keep class com.example.application.PinPreferences { *; }
-keep class com.example.application.KioskPrefs { *; }
-keepclassmembers class * extends android.webkit.WebViewClient { public *; }

# EncryptedSharedPreferences / security-crypto (Tink references JSR-305 types not on Android classpath)
-dontwarn javax.annotation.Nullable
-dontwarn javax.annotation.concurrent.GuardedBy
-keep class androidx.security.crypto.** { *; }
-dontwarn org.bouncycastle.**

-keep class com.example.application.KioskApplication { *; }