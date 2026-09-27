package local.tower.deliverytracker

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONObject
import java.io.File
import java.time.LocalDate

/**
 * Copies the tracker database out to places the user picks (Storage Access
 * Framework), and back in. Everything here does file IO: call it off the
 * main thread.
 */
object Backups {
    private const val PREFIX = "delivery-tracker-"
    private const val KEEP_DAILY = 14
    private const val AUTO_EVERY_MS = 60L * 60 * 1000

    private fun sp(c: Context) = c.applicationContext.getSharedPreferences("backup", Context.MODE_PRIVATE)

    fun fileName(date: LocalDate = LocalDate.now()) = "$PREFIX$date.db"

    fun info(c: Context): String {
        val p = sp(c)
        val db = File(c.filesDir, "tracker.db")
        return JSONObject().apply {
            put("folder_name", p.getString("tree_name", null) ?: JSONObject.NULL)
            put("last_auto_ms", p.getLong("last_auto_ms", 0L))
            put("last_manual_ms", p.getLong("last_manual_ms", 0L))
            put("db_bytes", if (db.exists()) db.length() else 0L)
        }.toString()
    }

    /** A consistent snapshot of the live database in the app's cache. */
    private fun snapshot(c: Context): File {
        TrackerApp.awaitServer()
        val tmp = File(c.cacheDir, "backup-snapshot.db")
        TrackerApp.host().callAttr("backup_to", tmp.absolutePath)
        return tmp
    }

    private fun copyTo(c: Context, src: File, dest: Uri) {
        c.contentResolver.openOutputStream(dest, "wt").use { out ->
            requireNotNull(out) { "couldn't open the destination" }
            src.inputStream().use { it.copyTo(out) }
        }
    }

    /** Save to a file the user just created with the system picker. Returns a message. */
    fun saveTo(c: Context, dest: Uri): String {
        val tmp = snapshot(c)
        try {
            copyTo(c, tmp, dest)
        } finally {
            tmp.delete()
        }
        sp(c).edit().putLong("last_manual_ms", System.currentTimeMillis()).apply()
        return "Backup saved"
    }

    /** Replace the database with a backup file the user picked. Returns "" or an error. */
    fun restoreFrom(c: Context, src: Uri): String {
        TrackerApp.awaitServer()
        val tmp = File(c.cacheDir, "restore-incoming.db")
        try {
            c.contentResolver.openInputStream(src).use { input ->
                requireNotNull(input) { "couldn't open that file" }
                tmp.outputStream().use { input.copyTo(it) }
            }
            return TrackerApp.host().callAttr("restore_from", tmp.absolutePath).toString()
        } finally {
            tmp.delete()
        }
    }

    /** Remember the folder the user picked for automatic backups, then back up into it. */
    fun setFolder(c: Context, tree: Uri): String {
        c.contentResolver.takePersistableUriPermission(
            tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
        val name = folderName(c, tree) ?: "chosen folder"
        sp(c).edit().putString("tree", tree.toString()).putString("tree_name", name).putLong("last_auto_ms", 0L).apply()
        autoBackup(c, force = true)
        return "Backups will go to $name"
    }

    private fun folderName(c: Context, tree: Uri): String? {
        val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        c.contentResolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) return it.getString(0)
        }
        return null
    }

    /**
     * Today's copy into the chosen folder, at most once an hour unless forced.
     * One file per day; only the newest KEEP_DAILY are kept. Never throws.
     */
    fun autoBackup(c: Context, force: Boolean = false) {
        val p = sp(c)
        val treeStr = p.getString("tree", null) ?: return
        if (!force && System.currentTimeMillis() - p.getLong("last_auto_ms", 0L) < AUTO_EVERY_MS) return
        try {
            val tree = Uri.parse(treeStr)
            val treeDoc = DocumentsContract.getTreeDocumentId(tree)
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, treeDoc)
            val existing = mutableMapOf<String, Uri>()
            c.contentResolver.query(
                children,
                arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null, null, null,
            )?.use {
                while (it.moveToNext()) {
                    val name = it.getString(1) ?: continue
                    if (name.startsWith(PREFIX) && name.endsWith(".db")) {
                        existing[name] = DocumentsContract.buildDocumentUriUsingTree(tree, it.getString(0))
                    }
                }
            }
            val today = fileName()
            val parent = DocumentsContract.buildDocumentUriUsingTree(tree, treeDoc)
            val dest = existing[today]
                ?: DocumentsContract.createDocument(c.contentResolver, parent, "application/octet-stream", today)
                ?: return
            val tmp = snapshot(c)
            try {
                copyTo(c, tmp, dest)
            } finally {
                tmp.delete()
            }
            existing[today] = dest
            existing.keys.sortedDescending().drop(KEEP_DAILY).forEach { old ->
                try {
                    DocumentsContract.deleteDocument(c.contentResolver, existing.getValue(old))
                } catch (e: Exception) {
                    // leave it; the next run tries again
                }
            }
            p.edit().putLong("last_auto_ms", System.currentTimeMillis()).apply()
        } catch (e: Exception) {
            // Folder gone or permission revoked: keep the setting, try again next time.
        }
    }
}
