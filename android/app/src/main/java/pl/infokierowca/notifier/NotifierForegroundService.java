package pl.infokierowca.notifier;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

public class NotifierForegroundService extends Service {
    public static final String CHANNEL_ID = "ikw_foreground_channel";
    public static final int NOTIFICATION_ID = 1001;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        
        PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "IKW:ForegroundWakeLock");
            wakeLock.acquire();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Info-Kierowca Notifier")
                .setContentText("Aktywne monitorowanie wolnych terminow w tle")
                .setSmallIcon(android.R.drawable.ic_popup_sync)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        startForeground(NOTIFICATION_ID, notification);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "Info-Kierowca Background Monitor",
                    NotificationManager.IMPORTANCE_LOW
            );
            serviceChannel.setDescription("Utrzymuje polaczenie sieciowe i dzialanie w tle przy zablokowanym ekranie");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(serviceChannel);
            }
        }
    }
}
