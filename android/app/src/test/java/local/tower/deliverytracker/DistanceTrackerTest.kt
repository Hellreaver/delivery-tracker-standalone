package local.tower.deliverytracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random
import kotlin.math.cos

/**
 * Synthetic tracks with GPS-like noise. Fixed seeds, so the
 * results repeat. Each step returns {x meters, y meters, speed m/s, accuracy m}.
 */
class DistanceTrackerTest {
    private val lat0 = 31.5455
    private val lon0 = -110.2773
    private val mPerDegLat = 111320.0
    private val mPerDegLon = 111320.0 * cos(Math.toRadians(lat0))

    private fun run(n: Int, intervalMs: Long, noiseM: Double, seed: Long, step: (Int) -> DoubleArray): Double {
        val t = DistanceTracker()
        val r = Random(seed)
        val t0 = 1_789_000_000_000L
        for (i in 0 until n) {
            val p = step(i)
            val x = p[0] + r.nextGaussian() * noiseM
            val y = p[1] + r.nextGaussian() * noiseM
            t.offer(lat0 + y / mPerDegLat, lon0 + x / mPerDegLon, p[3], t0 + i * intervalMs, p[2])
        }
        return t.meters
    }

    private fun assertBetween(name: String, got: Double, lo: Double, hi: Double) {
        println("%-44s %8.1f m  (want %.0f..%.0f)".format(name, got, lo, hi))
        assertTrue("$name: got %.1f m, want %.0f..%.0f".format(got, lo, hi), got in lo..hi)
    }

    // 30 mph (13.4 m/s) for 10 minutes, fixes every 4 s: 8,040 m.
    private val drive = { i: Int -> doubleArrayOf(13.4 * 4 * i, 0.0, 13.4, 5.0) }

    @Test fun straightDrive() =
        assertBetween("straight drive", run(151, 4000, 3.0, 1, drive), 8040 * 0.98, 8040 * 1.02)

    @Test fun parkedWithSpeed() =
        assertBetween("parked, drift, speed reported", run(150, 4000, 6.0, 2) { doubleArrayOf(0.0, 0.0, 0.2, 8.0) }, 0.0, 30.0)

    @Test fun parkedWithoutSpeed() =
        assertBetween("parked, drift, no speed", run(150, 4000, 4.0, 3) { doubleArrayOf(0.0, 0.0, Double.NaN, 6.0) }, 0.0, 200.0)

    @Test fun walkIntoRestaurantAndBack() = assertBetween("walk 45 m in and back", run(17, 4000, 3.0, 4) { i ->
        val d = if (i <= 8) 5.6 * i else 5.6 * (16 - i)
        doubleArrayOf(d, 0.0, 1.4, 6.0)
    }, 0.0, 20.0)

    @Test fun gpsJumpIgnored() = assertBetween("2 km GPS jump", run(151, 4000, 3.0, 5) { i ->
        doubleArrayOf(13.4 * 4 * i + if (i == 75) 2000.0 else 0.0, 0.0, 13.4, 5.0)
    }, 8040 * 0.98, 8040 * 1.02)

    @Test fun poorAccuracyIgnored() = assertBetween("a third of fixes at 50 m accuracy", run(151, 4000, 3.0, 6) { i ->
        doubleArrayOf(13.4 * 4 * i, 0.0, 13.4, if (i % 3 == 0) 50.0 else 5.0)
    }, 8040 * 0.97, 8040 * 1.02)

    @Test fun blockLoop() = assertBetween("400 m block loop, 4 laps", run(201, 4000, 3.0, 7) { i ->
        val d = 8.0 * 4 * i % 1600
        when {
            d < 400 -> doubleArrayOf(d, 0.0, 8.0, 5.0)
            d < 800 -> doubleArrayOf(400.0, d - 400, 8.0, 5.0)
            d < 1200 -> doubleArrayOf(1200 - d, 400.0, 8.0, 5.0)
            else -> doubleArrayOf(0.0, 1600 - d, 8.0, 5.0)
        }
    } / 4.02, 1600 * 0.93, 1600 * 1.03)

    // 300 m, a 60 s stop at a light, then 280 m more: 580 m.
    @Test fun stopAndGo() = assertBetween("stop-and-go", run(45, 4000, 3.0, 8) { i ->
        when {
            i < 15 -> doubleArrayOf(20.0 * i, 0.0, 5.0, 5.0)
            i < 30 -> doubleArrayOf(300.0, 0.0, 0.0, 5.0)
            else -> doubleArrayOf(300.0 + 20 * (i - 30), 0.0, 5.0, 5.0)
        }
    }, 580 * 0.97, 580 * 1.03)

    @Test fun parkingLotCrawl() = assertBetween("parking-lot crawl, 200 m at 2 m/s",
        run(26, 4000, 3.0, 9) { i -> doubleArrayOf(8.0 * i, 0.0, 2.0, 5.0) }, 200 * 0.85, 200 * 1.10)

    // A service restart mid-shift must continue the same tally.
    @Test fun restoreContinuesTally() {
        val whole = DistanceTracker()
        val first = DistanceTracker()
        val t0 = 1_789_000_000_000L
        for (i in 0 until 60) {
            val lat = lat0 + (13.4 * 4 * i) / mPerDegLat
            whole.offer(lat, lon0, 5.0, t0 + i * 4000L, 13.4)
            if (i < 30) first.offer(lat, lon0, 5.0, t0 + i * 4000L, 13.4)
        }
        val second = DistanceTracker().apply { restore(first.snapshot()) }
        for (i in 30 until 60) second.offer(lat0 + (13.4 * 4 * i) / mPerDegLat, lon0, 5.0, t0 + i * 4000L, 13.4)
        assertEquals(whole.meters, second.meters, 0.001)
    }
}
