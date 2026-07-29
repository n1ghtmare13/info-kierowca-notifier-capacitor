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
        try {
            File cacheDir = getContext().getCacheDir();
            File tempDb = new File(cacheDir, "temp_chrome_cookies.db");
            if (tempDb.exists()) tempDb.delete();

            String[] candidatePaths = new String[]{
                "/data/data/com.android.chrome/app_chrome/Default/Network/Cookies",
                "/data/data/com.android.chrome/app_chrome/Default/Cookies",
                "/data/user/0/com.android.chrome/app_chrome/Default/Network/Cookies",
                "/data/user/0/com.android.chrome/app_chrome/Default/Cookies",
                "/data/data/com.chrome.beta/app_chrome/Default/Network/Cookies",
                "/data/user/0/com.chrome.beta/app_chrome/Default/Network/Cookies"
            };

            String pudojt = "";
            String pudojtmd = "";

            for (String targetPath : candidatePaths) {
                logs.append("Sprawdzam ścieżkę: ").append(targetPath).append("\n");

                // Execute su command to copy database file to app cache directory
                Process process = Runtime.getRuntime().exec("su");
                DataOutputStream os = new DataOutputStream(process.getOutputStream());
                
                String script = 
                    "SE_STATE=$(getenforce 2>/dev/null)\n" +
                    "setenforce 0 2>/dev/null\n" +
                    "chmod -R 755 /data/data/com.android.chrome/app_chrome 2>/dev/null\n" +
                    "chmod -R 755 /data/user/0/com.android.chrome/app_chrome 2>/dev/null\n" +
                    "cp \"" + targetPath + "\" \"" + tempDb.getAbsolutePath() + "\" 2>/dev/null\n" +
                    "chmod 666 \"" + tempDb.getAbsolutePath() + "\" 2>/dev/null\n" +
                    "chmod -R 700 /data/data/com.android.chrome/app_chrome 2>/dev/null\n" +
                    "chmod -R 700 /data/user/0/com.android.chrome/app_chrome 2>/dev/null\n" +
                    "if [ \"$SE_STATE\" = \"Enforcing\" ]; then setenforce 1 2>/dev/null; fi\n" +
                    "exit\n";

                os.writeBytes(script);
                os.flush();

                BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
                BufferedReader errorReader = new BufferedReader(new InputStreamReader(process.getErrorStream()));
                String line;
                while ((line = reader.readLine()) != null) logs.append("STDOUT: ").append(line).append("\n");
                while ((line = errorReader.readLine()) != null) logs.append("STDERR: ").append(line).append("\n");
                process.waitFor();

                if (tempDb.exists() && tempDb.length() > 0) {
                    logs.append("Pomyślnie skopiowano bazę (rozmiar: ").append(tempDb.length()).append(" bajtów).\n");

                    // Read database natively using Android Framework's SQLiteDatabase (no sqlite3 CLI needed)
                    SQLiteDatabase db = null;
                    try {
                        db = SQLiteDatabase.openDatabase(tempDb.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
                        Cursor cursor = db.rawQuery("SELECT name, value, encrypted_value FROM cookies WHERE name LIKE '%PUDOJT%'", null);
                        
                        if (cursor != null) {
                            while (cursor.moveToNext()) {
                                String name = cursor.getString(0);
                                String plainVal = cursor.getString(1);
                                byte[] encBytes = cursor.getBlob(2);

                                String val = (plainVal != null && !plainVal.isEmpty()) ? plainVal : decryptChromeAndroidBlob(encBytes);

                                if (name.contains("__Secure-PUDOJTMD")) {
                                    pudojtmd = val;
                                    logs.append("Odnaleziono PUDOJTMD!\n");
                                } else if (name.contains("__Secure-PUDOJT")) {
                                    pudojt = val;
                                    logs.append("Odnaleziono PUDOJT!\n");
                                }
                            }
                            cursor.close();
                        }
                    } catch (Exception dbErr) {
                        logs.append("Błąd otwarcie bazy SQLite w Java: ").append(dbErr.getMessage()).append("\n");
                    } finally {
                        if (db != null && db.isOpen()) db.close();
                    }

                    tempDb.delete();

                    if (!pudojt.isEmpty()) {
                        logs.append("Znaleziono poprawne ciasteczka w: ").append(targetPath).append("\n");
                        break;
                    }
                } else {
                    logs.append("Plik nie istnieje lub jest pusty.\n");
                }
            }

            ret.put("logs", logs.toString());

            if (!pudojt.isEmpty()) {
                ret.put("success", true);
                ret.put("pudojt", pudojt);
                ret.put("pudojtmd", pudojtmd);
                call.resolve(ret);
            } else {
                ret.put("success", false);
                ret.put("message", "Nie odnaleziono lub nie zdekodowano ciasteczek __Secure-PUDOJT.\nSzczegółowe logi:\n" + logs.toString());
                call.resolve(ret);
            }
        } catch (Exception e) {
            ret.put("success", false);
            ret.put("message", "Błąd wykonywania KernelSU: " + e.getMessage());
            call.resolve(ret);
        }
    }

    private String decryptChromeAndroidBlob(byte[] encBytes) {
        if (encBytes == null || encBytes.length < 3) return "";
        try {
            // Check for v10 prefix (0x76, 0x31, 0x30)
            byte[] rawPayload;
            if (encBytes[0] == 'v' && encBytes[1] == '1' && encBytes[2] == '0') {
                rawPayload = Arrays.copyOfRange(encBytes, 3, encBytes.length);
            } else {
                rawPayload = encBytes;
            }

            // Derive key using PBKDF2 SHA-1 "peanuts" + "saltysalt"
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

            // Extract JWT starting with eyJ
            Pattern jwtPattern = Pattern.compile("(eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)");
            Matcher matcher = jwtPattern.matcher(decryptedText);
            if (matcher.find()) {
                return matcher.group(1);
            }

            // Extract JSON metadata for PUDOJTMD
            Pattern jsonPattern = Pattern.compile("(\\{.*?\\})");
            Matcher jsonMatcher = jsonPattern.matcher(decryptedText);
            if (jsonMatcher.find()) {
                return jsonMatcher.group(1);
            }

            return decryptedText.trim();
        } catch (Exception e) {
            return "";
        }
    }
}
