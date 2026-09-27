package local.tower.deliverytracker

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException

/**
 * Shows the tracker's web UI from inside the APK. The pages load under the
 * address of the app's own server (TrackerApp, on 127.0.0.1), so the UI's
 * /api calls are same-origin requests to it. Nothing leaves the phone except
 * the update check against GitHub.
 */
class MainActivity : Activity() {
    private val scope = MainScope()
    private lateinit var web: WebView
    private lateinit var prefs: Prefs
    private var pendingStartCid: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        WebView.setWebContentsDebuggingEnabled(true)   // inspectable from chrome://inspect over USB
        web = WebView(this).apply {
            setBackgroundColor(0xFF1B1917.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webChromeClient = Dialogs()   // confirm() and alert() as plain app dialogs
            webViewClient = Client()
            addJavascriptInterface(Bridge(), "TrackerNative")
        }
        setContentView(web)
        scope.launch {
            val up = withContext(Dispatchers.IO) { TrackerApp.awaitServer() }
            val err = TrackerApp.startError
            if (up && err == null) {
                web.loadUrl("${prefs.server}/")
            } else {
                web.loadDataWithBaseURL(null,
                    "<body style='background:#1B1917;color:#ECE8E0;font:16px sans-serif;padding:16px'>" +
                        "<h3>The tracker couldn't start</h3><p>" + android.text.TextUtils.htmlEncode(err ?: "timed out") + "</p>" +
                        "<p>Close the app and open it again. Your data is not affected.</p></body>",
                    "text/html", "utf-8", null)
            }
        }
        if (!granted(Manifest.permission.POST_NOTIFICATIONS)) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
        }
    }

    /**
     * While the screen is off or another app (Uber) is in front, stop running
     * the page's timers and rendering, but only after a minute away. A quick
     * switch to Uber and back leaves the page exactly as it was, with no
     * redraw. GPS keeps recording in TrackingService the whole time.
     */
    private val pauseWeb = Runnable {
        web.pauseTimers()
        web.onPause()
        webPaused = true
    }
    private var webPaused = false
    private var refreshOnResume = false
    private var pageLoadedOnce = false

    private var leftAt = 0L

    override fun onStart() {
        super.onStart()
        if (leftAt != 0L) {   // a trip away during a shift: log how long it lasted
            prefs.switchStats = prefs.switchStats.add(SystemClock.elapsedRealtime() - leftAt)
            leftAt = 0L
        }
        web.removeCallbacks(pauseWeb)
        if (webPaused) {
            web.onResume()
            web.resumeTimers()
            webPaused = false
            refreshOnResume = true   // it was frozen, so it has something to catch up on
        }
    }

    override fun onStop() {
        scope.launch(Dispatchers.IO) { Backups.autoBackup(applicationContext) }   // at most hourly
        leftAt = if (prefs.tracking) SystemClock.elapsedRealtime() else 0L   // only while a shift runs
        web.postDelayed(pauseWeb, PAUSE_AFTER_MS)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        // If Android stopped the GPS service mid-shift, restart it now that the app is on screen.
        val cid = prefs.sessionCid
        if (cid != null && prefs.tracking && !TrackingService.isRunning && granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            startTracking(cid)
        }
        uploadInBackground()
        notifyJs()
        // WebViews don't reliably fire visibilitychange on resume, so tell the
        // page outright to refresh what it shows. Skipped after a quick switch:
        // the page never paused, so there is nothing to catch up on and a
        // redraw would only be jarring.
        if (refreshOnResume || !pageLoadedOnce) {
            web.post { web.evaluateJavascript("window.onNativeResume && window.onNativeResume()", null) }
        }
        refreshOnResume = false
        pageLoadedOnce = true
    }

    override fun onDestroy() {
        scope.cancel()
        web.destroy()
        super.onDestroy()
    }

    private fun granted(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun uploadInBackground() {
        scope.launch(Dispatchers.IO) { TrackUploader.uploadAll(applicationContext) }
    }

    private fun startTracking(cid: String) {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            pendingStartCid = cid
            requestPermissions(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                REQ_LOCATION,
            )
            return
        }
        try {
            startForegroundService(
                Intent(this, TrackingService::class.java)
                    .setAction(TrackingService.ACTION_START)
                    .putExtra(TrackingService.EXTRA_CID, cid)
            )
        } catch (e: RuntimeException) {
            // Android refuses a service start from the background; the page
            // then shows GPS off, with a button to start it by hand.
        }
        notifyJsSoon()
    }

    private fun stopTracking(discard: Boolean) {
        if (TrackingService.isRunning) {
            startService(
                Intent(this, TrackingService::class.java)
                    .setAction(TrackingService.ACTION_STOP)
                    .putExtra(TrackingService.EXTRA_DISCARD, discard)
            )
        } else {
            val cid = prefs.sessionCid
            prefs.clearTracking()
            if (discard && cid != null) {
                scope.launch(Dispatchers.IO) { PointStore.get(applicationContext).deleteSession(cid) }
            }
        }
        notifyJsSoon()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_LOCATION) {
            val cid = pendingStartCid
            pendingStartCid = null
            if (cid != null && granted(Manifest.permission.ACCESS_FINE_LOCATION)) startTracking(cid)
        }
        notifyJs()
    }

    private fun notifyJs() {
        web.post { web.evaluateJavascript("window.onNativeStatus && window.onNativeStatus()", null) }
    }

    /** The service starts and stops asynchronously; tell the page again once it has. */
    private fun notifyJsSoon() {
        notifyJs()
        web.postDelayed({ notifyJs() }, 1500)
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: RuntimeException) {
            // no app on the phone can open it
        }
    }

    @Deprecated("Activity result API needs AndroidX; this app has none")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) return
        scope.launch {
            val result: Pair<String, Boolean>? = withContext(Dispatchers.IO) {
                try {
                    when (requestCode) {
                        REQ_BACKUP -> Backups.saveTo(applicationContext, uri) to true
                        REQ_FOLDER -> Backups.setFolder(applicationContext, uri) to true
                        REQ_RESTORE -> Backups.restoreFrom(applicationContext, uri).let {
                            if (it.isEmpty()) "Restored. Everything now matches the backup." to true else it to false
                        }
                        else -> null
                    }
                } catch (e: Exception) {
                    "That didn't work: ${e.message ?: e.javaClass.simpleName}" to false
                }
            }
            val (msg, ok) = result ?: return@launch
            if (requestCode == REQ_RESTORE && ok) {
                // The page caches the old data in localStorage; clear it and start fresh.
                web.evaluateJavascript("try{localStorage.clear()}catch(e){}", null)
                web.loadUrl("${prefs.server}/")
                web.postDelayed({ backupResult(msg, true) }, 1500)
            } else {
                backupResult(msg, ok)
            }
        }
    }

    private fun backupResult(msg: String, ok: Boolean) {
        web.evaluateJavascript("window.onBackupResult && window.onBackupResult(${JSONObject.quote(msg)}, $ok)", null)
    }

    @Suppress("DEPRECATION")
    private fun pick(intent: Intent, request: Int) {
        try {
            startActivityForResult(intent, request)
        } catch (e: RuntimeException) {
            backupResult("No file picker on this phone", false)
        }
    }

    /**
     * The page's confirm() and alert() as ordinary dialogs. WebView's own
     * version heads every one with "The page at http://... says:".
     */
    private inner class Dialogs : WebChromeClient() {
        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            AlertDialog.Builder(this@MainActivity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            AlertDialog.Builder(this@MainActivity, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.confirm() }
                .show()
            return true
        }
    }

    private inner class Client : WebViewClient() {
        /** Serve the UI files from the APK; let /api and downloads go to the server. */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (request.method != "GET" || !sameOrigin(url, Uri.parse(prefs.server))) return null
            var path = url.path.orEmpty()
            if (path.isEmpty() || path == "/") path = "/index.html"
            if (path.startsWith("/api/") || path.startsWith("/download/")) return null
            val name = path.removePrefix("/")
            if ('/' in name || ".." in name) return null
            val mime = MIME[name.substringAfterLast('.')] ?: return null
            return try {
                WebResourceResponse(mime, if (mime.startsWith("image/")) null else "utf-8", assets.open("web/$name")).apply {
                    responseHeaders = mapOf("Cache-Control" to "no-store")
                }
            } catch (e: IOException) {
                null
            }
        }

        /** Links to other sites open in the browser instead of inside the app. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            val path = url.path.orEmpty()
            if (sameOrigin(url, Uri.parse(prefs.server)) && !path.startsWith("/api/") && !path.startsWith("/download/")) {
                return false
            }
            openExternal(url)
            return true
        }
    }

    /** Called from the page's JavaScript as window.TrackerNative, on a background thread. */
    private inner class Bridge {
        @JavascriptInterface
        fun status(): String = try {
            JSONObject().apply {
                put("native", true)
                put("version", BuildConfig.VERSION_NAME)
                put("version_code", BuildConfig.VERSION_CODE)
                put("tracking", TrackingService.isRunning && prefs.tracking)
                put("wants_tracking", prefs.tracking)
                put("session_cid", prefs.sessionCid ?: JSONObject.NULL)
                put("miles", prefs.meters / DistanceTracker.METERS_PER_MILE)
                put("last_fix_ms", prefs.lastFixMs)
                put("last_acc", prefs.lastAccuracy)
                put("fixes", TrackingService.fixCount)
                put("gps_restarts", TrackingService.restartCount)
                put("gps_enabled", getSystemService(LocationManager::class.java)
                    .isProviderEnabled(LocationManager.GPS_PROVIDER))
                put("pending_upload", PointStore.get(this@MainActivity).countPending())
                val sw = prefs.switchStats
                put("switches", JSONObject().apply {
                    put("count", sw.switchCount + sw.longCount)
                    put("avg_s", sw.avgSwitchSeconds)
                    put("long", sw.longCount)
                    put("within_pause_pct", Math.round(sw.shareWithin(PAUSE_AFTER_MS.toInt() / 1000) * 100).toInt())
                })
                put("permission", if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) "granted" else "denied")
                put("server", prefs.server)
            }.toString()
        } catch (e: Exception) {
            "{\"native\":true}"
        }

        @JavascriptInterface
        fun startTracking(cid: String?) {
            if (cid.isNullOrEmpty()) return
            runOnUiThread { this@MainActivity.startTracking(cid) }
        }

        @JavascriptInterface
        fun stopTracking(discard: Boolean) {
            runOnUiThread { this@MainActivity.stopTracking(discard) }
        }

        @JavascriptInterface
        fun setNotificationText(text: String?) {
            prefs.note = text
            TrackingService.refreshNotification()
        }

        @JavascriptInterface
        fun openExternal(url: String?) {
            if (url.isNullOrEmpty()) return
            runOnUiThread { this@MainActivity.openExternal(Uri.parse(url)) }
        }

        @JavascriptInterface
        fun flushTrack() = uploadInBackground()

        @JavascriptInterface
        fun backupInfo(): String = Backups.info(this@MainActivity)

        @JavascriptInterface
        fun backupNow() = runOnUiThread {
            pick(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType("application/octet-stream").putExtra(Intent.EXTRA_TITLE, Backups.fileName()), REQ_BACKUP)
        }

        @JavascriptInterface
        fun restoreBackup() = runOnUiThread {
            pick(Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), REQ_RESTORE)
        }

        @JavascriptInterface
        fun chooseBackupFolder() = runOnUiThread {
            pick(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
                .addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION), REQ_FOLDER)
        }

        /** Returns "" on success, otherwise an error message. */
        @JavascriptInterface
        fun setServer(url: String?): String {
            val clean = url.orEmpty().trim().trimEnd('/')
            val u = Uri.parse(clean)
            if (u.host.isNullOrEmpty() || u.scheme !in setOf("http", "https")) {
                return "Use a full address like http://127.0.0.1:38095"
            }
            prefs.server = clean
            runOnUiThread { web.loadUrl("$clean/") }
            return ""
        }
    }

    companion object {
        private const val REQ_LOCATION = 1
        private const val REQ_NOTIFY = 2
        private const val REQ_BACKUP = 3
        private const val REQ_RESTORE = 4
        private const val REQ_FOLDER = 5
        private const val PAUSE_AFTER_MS = 60_000L
        private val MIME = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "css" to "text/css",
            "png" to "image/png",
            "webmanifest" to "application/manifest+json",
        )

        private fun sameOrigin(a: Uri, b: Uri) =
            a.scheme.equals(b.scheme, ignoreCase = true) &&
                a.host.equals(b.host, ignoreCase = true) &&
                port(a) == port(b)

        private fun port(u: Uri) = if (u.port != -1) u.port else if (u.scheme.equals("https", true)) 443 else 80
    }
}
