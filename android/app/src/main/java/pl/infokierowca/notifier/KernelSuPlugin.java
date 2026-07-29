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
            Process process = Runtime.getRuntime().exec("su");
            DataOutputStream os = new DataOutputStream(process.getOutputStream());
            
            // Shell commands:
            // 1. Locate Chrome SQLite database (supports Chrome 120+ Network/Cookies, Default/Cookies, app_webview)
            // 2. Copy to /data/local/tmp/ to bypass active Chrome file locks
            // 3. Query sqlite3 for info-kierowca cookies
            // 4. Remove temp file
            String script = 
                "CPATH=$(ls /data/data/com.android.chrome/app_chrome/Default/Network/Cookies " +
                "/data/data/com.android.chrome/app_chrome/Default/Cookies " +
                "/data/data/com.android.chrome/app_webview/Default/Cookies " +
                "/data/data/com.android.chrome/app_webview/Cookies 2>/dev/null | head -n 1)\n" +
                "echo \"FOUND_PATH:$CPATH\"\n" +
                "if [ -n \"$CPATH\" ]; then\n" +
                "  cp \"$CPATH\" /data/local/tmp/temp_cookies.db 2>/dev/null\n" +
                "  chmod 666 /data/local/tmp/temp_cookies.db 2>/dev/null\n" +
                "  sqlite3 /data/local/tmp/temp_cookies.db \"SELECT name, value FROM cookies WHERE host_key LIKE '%info-kierowca.pl%';\" 2>/dev/null\n" +
                "  rm -f /data/local/tmp/temp_cookies.db\n" +
                "else\n" +
                "  echo \"NO_CHROME_COOKIE_FILE_FOUND\"\n" +
                "fi\n" +
                "exit\n";

            os.writeBytes(script);
            os.flush();

            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            BufferedReader errorReader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
            
            String line;
            String pudojt = "";
            String pudojtmd = "";

            while ((line = reader.readLine()) != null) {
                logs.append("STDOUT: ").append(line).append("\n");
                if (line.contains("__Secure-PUDOJT|")) {
                    String[] parts = line.split("\\|");
                    if (parts.length >= 2) pudojt = parts[1].trim();
                } else if (line.contains("__Secure-PUDOJTMD|")) {
                    String[] parts = line.split("\\|");
                    if (parts.length >= 2) pudojtmd = parts[1].trim();
                }
            }

            while ((line = errorReader.readLine()) != null) {
                logs.append("STDERR: ").append(line).append("\n");
            }

            process.waitFor();

            ret.put("logs", logs.toString());

            if (!pudojt.isEmpty()) {
                ret.put("success", true);
                ret.put("pudojt", pudojt);
                ret.put("pudojtmd", pudojtmd);
                call.resolve(ret);
            } else {
                ret.put("success", false);
                ret.put("message", "Nie odnaleziono wpisów __Secure-PUDOJT w bazie Chrome.\nSzczegóły logów:\n" + logs.toString());
                call.resolve(ret);
            }
        } catch (Exception e) {
            ret.put("success", false);
            ret.put("message", "Błąd wykonywania su (KernelSU): " + e.getMessage());
            call.resolve(ret);
        }
    }
}
