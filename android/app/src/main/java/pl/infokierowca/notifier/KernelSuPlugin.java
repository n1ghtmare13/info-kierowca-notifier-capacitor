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
            
            // Comprehensive wildcard search for any Chromium/Chrome/WebView Cookies file in /data/data/ or /data/user/0/
            String script = 
                "FOUND=0\n" +
                "for f in $(find /data/data/ /data/user/0/ -name \"Cookies\" 2>/dev/null); do\n" +
                "  echo \"TESTING_PATH:$f\"\n" +
                "  cp \"$f\" /data/local/tmp/temp_check.db 2>/dev/null\n" +
                "  chmod 666 /data/local/tmp/temp_check.db 2>/dev/null\n" +
                "  RES=$(sqlite3 /data/local/tmp/temp_check.db \"SELECT name, value FROM cookies WHERE host_key LIKE '%info-kierowca.pl%';\" 2>/dev/null)\n" +
                "  rm -f /data/local/tmp/temp_check.db\n" +
                "  if [ -n \"$RES\" ]; then\n" +
                "    echo \"MATCH_FOUND_IN:$f\"\n" +
                "    echo \"$RES\"\n" +
                "    FOUND=1\n" +
                "    break\n" +
                "  fi\n" +
                "done\n" +
                "if [ \"$FOUND\" -eq 0 ]; then\n" +
                "  echo \"NO_MATCHING_COOKIES_FOUND_IN_ANY_BROWSER\"\n" +
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
                ret.put("message", "Nie odnaleziono wpisów __Secure-PUDOJT w żadnym pliku Cookies na telefonie.\nLogi:\n" + logs.toString());
                call.resolve(ret);
            }
        } catch (Exception e) {
            ret.put("success", false);
            ret.put("message", "Błąd wykonywania su (KernelSU): " + e.getMessage());
            call.resolve(ret);
        }
    }
}
