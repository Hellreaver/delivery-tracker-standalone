package local.tower.deliverytracker

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

/**
 * Records GPS while a shift runs. As a foreground service it keeps going with
 * the screen off or the Uber app in front. Android requires a notification
 * for that, so it shows the shift's running numbers.
 */
class TrackingService : Service(), LocationListener {
    private val tracker = DistanceTracker()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var prefs: Prefs
    private lateinit var store: PointStore
    private lateinit var locations: LocationManager
    private var cid: String? = null
    private var lastNotified = 0L
    private var uploadLoop: Job? = null
    private var watchdog: Job? = null
    private var startedAt = 0L
    private var lastFixAt = 0L
    private var fixes = 0
    private var restarts = 0
    private var uploadFailures = 0
    private var thermalStatus = PowerManager.THERMAL_STATUS_NONE
    private val hot: Boolean get() = thermalStatus >= PowerManager.THERMAL_STATUS_MODERATE

    /**
     * Only the work around GPS backs off when the phone heats up: uploads wait
     * longer and the notification redraws less often. Fixes are never slowed
     * or stopped, because the recorded track is the point of the app.
     */
    private val thermalListener = PowerManager.OnThermalStatusChangedListener { status -> thermalStatus = status }

    override fun onCreate() {
        super.onCreate()
        instance = this
        prefs = Prefs(this)
        store = PointStore.get(this)
        locations = getSystemService(LocationManager::class.java)
        val channel = NotificationChannel(CHANNEL, "Shift tracking", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shows while a shift is recording GPS mileage"
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> begin(intent.getStringExtra(EXTRA_CID))
            ACTION_STOP -> end(intent.getBooleanExtra(EXTRA_DISCARD, false))
            else -> stopSelf()
        }
        // Not sticky: Android won't let a location service restart itself from
        // the background. The app restarts it the next time it's opened.
        return START_NOT_STICKY
    }

    private fun begin(newCid: String?) {
        try {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } catch (e: RuntimeException) {
            // Permission revoked, or Android refused the foreground start.
            prefs.clearTracking()
            stopSelf()
            return
        }
        if (newCid == null ||
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            end(discard = false)
            return
        }
        if (newCid != cid) {
            if (newCid == prefs.sessionCid) {
                tracker.restore(prefs.savedState())   // same shift after a restart: keep its miles
            } else {
                tracker.reset()
                prefs.beginSession(newCid)
            }
            cid = newCid
        }
        prefs.setTracking(true)
        startedAt = SystemClock.elapsedRealtime()
        if (!requestUpdates()) {
            end(discard = false)
            return
        }
        startWatchdog()
        watchThermal()
        uploadLoop?.cancel()
        uploadFailures = 0
        uploadLoop = scope.launch {
            while (isActive) {
                delay(UploadPolicy.uploadDelayMs(hot, uploadFailures))
                val reached = withContext(Dispatchers.IO) { TrackUploader.uploadAll(applicationContext) }
                uploadFailures = if (reached) 0 else uploadFailures + 1
            }
        }
        notifyShift(force = true)
    }

    /**
     * Android throws if you remove a thermal listener that isn't registered,
     * or add one that already is. 1.21 to 1.26 removed it before the first add,
     * which crashed every shift start. The flag keeps add and remove paired.
     */
    private var thermalRegistered = false

    private fun watchThermal() {
        val pm = getSystemService(PowerManager::class.java)
        thermalStatus = pm.currentThermalStatus
        if (thermalRegistered) return
        try {
            pm.addThermalStatusListener(mainExecutor, thermalListener)
            thermalRegistered = true
        } catch (e: RuntimeException) {
            // Heat backoff is a nicety; a shift must start without it.
        }
    }

    private fun stopWatchingThermal() {
        if (!thermalRegistered) return
        thermalRegistered = false
        try {
            getSystemService(PowerManager::class.java).removeThermalStatusListener(thermalListener)
        } catch (e: RuntimeException) {
            // Already gone.
        }
    }

