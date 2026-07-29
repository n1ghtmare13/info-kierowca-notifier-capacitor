package pl.infokierowca.notifier;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

@CapacitorPlugin(name = "KernelSu")
public class KernelSuPlugin extends Plugin {

    @PluginMethod
    public void fetchChromeCookies(PluginCall call) {
        JSObject ret = new JSObject();
        StringBuilder logs = new StringBuilder();
        logs.append("=== ODCZYT COOKIES KERNELSU ===\n");
        try {
            File tempDb = new File("/data/local/tmp/ikw_chrome_cookies.db");
            if (tempDb.exists()) tempDb.delete();
            new File("/data/local/tmp/ikw_chrome_cookies.db-wal").delete();
            new File("/data/local/tmp/ikw_chrome_cookies.db-shm").delete();

            // Script executed under su -mm (Mount Master namespace) to bypass KernelSU app mount isolation
            String shellScript = 
                "setenforce 0 2>/dev/null\n" +
                "chmod 755 /data/data 2>/dev/null\n" +
                "chmod -R 755 /data/data/com.android.chrome 2>/dev/null\n" +
                "SRC=\"\"\n" +
                "if [ -f /data/data/com.android.chrome/app_chrome/Default/Cookies ]; then\n" +
                "  SRC=\"/data/data/com.android.chrome/app_chrome/Default/Cookies\"\n" +
                "elif [ -f /data/data/com.android.chrome/app_chrome/Default/Network/Cookies ]; then\n" +
                "  SRC=\"/data/data/com.android.chrome/app_chrome/Default/Network/Cookies\"\n" +
                "fi\n" +
                "if [ -n \"$SRC\" ]; then\n" +
                "  echo \"FOUND_SRC:$SRC\"\n" +
                "  cp \"$SRC\" /data/local/tmp/ikw_chrome_cookies.db 2>&1\n" +
                "  [ -f \"${SRC}-wal\" ] && cp \"${SRC}-wal\" /data/local/tmp/ikw_chrome_cookies.db-wal 2>&1\n" +
                "  [ -f \"${SRC}-shm\" ] && cp \"${SRC}-shm\" /data/local/tmp/ikw_chrome_cookies.db-shm 2>&1\n" +
                "  chmod 666 /data/local/tmp/ikw_chrome_cookies.db* 2>/dev/null\n" +
                "  echo \"COPY_SUCCESS\"\n" +
                "else\n" +
                "  echo \"ERROR: Nie znaleziono bazy Cookies\"\n" +
                "fi\n" +
                "chmod -R 700 /data/data/com.android.chrome 2>/dev/null\n" +
                "setenforce 1 2>/dev/null\n" +
                "exit\n";

            // Try su -mm first (Mount Master in KernelSU / Magisk), fallback to su
            Process process;
            try {
                process = Runtime.getRuntime().exec(new String[]{"su", "-mm"});
                logs.append("Uruchomiono su z flaga -mm (Mount Master).\n");
            } catch (Exception e) {
                process = Runtime.getRuntime().exec("su");
                logs.append("Uruchomiono standardowe su.\n");
            }

            DataOutputStream os = new DataOutputStream(process.getOutputStream());
            os.writeBytes(shellScript);
            os.flush();

            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            BufferedReader errorReader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
            String line;
            while ((line = reader.readLine()) != null) logs.append("STDOUT: ").append(line).append("\n");
            while ((line = errorReader.readLine()) != null) logs.append("STDERR: ").append(line).append("\n");
            process.waitFor();

            String pudojt = "";
            String pudojtmd = "";

            if (tempDb.exists() && tempDb.length() > 0) {
                logs.append("✅ Plik bazy skopiowany do /data/local/tmp/ (rozmiar: ").append(tempDb.length()).append(" bajtów).\n");

                SQLiteDatabase db = null;
                try {
                    db = SQLiteDatabase.openDatabase(tempDb.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
                    Cursor cursor = db.rawQuery("SELECT name, value, encrypted_value FROM cookies WHERE name LIKE '%PUDOJT%'", null);
                    if (cursor != null) {
                        int count = cursor.getCount();
                        logs.append("📊 Znalezione ciasteczka PUDOJT w bazie: ").append(count).append("\n");

                        while (cursor.moveToNext()) {
                            String name = cursor.getString(0);
                            String plainVal = cursor.getString(1);
                            byte[] encBytes = cursor.getBlob(2);

                            String val = (plainVal != null && !plainVal.isEmpty()) ? plainVal : decryptChromeAndroidBlob(encBytes, logs);

                            if (name.contains("__Secure-PUDOJTMD")) {
                                pudojtmd = val;
                                logs.append("🔑 Pobrano __Secure-PUDOJTMD!\n");
                            } else if (name.contains("__Secure-PUDOJT")) {
                                pudojt = val;
                                logs.append("🔑 Pobrano __Secure-PUDOJT!\n");
                            }
                        }
                        cursor.close();
                    }
                } catch (Exception dbErr) {
                    logs.append("❌ Błąd otwarcie SQLite: ").append(dbErr.getMessage()).append("\n");
                } finally {
                    if (db != null && db.isOpen()) db.close();
                }

                tempDb.delete();
                new File("/data/local/tmp/ikw_chrome_cookies.db-wal").delete();
                new File("/data/local/tmp/ikw_chrome_cookies.db-shm").delete();
            } else {
                logs.append("❌ Nie udało się skopiować pliku bazy z Chrome.\n");
            }

            ret.put("logs", logs.toString());

            if (!pudojt.isEmpty()) {
                ret.put("success", true);
                ret.put("pudojt", pudojt);
                ret.put("pudojtmd", pudojtmd);
                call.resolve(ret);
            } else {
                ret.put("success", false);
                ret.put("message", "Nie odnaleziono ciasteczek __Secure-PUDOJT w Chrome.\nLogi:\n" + logs.toString());
                call.resolve(ret);
            }
        } catch (Exception e) {
            ret.put("success", false);
            ret.put("message", "Błąd KernelSU: " + e.getMessage());
            call.resolve(ret);
        }
    }

    private String decryptChromeAndroidBlob(byte[] encBytes, StringBuilder logs) {
        if (encBytes == null || encBytes.length < 3) return "";
        try {
            byte[] rawPayload;
            if (encBytes[0] == 'v' && encBytes[1] == '1' && encBytes[2] == '0') {
                rawPayload = Arrays.copyOfRange(encBytes, 3, encBytes.length);
            } else {
                rawPayload = encBytes;
            }

            PBEKeySpec keySpec = new PBEKeySpec("peanuts".toCharArray(), "saltysalt".getBytes(StandardCharsets.UTF_8), 1, 128);
            SecretKeyFactory factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1");
            byte[] keyBytes = factory.generateSecret(keySpec).getEncoded();
            SecretKeySpec secretKey = new SecretKeySpec(keyBytes, "AES");

            byte[] iv = new byte[16];
            Arrays.fill(iv, (byte) ' ');
            IvParameterSpec ivSpec = new IvParameterSpec(iv);

            Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey, ivSpec);

            byte[] decrypted = cipher.doFinal(rawPayload);
            String decryptedText = new String(decrypted, StandardCharsets.ISO_8859_1);

            Pattern jwtPattern = Pattern.compile("(eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)");
            Matcher matcher = jwtPattern.matcher(decryptedText);
            if (matcher.find()) {
                return matcher.group(1);
            }

            Pattern jsonPattern = Pattern.compile("(\\{.*?\\})");
            Matcher jsonMatcher = jsonPattern.matcher(decryptedText);
            if (jsonMatcher.find()) {
                return jsonMatcher.group(1);
            }

            return decryptedText.trim();
        } catch (Exception e) {
            logs.append("❌ Błąd deszyfrowania AES: ").append(e.getMessage()).append("\n");
            return "";
        }
    }
}
