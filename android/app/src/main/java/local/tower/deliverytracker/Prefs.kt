package local.tower.deliverytracker

import android.content.Context
import android.content.SharedPreferences

/** Small persistent state: the running shift's GPS tally. */
class Prefs(context: Context) {
    private val p: SharedPreferences =
        context.applicationContext.getSharedPreferences("tracker", Context.MODE_PRIVATE)

    /** The server runs inside this app (TrackerApp), so the address is fixed. */
    var server: String
        get() = DEFAULT_SERVER
        set(@Suppress("UNUSED_PARAMETER") value) {}

    /** Trips away from the app during shifts. Kept across shifts, never cleared with a tally. */
    var switchStats: SwitchStats
        get() = SwitchStats.decode(p.getString("switch_stats", null))
        set(value) = edit { putString("switch_stats", value.encode()) }

    val tracking: Boolean get() = p.getBoolean("tracking", false)
    val sessionCid: String? get() = p.getString("cid", null)
    val meters: Double get() = getDouble("meters")
    val lastFixMs: Long get() = p.getLong("last_fix_ms", 0L)
    val lastAccuracy: Double get() = getDouble("last_acc")

    var note: String?
        get() = p.getString("note", null)
        set(value) = edit { putString("note", value) }

    fun setTracking(on: Boolean) = edit { putBoolean("tracking", on) }

    /** A new shift: forget the previous shift's tally. */
    fun beginSession(cid: String) = edit {
        TRACK_KEYS.forEach { remove(it) }
        putString("cid", cid)
        putBoolean("tracking", true)
    }

    fun save(state: DistanceTracker.State, lastFixMs: Long, lastAccuracy: Double) = edit {
        putDouble("meters", state.meters)
        putBoolean("has_anchor", state.hasAnchor)
        putDouble("a_lat", state.lat)
        putDouble("a_lon", state.lon)
        putDouble("a_acc", state.accuracy)
        putLong("a_time", state.time)
        putInt("accepted", state.accepted)
        putInt("rejected", state.rejected)
        putLong("last_fix_ms", lastFixMs)
        putDouble("last_acc", lastAccuracy)
    }

    fun savedState() = DistanceTracker.State(
        meters = getDouble("meters"),
        hasAnchor = p.getBoolean("has_anchor", false),
        lat = getDouble("a_lat"),
        lon = getDouble("a_lon"),
        accuracy = getDouble("a_acc"),
        time = p.getLong("a_time", 0L),
        accepted = p.getInt("accepted", 0),
        rejected = p.getInt("rejected", 0),
    )

    fun clearTracking() = edit { TRACK_KEYS.forEach { remove(it) } }

    private inline fun edit(block: SharedPreferences.Editor.() -> Unit) {
        val e = p.edit()
        e.block()
        e.apply()
    }

    private fun SharedPreferences.Editor.putDouble(key: String, value: Double) =
        putLong(key, java.lang.Double.doubleToRawLongBits(value))

    private fun getDouble(key: String): Double =
        java.lang.Double.longBitsToDouble(p.getLong(key, java.lang.Double.doubleToRawLongBits(0.0)))

    companion object {
        const val DEFAULT_SERVER = TrackerApp.SERVER
        private val TRACK_KEYS = listOf(
            "cid", "tracking", "meters", "has_anchor", "a_lat", "a_lon", "a_acc", "a_time",
            "accepted", "rejected", "last_fix_ms", "last_acc", "note",
        )
    }
}
