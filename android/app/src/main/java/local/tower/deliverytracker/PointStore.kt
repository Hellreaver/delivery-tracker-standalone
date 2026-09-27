package local.tower.deliverytracker

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * GPS points kept on the phone until the server has them, so a dead zone
 * loses nothing. One shared instance: the service and the activity both use it.
 */
class PointStore private constructor(context: Context) : SQLiteOpenHelper(context, "points.db", null, 2) {

    data class Point(val id: Long, val t: Long, val lat: Double, val lon: Double, val acc: Double?, val spd: Double?)

    /** A fix the phone heard, whoever asked for it. [prov] is gps, fused or network. */
    data class PassivePoint(
        val id: Long, val t: Long, val prov: String, val lat: Double, val lon: Double,
        val acc: Double?, val spd: Double?,
    )

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE points (id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL, " +
                "t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, acc REAL, spd REAL, " +
                "uploaded INTEGER NOT NULL DEFAULT 0)"
        )
        db.execSQL("CREATE INDEX idx_points_pending ON points (uploaded, cid, id)")
        createPassive(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createPassive(db)   // existing points are untouched
    }

    private fun createPassive(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE IF NOT EXISTS passive (id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL, " +
                "t INTEGER NOT NULL, prov TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, acc REAL, " +
                "spd REAL, uploaded INTEGER NOT NULL DEFAULT 0)"
        )
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_passive_pending ON passive (uploaded, cid, id)")
    }

    fun insertPassive(cid: String, t: Long, prov: String, lat: Double, lon: Double, acc: Double, spd: Double) {
        val v = ContentValues().apply {
            put("cid", cid)
            put("t", t)
            put("prov", prov)
            put("lat", lat)
            put("lon", lon)
            if (!acc.isNaN()) put("acc", acc)
            if (!spd.isNaN()) put("spd", spd)
        }
        writableDatabase.insert("passive", null, v)
    }

    fun pendingPassiveSessions(): List<String> =
        readableDatabase.rawQuery("SELECT DISTINCT cid FROM passive WHERE uploaded = 0", null).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }

    fun pendingPassiveFor(cid: String, limit: Int): List<PassivePoint> =
        readableDatabase.rawQuery(
            "SELECT id, t, prov, lat, lon, acc, spd FROM passive WHERE uploaded = 0 AND cid = ? ORDER BY id LIMIT $limit",
            arrayOf(cid),
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(
                        PassivePoint(
                            id = c.getLong(0),
                            t = c.getLong(1),
                            prov = c.getString(2),
                            lat = c.getDouble(3),
                            lon = c.getDouble(4),
                            acc = if (c.isNull(5)) null else c.getDouble(5),
                            spd = if (c.isNull(6)) null else c.getDouble(6),
                        )
                    )
                }
            }
        }

    fun markPassiveUploaded(cid: String, maxId: Long) =
        writableDatabase.execSQL("UPDATE passive SET uploaded = 1 WHERE cid = ? AND id <= ?", arrayOf<Any>(cid, maxId))

    fun insert(cid: String, t: Long, lat: Double, lon: Double, acc: Double, spd: Double) {
        val v = ContentValues().apply {
            put("cid", cid)
            put("t", t)
            put("lat", lat)
            put("lon", lon)
            if (!acc.isNaN()) put("acc", acc)
            if (!spd.isNaN()) put("spd", spd)
        }
        writableDatabase.insert("points", null, v)
    }

    fun pendingSessions(): List<String> =
        readableDatabase.rawQuery("SELECT DISTINCT cid FROM points WHERE uploaded = 0", null).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }

    fun pendingFor(cid: String, limit: Int): List<Point> =
        readableDatabase.rawQuery(
            "SELECT id, t, lat, lon, acc, spd FROM points WHERE uploaded = 0 AND cid = ? ORDER BY id LIMIT $limit",
            arrayOf(cid),
        ).use { c ->
            buildList {
                while (c.moveToNext()) {
                    add(
                        Point(
                            id = c.getLong(0),
                            t = c.getLong(1),
                            lat = c.getDouble(2),
                            lon = c.getDouble(3),
                            acc = if (c.isNull(4)) null else c.getDouble(4),
                            spd = if (c.isNull(5)) null else c.getDouble(5),
                        )
                    )
                }
            }
        }

    fun markUploaded(cid: String, maxId: Long) =
        writableDatabase.execSQL("UPDATE points SET uploaded = 1 WHERE cid = ? AND id <= ?", arrayOf<Any>(cid, maxId))

    fun deleteSession(cid: String) {
        writableDatabase.delete("points", "cid = ?", arrayOf(cid))
        writableDatabase.delete("passive", "cid = ?", arrayOf(cid))
    }

    fun countPending(): Int =
        readableDatabase.rawQuery("SELECT COUNT(*) FROM points WHERE uploaded = 0", null).use { c ->
            if (c.moveToFirst()) c.getInt(0) else 0
        }

    fun oldestPendingTime(cid: String): Long =
        readableDatabase.rawQuery("SELECT MIN(t) FROM points WHERE uploaded = 0 AND cid = ?", arrayOf(cid)).use { c ->
            if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else System.currentTimeMillis()
        }

    /** Passive fixes the server never accepted (a discarded shift) are dropped after a week. */
    fun purgeStalePassive(timeMs: Long) {
        writableDatabase.delete("passive", "t < ?", arrayOf(timeMs.toString()))
    }

    fun purgeUploadedBefore(timeMs: Long) {
        writableDatabase.delete("points", "uploaded = 1 AND t < ?", arrayOf(timeMs.toString()))
        writableDatabase.delete("passive", "uploaded = 1 AND t < ?", arrayOf(timeMs.toString()))
    }

    companion object {
        @Volatile private var instance: PointStore? = null

        fun get(context: Context): PointStore =
            instance ?: synchronized(this) {
                instance ?: PointStore(context.applicationContext).also { instance = it }
            }
    }
}
