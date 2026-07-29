package pl.infokierowca.notifier;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.InputStreamReader;

@CapacitorPlugin(name = "KernelSu")
public class KernelSuPlugin extends Plugin {

    @PluginMethod
    public void fetchChromeCookies(PluginCall call) {
        JSObject ret = new JSObject();
        StringBuilder logs = new StringBuilder();
        try {
            ProcessBuilder pb = new ProcessBuilder("su");
            pb.redirectErrorStream(true);
            Process process = pb.start();

            DataOutputStream os = new DataOutputStream(process.getOutputStream());

            String diagScript = 
                "echo '=========================================='\n" +
                "echo '[1] TOŻSAMOŚĆ ROOT I SELINUX'\n" +
                "echo '=========================================='\n" +
                "id\n" +
                "getenforce\n" +
                "echo ''\n" +

                "echo '=========================================='\n" +
                "echo '[2] ZAWARTOŚĆ /data/data/com.android.chrome'\n" +
                "echo '=========================================='\n" +
                "ls -la /data/data/com.android.chrome 2>&1\n" +
                "echo ''\n" +

                "echo '=========================================='\n" +
                "echo '[3] ZAWARTOŚĆ app_chrome'\n" +
                "echo '=========================================='\n" +
                "ls -la /data/data/com.android.chrome/app_chrome 2>&1\n" +
                "echo ''\n" +

                "echo '=========================================='\n" +
                "echo '[4] ZAWARTOŚĆ app_chrome/Default'\n" +
                "echo '=========================================='\n" +
                "ls -la /data/data/com.android.chrome/app_chrome/Default 2>&1\n" +
                "echo ''\n" +

                "echo '=========================================='\n" +
                "echo '[5] ZAWARTOŚĆ app_chrome/Default/Network'\n" +
                "echo '=========================================='\n" +
                "ls -la /data/data/com.android.chrome/app_chrome/Default/Network 2>&1\n" +
                "echo ''\n" +

                "echo '=========================================='\n" +
                "echo '[6] SZUKANIE WSZYSTKICH PLIKÓW COOKIES W CHROME'\n" +
                "echo '=========================================='\n" +
                "find /data/data/com.android.chrome/ -iname \"*cookie*\" -exec ls -la {} \\; 2>&1\n" +
                "find /data/user/0/com.android.chrome/ -iname \"*cookie*\" -exec ls -la {} \\; 2>&1\n" +
                "echo ''\n" +

                "echo '=========================================='\n" +
                "echo '[7] ZAWARTOŚĆ KATALOGU TEMPORARY /data/local/tmp'\n" +
                "echo '=========================================='\n" +
                "ls -la /data/local/tmp 2>&1\n" +
                "exit\n";

            os.writeBytes(diagScript);
            os.flush();

            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            String line;
            while ((line = reader.readLine()) != null) {
                logs.append(line).append("\n");
            }
            process.waitFor();

        } catch (Exception e) {
            logs.append("\n❌ KRYTYCZNY BŁĄD JAVA EXCEPTION: ").append(e.getMessage()).append("\n");
        }

        ret.put("success", false);
        ret.put("logs", logs.toString());
        ret.put("message", "Zakończono zrzut diagnostyczny.");
        call.resolve(ret);
    }
}
