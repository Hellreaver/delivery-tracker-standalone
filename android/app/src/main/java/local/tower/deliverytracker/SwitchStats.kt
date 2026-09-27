package local.tower.deliverytracker

/**
 * How long each trip away from the app lasts while a shift runs: to Uber and
 * back, or a screen-off. Counts fall into buckets by seconds away, so the
 * page can say how often you are back inside the pause delay.
 *
 * "Switch" means away 10 minutes or less. Longer absences (a long drive with
 * the screen off) are counted apart and left out of the average.
 */
data class SwitchStats(
    val counts: List<Int> = List(EDGES_S.size + 1) { 0 },   // one per edge, then everything longer
    val switchTotalMs: Long = 0L,
) {
    val switchCount: Int get() = counts.dropLast(1).sum()
    val longCount: Int get() = counts.last()
    val avgSwitchSeconds: Double get() = if (switchCount == 0) 0.0 else switchTotalMs / 1000.0 / switchCount

    fun add(awayMs: Long): SwitchStats {
        if (awayMs < 0) return this
        val seconds = awayMs / 1000.0
        val bucket = EDGES_S.indexOfFirst { seconds <= it }.let { if (it == -1) EDGES_S.size else it }
        val next = counts.toMutableList().also { it[bucket] = it[bucket] + 1 }
        return copy(counts = next, switchTotalMs = if (bucket < EDGES_S.size) switchTotalMs + awayMs else switchTotalMs)
    }

    /** Share of all trips away that ended within [seconds], which must be one of [EDGES_S]. 0 to 1. */
    fun shareWithin(seconds: Int): Double {
        val total = counts.sum()
        val upto = EDGES_S.indexOf(seconds)
        if (total == 0 || upto == -1) return 0.0
        return counts.take(upto + 1).sum().toDouble() / total
    }

    /** Stored as "3,1,4,1,5,9,2|123456": bucket counts, then total switch milliseconds. */
    fun encode(): String = counts.joinToString(",") + "|" + switchTotalMs

    companion object {
        val EDGES_S = listOf(15, 30, 60, 120, 300, 600)

        fun decode(text: String?): SwitchStats {
            if (text.isNullOrEmpty()) return SwitchStats()
            val parts = text.split("|")
            if (parts.size != 2) return SwitchStats()
            val counts = parts[0].split(",").map { it.toIntOrNull() ?: return SwitchStats() }
            val ms = parts[1].toLongOrNull() ?: return SwitchStats()
            return if (counts.size == EDGES_S.size + 1) SwitchStats(counts, ms) else SwitchStats()
        }
    }
}
