package com.wastatusvideo.statusdrop.selfhost

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.content.res.AssetManager
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.system.Os
import android.util.Log
import com.wastatusvideo.statusdrop.MainActivity
import com.wastatusvideo.statusdrop.R
import java.io.File

/**
 * Foreground service that hosts the self-host WhatsApp bot.
 *
 * Runs in its own ":selfhost" process (see AndroidManifest.xml) so the Node.js
 * runtime cannot affect video compression in the main process, and so Android
 * does not freeze the bot when another app (WhatsApp) comes to the front.
 * Node can only start once per process: when it exits, this service stops and
 * kills its own process, and the next start gets a fresh one.
 */
class SelfHostService : Service() {
    companion object {
        private const val TAG = "StatusDropSelfHost"
        private const val CHANNEL_ID = "statusdrop_selfhost"
        private const val NOTIFICATION_ID = 4211
        const val ACTION_STOP = "com.wastatusvideo.statusdrop.selfhost.STOP"

        fun dataDir(context: Context) = File(context.filesDir, "selfhost/data")
        fun appDir(context: Context) = File(context.filesDir, "selfhost/app")
        fun bridgeFile(context: Context) = File(dataDir(context), "bridge.json")
        fun clipsDir(context: Context) = File(context.cacheDir, "processed")
        fun tmpDir(context: Context) = File(context.cacheDir, "selfhost-tmp")
    }

    @Volatile
    private var nodeStarted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Log.i(TAG, "Stop requested from the notification")
            stopAndExit()
            return START_NOT_STICKY
        }
        startInForeground()
        if (!nodeStarted) {
            nodeStarted = true
            Thread(::runNode, "statusdrop-node").start()
        }
        return START_NOT_STICKY
    }

    // Android 15 caps dataSync foreground services at 6 hours a day.
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "Foreground service time limit reached")
        stopAndExit()
    }

    override fun onDestroy() {
        super.onDestroy()
        // Node cannot outlive or restart within this process.
        Process.killProcess(Process.myPid())
    }

    private fun runNode() {
        val exitCode = try {
            val data = dataDir(this).apply { mkdirs() }
            tmpDir(this).mkdirs()
            clipsDir(this).mkdirs()
            bridgeFile(this).delete()
            val main = prepareBundle()
            Os.setenv("SD_DATA_DIR", data.absolutePath, true)
            Os.setenv("SD_TMP_DIR", tmpDir(this).absolutePath, true)
            Os.setenv("SD_CLIPS_DIR", clipsDir(this).absolutePath, true)
            NodeRunner.startNode(arrayOf("node", main.absolutePath))
        } catch (error: Throwable) {
            Log.e(TAG, "Self-host bot failed to start", error)
            -1
        }
        Log.i(TAG, "Self-host bot stopped (exit $exitCode)")
        stopAndExit()
    }

    private fun stopAndExit() {
        bridgeFile(this).delete()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        Process.killProcess(Process.myPid())
    }

    /** Copies assets/selfhost into private storage whenever the APK changes. */
    private fun prepareBundle(): File {
        val target = appDir(this)
        val stamp = File(target, ".apk-stamp")
        val apkStamp = packageManager.getPackageInfo(packageName, 0).lastUpdateTime.toString()
        val main = File(target, "main.js")
        if (!main.isFile || !stamp.isFile || stamp.readText() != apkStamp) {
            target.deleteRecursively()
            copyAssetTree(assets, "selfhost", target)
            stamp.writeText(apkStamp)
        }
        check(main.isFile) { "The self-host bot bundle is missing from this build." }
        return main
    }

    private fun copyAssetTree(manager: AssetManager, from: String, to: File) {
        val children = manager.list(from).orEmpty()
        if (children.isEmpty()) {
            to.parentFile?.mkdirs()
            manager.open(from).use { input -> to.outputStream().use { output -> input.copyTo(output) } }
            return
        }
        to.mkdirs()
        children.forEach { child -> copyAssetTree(manager, "$from/$child", File(to, child)) }
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Self-host delivery", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while your own WhatsApp number sends StatusDrop clips from this phone."
                },
            )
        }
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, SelfHostService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification: Notification = Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_selfhost)
            .setContentTitle("StatusDrop self-host is on")
            .setContentText("Your WhatsApp number can send clips from this phone.")
            .setContentIntent(openApp)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
