package local.tower.deliverytracker

import android.app.Application
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Starts the tracker's own server (Python, from app.py) inside this process,
 * so the app needs no computer and no signal. The page, the GPS service and the
 * uploader all talk to it at http://127.0.0.1:PORT.
 */
class TrackerApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Thread({
            try {
                if (!Python.isStarted()) Python.start(AndroidPlatform(this))
                Python.getInstance().getModule("tracker_host")
                    .callAttr("start", filesDir.absolutePath, PORT)
            } catch (e: Throwable) {
                startError = e.toString()
            } finally {
                ready.countDown()
            }
        }, "tracker-server-start").start()
    }

    companion object {
        const val PORT = 38095
        const val SERVER = "http://127.0.0.1:$PORT"
        private val ready = CountDownLatch(1)
        @Volatile var startError: String? = null
            private set

        /** Blocks until the server is up (or failed). Don't call on the main thread. */
        fun awaitServer(timeoutMs: Long = 20_000) = ready.await(timeoutMs, TimeUnit.MILLISECONDS)

        fun host() = Python.getInstance().getModule("tracker_host")
    }
}
