package pl.infokierowca.notifier;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KernelSuPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

@CapacitorPlugin(name = "KernelSu")
class KernelSuPlugin extends Plugin {

    @PluginMethod
    public void fetchChromeCookies(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            // Shell command executed via KernelSU (su) to extract cookies from Chrome SQLite DB
            String[] cmd = {
                "su",
                "-c",
                "sqlite3 /data/data/com.android.chrome/app_chrome/Default/Cookies \"SELECT name, value FROM cookies WHERE host_key LIKE '%info-kierowca.pl%';\""
            };
            Process process = Runtime.getRuntime().exec(cmd);
            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            String line;
            String pudojt = "";
            String pudojtmd = "";

            while ((line = reader.readLine()) != null) {
                if (line.contains("__Secure-PUDOJT|")) {
                    String[] parts = line.split("\\|");
                    if (parts.length >= 2) pudojt = parts[1].trim();
                } else if (line.contains("__Secure-PUDOJTMD|")) {
                    String[] parts = line.split("\\|");
                    if (parts.length >= 2) pudojtmd = parts[1].trim();
                }
            }
            process.waitFor();

            if (!pudojt.isEmpty()) {
                ret.put("success", true);
                ret.put("pudojt", pudojt);
                ret.put("pudojtmd", pudojtmd);
                call.resolve(ret);
            } else {
                ret.put("success", false);
                ret.put("message", "Brak ciasteczek w Chrome. Zaloguj się wpierw w przeglądarce Chrome.");
                call.resolve(ret);
            }
        } catch (Exception e) {
            ret.put("success", false);
            ret.put("message", "KernelSU Błąd: " + e.getMessage());
            call.resolve(ret);
        }
    }
}
