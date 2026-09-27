package local.tower.deliverytracker

import org.junit.Assert.assertEquals
import org.junit.Test

class SwitchStatsTest {
    private fun stats(vararg seconds: Double) =
        seconds.fold(SwitchStats()) { s, sec -> s.add((sec * 1000).toLong()) }

    @Test
    fun averageCoversOnlyTripsOfTenMinutesOrLess() {
        val s = stats(10.0, 30.0, 50.0, 1800.0)
        assertEquals(3, s.switchCount)
        assertEquals(1, s.longCount)
        assertEquals(30.0, s.avgSwitchSeconds, 0.001)
    }

    @Test
    fun shareWithinCountsEveryTripIncludingLongOnes() {
        val s = stats(5.0, 14.0, 20.0, 45.0, 200.0, 900.0)
        assertEquals(4.0 / 6.0, s.shareWithin(60), 1e-9)
        assertEquals(2.0 / 6.0, s.shareWithin(15), 1e-9)
    }

    @Test
    fun edgesAreInclusive() {
        val s = stats(60.0)
        assertEquals(1.0, s.shareWithin(60), 1e-9)
        assertEquals(0.0, s.shareWithin(30), 1e-9)
    }

    @Test
    fun emptyAndBadInputGiveZeros() {
        val s = SwitchStats()
        assertEquals(0, s.switchCount)
        assertEquals(0.0, s.avgSwitchSeconds, 0.0)
        assertEquals(0.0, s.shareWithin(60), 0.0)
        assertEquals(0.0, s.shareWithin(45), 0.0)   // not one of the edges
        assertEquals(s, s.add(-5))
    }

    @Test
    fun survivesTheRoundTripThroughStorage() {
        val s = stats(10.0, 70.0, 700.0)
        assertEquals(s, SwitchStats.decode(s.encode()))
        assertEquals(SwitchStats(), SwitchStats.decode("not stored data"))
        assertEquals(SwitchStats(), SwitchStats.decode("1,2,3|4"))
        assertEquals(SwitchStats(), SwitchStats.decode(null))
    }
}
