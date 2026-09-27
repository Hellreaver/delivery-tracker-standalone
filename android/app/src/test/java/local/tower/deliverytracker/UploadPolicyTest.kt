package local.tower.deliverytracker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UploadPolicyTest {
    @Test
    fun normalWaitIsFiveMinutesAndHotIsFifteen() {
        assertEquals(5 * 60_000L, UploadPolicy.uploadDelayMs(hot = false, failures = 0))
        assertEquals(15 * 60_000L, UploadPolicy.uploadDelayMs(hot = true, failures = 0))
    }

    @Test
    fun failuresDoubleTheWaitButNeverPastThirtyMinutes() {
        assertEquals(10 * 60_000L, UploadPolicy.uploadDelayMs(hot = false, failures = 1))
        assertEquals(20 * 60_000L, UploadPolicy.uploadDelayMs(hot = false, failures = 2))
        assertEquals(30 * 60_000L, UploadPolicy.uploadDelayMs(hot = false, failures = 3))
        assertEquals(30 * 60_000L, UploadPolicy.uploadDelayMs(hot = true, failures = 1))
        assertEquals(30 * 60_000L, UploadPolicy.uploadDelayMs(hot = true, failures = 50))
        assertEquals(5 * 60_000L, UploadPolicy.uploadDelayMs(hot = false, failures = -2))
    }

    @Test
    fun notificationRedrawsLessOftenWhenHot() {
        assertEquals(10_000L, UploadPolicy.notifyIntervalMs(hot = false))
        assertEquals(60_000L, UploadPolicy.notifyIntervalMs(hot = true))
    }

    @Test
    fun aHotBufferStillFitsOneBatch() {
        val pointsPerSecond = 0.5          // measured: one fix every 2 seconds
        val buffered = UploadPolicy.HOT_UPLOAD_MS / 1000 * pointsPerSecond
        assertTrue("$buffered points", buffered <= 500)
    }
}
