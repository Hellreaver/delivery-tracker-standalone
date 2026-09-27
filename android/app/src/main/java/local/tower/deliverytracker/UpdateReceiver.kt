package local.tower.deliverytracker

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/**
 * Installing an update kills the app, and the GPS service with it. Android
 * sends this broadcast to the app right afterwards, and it is one of the few
 * cases where a foreground service may be started from the background, so a
 * shift that was running picks its GPS back up without being opened.
 */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val prefs = Prefs(context)
        val cid = prefs.sessionCid
        if (!prefs.tracking || cid == null) return
        if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) return
        try {
            context.startForegroundService(
                Intent(context, TrackingService::class.java)
                    .setAction(TrackingService.ACTION_START)
                    .putExtra(TrackingService.EXTRA_CID, cid)
            )
        } catch (e: RuntimeException) {
            // Some builds still refuse it; opening the app restarts tracking.
        }
    }
}
