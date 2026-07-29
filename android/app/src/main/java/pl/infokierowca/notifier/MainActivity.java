package pl.infokierowca.notifier;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.InputStreamReader;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KernelSuPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

@CapacitorPlugin(name = "KernelSu")
public class KernelSuPlugin extends Plugin {

    @PluginMethod
    public void fetchChromeCookies(PluginCall call) {
        JSObject ret = new JSObject();
        StringBuilder logs = new StringBuilder();
        try {
            Process process = Runtime.getRuntime().exec("su");
            DataOutputStream os = new DataOutputStream(process.getOutputStream());
            
            // Execute sqlite3 query against Chrome SQLite cookie database
            String sqlCmd = "sqlite3 /data/data/com.android.chrome/app_chrome/Default/Cookies \"SELECT name, value FROM cookies WHERE host_key LIKE '%info-kierowca.pl%';\"\n";
            os.writeBytes(sqlCmd);
            os.writeBytes("exit\n");
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
                ret.put("message", "Nie znaleziono ciasteczek w bazie Chrome. Zaloguj się wpierw na info-kierowca.pl w Chrome.\nLogi:\n" + logs.toString());
                call.resolve(ret);
            }
        } catch (Exception e) {
            ret.put("success", false);
            ret.put("message", "Błąd wykonywania su (KernelSU): " + e.getMessage());
            call.resolve(ret);
        }
    }
}
