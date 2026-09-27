package local.tower.deliverytracker

/**
 * How often a running shift sends its GPS points and redraws its notification.
 * GPS fixes themselves are never slowed: only the work around them backs off
 * when the phone runs hot or the server can't be reached.
 *
 * A point is about 80 bytes of JSON, so a 500-point batch is about 40 KB:
 * under a second at 500 kbit/s. The wait between uploads is about radio
 * wake-ups and heat, not bandwidth. At the usual one fix every 2 seconds a
 * 15-minute buffer is about 450 points, which still fits in one batch.
 */
object UploadPolicy {
    const val NORMAL_UPLOAD_MS = 5L * 60_000
    const val HOT_UPLOAD_MS = 15L * 60_000
    const val MAX_UPLOAD_MS = 30L * 60_000
    const val NORMAL_NOTIFY_MS = 10_000L
    const val HOT_NOTIFY_MS = 60_000L
    private const val MAX_DOUBLINGS = 3

    /** Wait before the next upload. Each failed attempt in a row doubles it, up to 30 minutes. */
    fun uploadDelayMs(hot: Boolean, failures: Int): Long {
        val base = if (hot) HOT_UPLOAD_MS else NORMAL_UPLOAD_MS
        return minOf(base shl failures.coerceIn(0, MAX_DOUBLINGS), MAX_UPLOAD_MS)
    }

    fun notifyIntervalMs(hot: Boolean): Long = if (hot) HOT_NOTIFY_MS else NORMAL_NOTIFY_MS
}