    /** Fixes from GPS, and from the fused provider as a second source. */
    private fun requestUpdates(): Boolean {
        locations.removeUpdates(this)
        var any = false
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.FUSED_PROVIDER)) {
            try {
                locations.requestLocationUpdates(provider, FIX_INTERVAL_MS, 0f, this, Looper.getMainLooper())
                any = true
            } catch (e: SecurityException) {
                return false
            } catch (e: IllegalArgumentException) {
                // This phone doesn't have that provider.
            }
        }
        return any
    }

    /**
     * Fixes can stop arriving with no error and no callback, which leaves the
     * service running and the mileage frozen. Ask again when they go quiet.
     */
    private fun startWatchdog() {
        watchdog?.cancel()
        watchdog = scope.launch {
            while (isActive) {
                delay(WATCHDOG_INTERVAL_MS)
                val since = SystemClock.elapsedRealtime() - (if (lastFixAt == 0L) startedAt else lastFixAt)
                if (since > STALL_MS) {
                    restarts++
                    requestUpdates()
                    notifyShift(force = true)
                }
            }
        }
    }

    private fun end(discard: Boolean) {
        locations.removeUpdates(this)
        stopWatchingThermal()
        watchdog?.cancel()
        uploadLoop?.cancel()
        val oldCid = cid ?: prefs.sessionCid
        prefs.clearTracking()
        cid = null
        val app = applicationContext
        // Deliberately outlives this service: the shift's last points still need to go up.
        CoroutineScope(Dispatchers.IO).launch {
            if (discard && oldCid != null) PointStore.get(app).deleteSession(oldCid)
            else TrackUploader.uploadAll(app)
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onLocationChanged(location: Location) {
        val c = cid ?: return
        lastFixAt = SystemClock.elapsedRealtime()
        fixes++
        val t = location.time
        val lat = location.latitude
        val lon = location.longitude
        val acc = if (location.hasAccuracy()) location.accuracy.toDouble() else Double.NaN
        val spd = if (location.hasSpeed()) location.speed.toDouble() else Double.NaN
        scope.launch(Dispatchers.IO) { store.insert(c, t, lat, lon, acc, spd) }
        tracker.offer(lat, lon, if (acc.isNaN()) 999.0 else acc, t, spd)
        prefs.save(tracker.snapshot(), System.currentTimeMillis(), if (acc.isNaN()) -1.0 else acc)
        notifyShift(force = false)
    }

    private fun buildNotification(): Notification {
        val tap = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val miles = String.format(Locale.US, "%.1f mi driven", tracker.miles)
        val note = prefs.note
        val text = if (note.isNullOrEmpty()) miles else "$note · $miles"
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Shift running")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(tap)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun notifyShift(force: Boolean) {
        if (cid == null) return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastNotified < UploadPolicy.notifyIntervalMs(hot)) return
        lastNotified = now
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    override fun onDestroy() {
        instance = null
        locations.removeUpdates(this)
        stopWatchingThermal()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "local.tower.deliverytracker.START"
        const val ACTION_STOP = "local.tower.deliverytracker.STOP"
        const val EXTRA_CID = "session_cid"
        const val EXTRA_DISCARD = "discard"

        private const val CHANNEL = "shift"
        private const val NOTIFICATION_ID = 1
        private const val FIX_INTERVAL_MS = 4000L
        private const val WATCHDOG_INTERVAL_MS = 20_000L
        private const val STALL_MS = 45_000L

        @Volatile private var instance: TrackingService? = null

        val isRunning: Boolean get() = instance != null

        /** Fixes counted this run, and how often the watchdog had to ask again. */
        val fixCount: Int get() = instance?.fixes ?: 0
        val restartCount: Int get() = instance?.restarts ?: 0

        /** The page's running numbers changed; redraw the notification now. */
        fun refreshNotification() {
            val s = instance ?: return
            s.scope.launch { s.notifyShift(force = true) }
        }
    }
}
