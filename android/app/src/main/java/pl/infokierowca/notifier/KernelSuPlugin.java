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
            
            // Script:
            // 1. Temporarily set SELinux permissive to bypass directory traversal locks on /data/data/com.android.chrome
            // 2. Explicitly target known Chrome & Chromium SQLite paths
            // 3. Fallback to find
            String script = 
                "SE_STATE=$(getenforce 2>/dev/null)\n" +
                "setenforce 0 2>/dev/null\n" +
                "PATHS=\"" +
                "/data/user/0/com.android.chrome/app_chrome/Default/Network/Cookies " +
                "/data/user/0/com.android.chrome/app_chrome/Default/Cookies " +
                "/data/data/com.android.chrome/app_chrome/Default/Network/Cookies " +
                "/data/data/com.android.chrome/app_chrome/Default/Cookies " +
                "/data/user/0/com.chrome.beta/app_chrome/Default/Network/Cookies " +
                "/data/data/com.chrome.beta/app_chrome/Default/Network/Cookies " +
                "/data/user/0/com.brave.browser/app_chrome/Default/Network/Cookies " +
                "/data/data/com.brave.browser/app_chrome/Default/Network/Cookies\"\n" +
                "FOUND=0\n" +
                "for f in $PATHS; do\n" +
                "  if [ -f \"$f\" ]; then\n" +
                "    echo \"TESTING_EXPLICIT_PATH:$f\"\n" +
                "    cp \"$f\" /data/local/tmp/temp_check.db 2>/dev/null\n" +
                "    chmod 666 /data/local/tmp/temp_check.db 2>/dev/null\n" +
                "    RES=$(sqlite3 /data/local/tmp/temp_check.db \"SELECT name, value FROM cookies WHERE host_key LIKE '%info-kierowca.pl%';\" 2>/dev/null)\n" +
                "    rm -f /data/local/tmp/temp_check.db 2>/dev/null\n" +
                "    if [ -n \"$RES\" ]; then\n" +
                "      echo \"MATCH_FOUND_IN:$f\"\n" +
                "      echo \"$RES\"\n" +
                "      FOUND=1\n" +
                "      break\n" +
                "    fi\n" +
                "  fi\n" +
                "done\n" +
                "if [ \"$SE_STATE\" = \"Enforcing\" ]; then\n" +
                "  setenforce 1 2>/dev/null\n" +
                "fi\n" +
                "if [ \"$FOUND\" -eq 0 ]; then\n" +
                "  echo \"NO_MATCHING_COOKIES_FOUND\"\n" +
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
                ret.put("message", "Nie odnaleziono wpisów __Secure-PUDOJT w bazie Chrome.\nLogi:\n" + logs.toString());
                call.resolve(ret);
            }
        } catch (Exception e) {
            ret.put("success", false);
            ret.put("message", "Błąd wykonywania su (KernelSU): " + e.getMessage());
            call.resolve(ret);
        }
    }
}
