package local.tower.deliverytracker

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Turns a stream of GPS fixes into driven distance.
 *
 * Distance is measured from an anchor: the last fix that was counted. A fix
 * skipped as noise isn't lost, because the next counted fix measures from the
 * same anchor. Skipped:
 *   - fixes with accuracy worse than 30 m
 *   - moves smaller than the two fixes' own uncertainty (drift while parked)
 *   - slow moves close to the anchor (walking into a restaurant and back)
 *   - moves implying more than 70 m/s, about 157 mph (GPS jumps)
 *
 * No Android dependencies, so it runs in plain JVM unit tests.
 */
class DistanceTracker {
    /** Everything needed to pick up where a stopped service left off. */
    data class State(
        val meters: Double = 0.0,
        val hasAnchor: Boolean = false,
        val lat: Double = 0.0,
        val lon: Double = 0.0,
        val accuracy: Double = 0.0,
        val time: Long = 0L,
        val accepted: Int = 0,
        val rejected: Int = 0,
    )

    private var s = State()

    val meters: Double get() = s.meters
    val miles: Double get() = s.meters / METERS_PER_MILE
    val accepted: Int get() = s.accepted
    val rejected: Int get() = s.rejected

    fun snapshot(): State = s
    fun restore(state: State) { s = state }
    fun reset() { s = State() }

    /** Offer one fix; speedMps is NaN when the fix has no speed. Returns true when it added distance. */
    fun offer(lat: Double, lon: Double, accuracyM: Double, timeMs: Long, speedMps: Double = Double.NaN): Boolean {
        if (lat.isNaN() || lon.isNaN() || !(accuracyM <= MAX_ACCURACY_M)) {
            s = s.copy(rejected = s.rejected + 1)
            return false
        }
        if (!s.hasAnchor) {
            s = s.copy(hasAnchor = true, lat = lat, lon = lon, accuracy = accuracyM, time = timeMs)
            return false
        }
        if (timeMs <= s.time) {
            s = s.copy(rejected = s.rejected + 1)
            return false
        }
        val d = distanceMeters(s.lat, s.lon, lat, lon)
        if (d < max(MIN_STEP_M, 0.5 * (s.accuracy + accuracyM))) return false
        val seconds = (timeMs - s.time) / 1000.0
        if (d / seconds > MAX_SPEED_MPS) {
            s = s.copy(rejected = s.rejected + 1)
            return false
        }
        if (!speedMps.isNaN() && speedMps < SLOW_SPEED_MPS && d < SLOW_RADIUS_M) return false
        s = State(s.meters + d, true, lat, lon, accuracyM, timeMs, s.accepted + 1, s.rejected)
        return true
    }

    companion object {
        const val METERS_PER_MILE = 1609.344
        const val MAX_ACCURACY_M = 30.0
        const val MIN_STEP_M = 12.0
        const val SLOW_SPEED_MPS = 2.5
        const val SLOW_RADIUS_M = 60.0
        const val MAX_SPEED_MPS = 70.0
        private const val EARTH_RADIUS_M = 6371008.8

        /** Great-circle distance in meters (haversine). */
        fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
            val p1 = Math.toRadians(lat1)
            val p2 = Math.toRadians(lat2)
            val dp = p2 - p1
            val dl = Math.toRadians(lon2 - lon1)
            val a = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
            return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(a)))
        }
    }
}
