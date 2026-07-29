package pl.infokierowca.notifier;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
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
            Process process = Runtime.getRuntime().exec("su");
            DataOutputStream os = new DataOutputStream(process.getOutputStream());
            
            // 1. Temporarily grant traversal access (chmod 755) & setenforce 0
            // 2. Query name and HEX representation of encrypted_value for PUDOJT cookies
            // 3. Immediately restore chmod 700 & SELinux state
            String script = 
                "SE_STATE=$(getenforce 2>/dev/null)\n" +
                "setenforce 0 2>/dev/null\n" +
                "chmod -R 755 /data/data/com.android.chrome/app_chrome 2>/dev/null\n" +
                "chmod -R 755 /data/user/0/com.android.chrome/app_chrome 2>/dev/null\n" +
                "PATHS=\"" +
                "/data/data/com.android.chrome/app_chrome/Default/Cookies " +
                "/data/data/com.android.chrome/app_chrome/Default/Network/Cookies " +
                "/data/user/0/com.android.chrome/app_chrome/Default/Cookies " +
                "/data/user/0/com.android.chrome/app_chrome/Default/Network/Cookies " +
                "/data/data/com.chrome.beta/app_chrome/Default/Network/Cookies " +
                "/data/user/0/com.chrome.beta/app_chrome/Default/Network/Cookies\"\n" +
                "FOUND=0\n" +
                "for f in $PATHS; do\n" +
                "  echo \"TESTING_PATH:$f\"\n" +
                "  cp \"$f\" /data/local/tmp/temp_check.db 2>/dev/null\n" +
                "  if [ -f /data/local/tmp/temp_check.db ]; then\n" +
                "    chmod 666 /data/local/tmp/temp_check.db 2>/dev/null\n" +
                "    RES=$(sqlite3 /data/local/tmp/temp_check.db \"SELECT name, value, hex(encrypted_value) FROM cookies WHERE name LIKE '%PUDOJT%';\" 2>/dev/null)\n" +
                "    rm -f /data/local/tmp/temp_check.db 2>/dev/null\n" +
                "    if [ -n \"$RES\" ]; then\n" +
                "      echo \"MATCH_FOUND_IN:$f\"\n" +
                "      echo \"$RES\"\n" +
                "      FOUND=1\n" +
                "      break\n" +
                "    fi\n" +
                "  fi\n" +
                "done\n" +
                "chmod -R 700 /data/data/com.android.chrome/app_chrome 2>/dev/null\n" +
                "chmod -R 700 /data/user/0/com.android.chrome/app_chrome 2>/dev/null\n" +
                "if [ \"$SE_STATE\" = \"Enforcing\" ]; then\n" +
                "  setenforce 1 2>/dev/null\n" +
                "fi\n" +
                "if [ \"$FOUND\" -eq 0 ]; then\n" +
                "  echo \"NO_MATCHING_PUDOJT_COOKIES_FOUND\"\n" +
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
                if (line.contains("|")) {
                    String[] parts = line.split("\\|");
                    if (parts.length >= 2) {
                        String cookieName = parts[0].trim();
                        String plainVal = parts[1].trim();
                        String hexEnc = parts.length >= 3 ? parts[2].trim() : "";

                        String finalVal = plainVal;
                        if (finalVal.isEmpty() && !hexEnc.isEmpty()) {
                            finalVal = decryptChromeAndroidCookie(hexEnc);
                        }

                        if (cookieName.contains("__Secure-PUDOJTMD")) {
                            pudojtmd = finalVal;
                        } else if (cookieName.contains("__Secure-PUDOJT")) {
                            pudojt = finalVal;
                        }
                    }
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
                ret.put("message", "Nie odnaleziono lub nie zdekodowano ciasteczek __Secure-PUDOJT.\nLogi:\n" + logs.toString());
                call.resolve(ret);
            }
        } catch (Exception e) {
            ret.put("success", false);
            ret.put("message", "Błąd wykonywania su (KernelSU): " + e.getMessage());
            call.resolve(ret);
        }
    }

    private String decryptChromeAndroidCookie(String hexEncrypted) {
        try {
            byte[] bytes = hexStringToByteArray(hexEncrypted);
            if (bytes.length < 3) return "";

            // Check for v10 prefix (0x76, 0x31, 0x30)
            byte[] rawPayload;
            if (bytes[0] == 'v' && bytes[1] == '1' && bytes[2] == '0') {
                rawPayload = Arrays.copyOfRange(bytes, 3, bytes.length);
            } else {
                rawPayload = bytes;
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

    private static byte[] hexStringToByteArray(String s) {
        int len = s.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(s.charAt(i), 16) << 4)
                                 + Character.digit(s.charAt(i+1), 16));
        }
        return data;
    }
}
