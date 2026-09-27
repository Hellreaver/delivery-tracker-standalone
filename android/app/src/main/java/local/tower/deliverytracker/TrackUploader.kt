package local.tower.deliverytracker

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Sends stored GPS points to POST /api/track in batches of 500. The server
 * ignores points it already has, so resending after a dropped connection is
 * safe. Points stay on the phone until the server confirms them. Blocking:
 * call it off the main thread.
 */
object TrackUploader {
    private const val BATCH = 500
    // A shift the server still doesn't know after a week was discarded or never synced.
    private const val GIVE_UP_MS = 7L * 24 * 3600 * 1000
    private const val KEEP_UPLOADED_MS = 30L * 24 * 3600 * 1000

    /** Returns false when the server couldn't be reached, so the caller can wait longer. */
    @Synchronized
    fun uploadAll(context: Context): Boolean {
        val prefs = Prefs(context)
        val store = PointStore.get(context)
        val url = "${prefs.server}/api/track"
        val current = prefs.sessionCid
        var reachable = true
        for (cid in store.pendingSessions()) {
            while (true) {
                val points = store.pendingFor(cid, BATCH)
                if (points.isEmpty()) break
                val code = post(url, toJson(cid, points))
                if (code == -1) reachable = false
                if (code == 200) {
                    store.markUploaded(cid, points.last().id)
                    continue
                }
                // 404: the shift isn't on the server yet (its start is still queued
                // in the app), or it was discarded. Keep trying for a week.
                if (code == 404 && cid != current &&
                    System.currentTimeMillis() - store.oldestPendingTime(cid) > GIVE_UP_MS
                ) {
                    store.deleteSession(cid)
                }
                break
            }
        }
        store.purgeUploadedBefore(System.currentTimeMillis() - KEEP_UPLOADED_MS)
        return reachable
    }

    private fun toJson(cid: String, points: List<PointStore.Point>): String {
        val arr = JSONArray()
        for (p in points) {
            arr.put(JSONObject().apply {
                put("t", p.t)
                put("lat", p.lat)
                put("lon", p.lon)
                p.acc?.let { put("acc", it) }
                p.spd?.let { put("spd", it) }
            })
        }
        return JSONObject().put("session_cid", cid).put("points", arr).toString()
    }

    /** Returns the HTTP status, or -1 when the server can't be reached. */
    fun post(url: String, json: String): Int {
        val conn = try {
            URL(url).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            return -1
        }
        return try {
            conn.connectTimeout = 15000
            conn.readTimeout = 20000
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            val body = json.toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
            val code = conn.responseCode
            // Drain the reply so the connection can be reused.
            (if (code >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() }
            code
        } catch (e: IOException) {
            -1
        } finally {
            conn.disconnect()
        }
    }
}
