/**
 * Info-Kierowca Notifier Mobile - 1:1 Feature Port with KernelSU Integration
 */

(function () {
  'use strict';

  const PWPW_SEARCH_URL = "https://info-kierowca.pl/bknd/exam/api/v1/Schedules/user/MultipleCentersExams";

  const DEFAULT_CONFIG = {
    profile_number: "",
    category: "B",
    exam_type: "Practice",
    organization_ids: [],
    current_slot_date: "",
    poll_interval_seconds: 15,
    earliest_slot_hour: 7,
    latest_slot_hour: 20,
    auto_confirm_reschedule: false,
    auto_select_slot: false,
    auto_open_browser: true,
    wakelock_enabled: true,
    ntfy_channel: ""
  };

  let config = loadConfig();
  let session = loadSession();
  let historyLogs = [];
  let currentHits = [];
  let isPaused = false;
  let pollTimer = null;
  let countdownTimer = null;
  let nextCheckTimestamp = null;
  let wordCentersData = [];

  const $ = id => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', async () => {
    await loadReferenceData();
    initUI();
    updateStatusUI();
    requestWakeLock();
    startForegroundService();
    startPollingLoop();
    startCountdownLoop();

    // Re-check immediately when returning to the app or when network restores
    window.addEventListener('online', () => {
      addLog("[NETWORK RESTORED] Polaczenie internetowe zostalo przywrocone. Odswiezam...");
      runCheck();
    });

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
        if (state.isActive) {
          addLog("[APP RESUME] Powrot do aplikacji. Weryfikuje status...");
          runCheck();
        }
      });
    }
  });

  async function startForegroundService() {
    const plugin = getKernelSuPlugin();
    if (plugin && typeof plugin.startForegroundService === 'function') {
      try {
        const res = await plugin.startForegroundService();
        if (res && res.success) {
          addLog("[FOREGROUND SERVICE] Uruchomiono serwis w tle (WakeLock + Ongoing Notification). Internet i proces nie beda odlaczane przy zablokowanym ekranie.");
        }
      } catch (e) {
        console.warn("startForegroundService failed", e);
      }
    }
  }

  function loadConfig() {
    try {
      const saved = localStorage.getItem('ikw_config');
      return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG };
    } catch (e) {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(cfg) {
    config = { ...config, ...cfg };
    localStorage.setItem('ikw_config', JSON.stringify(config));
  }

  function loadSession() {
    try {
      const saved = localStorage.getItem('ikw_session');
      return saved ? JSON.parse(saved) : { pudojt: "", pudojtmd: "", captured_at: null };
    } catch (e) {
      return { pudojt: "", pudojtmd: "", captured_at: null };
    }
  }

  function saveSession(pudojt, pudojtmd) {
    session = {
      pudojt: pudojt.trim(),
      pudojtmd: (pudojtmd || '').trim(),
      captured_at: new Date().toISOString()
    };
    localStorage.setItem('ikw_session', JSON.stringify(session));
    updateStatusUI();
  }

  async function loadReferenceData() {
    try {
      const res = await fetch('js/word_centers.json');
      wordCentersData = await res.json();
    } catch (e) {
      console.warn("Reference data load failed", e);
    }
  }

  // Register Native KernelSU Plugin
  function getKernelSuPlugin() {
    if (window.Capacitor && typeof window.Capacitor.registerPlugin === 'function') {
      try { return window.Capacitor.registerPlugin('KernelSu'); } catch (e) {}
    }
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KernelSu) {
      return window.Capacitor.Plugins.KernelSu;
    }
    return null;
  }

  const PWPW_REFRESH_URL = "https://info-kierowca.pl/bknd/auth/api/v1/jwt/refresh";

  // --- Session JWT Refresher ---
  async function doJwtRefresh() {
    if (!session.pudojt) return;
    try {
      const cookieStr = `__Secure-PUDOJT=${session.pudojt}; __Secure-PUDOJTMD=${session.pudojtmd || ''}`;
      const headers = {
        'Cookie': cookieStr,
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Referer': 'https://info-kierowca.pl/reservation',
        'Origin': 'https://info-kierowca.pl'
      };

      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
        const res = await window.Capacitor.Plugins.CapacitorHttp.request({
          method: 'GET',
          url: PWPW_REFRESH_URL,
          headers: headers
        });
        if (res.status === 204 || res.status === 200) {
          addLog(`[REFRESH OK] Przedluzono sesje JWT (Status ${res.status})`);
        } else if (res.status === 401 || res.status === 403 || res.status === 500) {
          addLog(`[REFRESH EXPIRED] Sesja wygasla na serwerze PWPW (Status ${res.status})`);
        }
      } else {
        const res = await fetch(PWPW_REFRESH_URL, { method: 'GET', headers: headers });
        if (res.ok || res.status === 204) {
          addLog(`[REFRESH OK] Przedluzono sesje JWT (Status ${res.status})`);
        }
      }
    } catch (e) {
      addLog(`[REFRESH ERROR] Blad odswiezania JWT: ${e.message}`);
    }
  }

  // --- KernelSU Root Cookie Extractor ---
  async function fetchCookiesViaKernelSu() {
    addLog("Rozpoczynam przeszukiwanie baz Cookies w Androidzie (Root)...");
    const plugin = getKernelSuPlugin();

    if (plugin) {
      try {
        const res = await plugin.fetchChromeCookies();
        if (res && res.success && res.pudojt) {
          saveSession(res.pudojt, res.pudojtmd || '');
          const pudojtPrev = res.pudojt.length > 25 ? res.pudojt.substring(0, 25) + '...' : res.pudojt;
          const pudojtmdPrev = (res.pudojtmd && res.pudojtmd.length > 25) ? res.pudojtmd.substring(0, 25) + '...' : res.pudojtmd;
          
          addLog(`[OK] Pomyslnie odczytano i aktywowano ciasteczka!\n__Secure-PUDOJT: ${pudojtPrev}\n__Secure-PUDOJTMD: ${pudojtmdPrev || '(brak)'}`);
          if (res.logs) addLog("=== LOGI ROOT ===\n" + res.logs);
          alert(`SUKCES! Pobrano sesje mObywatel z Chrome!\n\nPUDOJT: ${pudojtPrev}`);
          runCheck();
        } else if (res && res.logs) {
          addLog("=== LOGI DIAGNOSTYCZNE ===\n" + res.logs);
          alert("ZRZUT DIAGNOSTYCZNY:\n\n" + res.logs);
        } else {
          const msg = (res && res.message) ? res.message : 'Brak ciasteczka w Chrome';
          addLog(`Root Wynik: ${msg}`);
          alert(`Root Wynik:\n${msg}`);
        }
      } catch (err) {
        addLog(`Root Blad Wywolania: ${err.message}`);
        alert("Blad wywolania Root: " + err.message);
      }
    } else {
      addLog("Srodowisko: Uruchomiono w przegladarce WWW (Brak wtyczki natywnej Androida).");
      alert("Aplikacja otwarta w przegladarce WWW. Zainstaluj plik .apk na zrootowanym telefonie.");
    }
  }

  async function openChromeBrowser(targetUrl) {
    const loginUrl = targetUrl || "https://info-kierowca.pl/login";
    const plugin = getKernelSuPlugin();
    if (plugin) {
      try {
        if (typeof plugin.enableChromeCdpRoot === 'function') {
          await plugin.enableChromeCdpRoot();
        }
        if (typeof plugin.openGoogleChrome === 'function') {
          const res = await plugin.openGoogleChrome({ url: loginUrl });
          if (res && res.success) return;
        }
      } catch (e) {
        console.warn("openGoogleChrome failed, using fallback", e);
      }
    }
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      window.Capacitor.Plugins.Browser.open({ url: loginUrl });
    } else {
      window.open(loginUrl, '_blank');
    }
  }

  // --- Search Polling Engine ---
  async function runCheck() {
    if (isPaused) return;

    if (!session.pudojt) {
      setUIState("error", "Wymagane logowanie mObywatel", "Zaloguj się w Chrome i kliknij 'Pobierz sesję z Chrome (Root)'.");
      return;
    }

    if (!config.organization_ids || config.organization_ids.length === 0) {
      setUIState("error", "Wybierz ośrodki WORD", "Dodaj co najmniej jeden ośrodek WORD w formularzu ustawień poniżej.");
      return;
    }

    // First attempt to refresh JWT token to keep session alive up to 60 mins
    await doJwtRefresh();

    setUIState("scanning", "Sprawdzam...", getCentersSummary());
    nextCheckTimestamp = Date.now() + (Math.max(15, config.poll_interval_seconds) * 1000);

    try {
      const chunks = prepareChunks(config.organization_ids);
      addLog(`[REQ] Przygotowano ${chunks.length} paczek (po ${chunks[0] ? chunks[0].length : 0} osrodkow). Chunks: ${JSON.stringify(chunks)}`);
      let allResults = [];

      for (let i = 0; i < chunks.length; i++) {
        const raw = await doPwpwRequest(chunks[i]);
        if (Array.isArray(raw)) allResults = allResults.concat(raw);
        if (i < chunks.length - 1) await sleep(1200);
      }

      // Log total raw slots found in response for diagnostic verification
      logRawSlotsDiagnostic(allResults);

      const matchingHits = filterSlots(allResults);

      if (matchingHits.length > 0) {
        currentHits = matchingHits;
        const fastest = matchingHits[0];
        const dateStr = fmtDate(fastest.datetime);

        setUIState("hit", `Znaleziono: ${dateStr}!`, `${fastest.word} (${fastest.exam_type}) · Miejsc: ${fastest.places}`);
        addLog(`[HIT] ${dateStr} · ${fastest.word} (${fastest.exam_type})`);

        triggerAlerts(fastest);

        if (config.auto_open_browser !== false) {
          addLog("[AUTO OPEN] Znaleziono wolny termin! Otwieram stronę rezerwacji w Google Chrome...");
          await openChromeBrowser('https://info-kierowca.pl/reservation');
          runCdpAutoReschedule(fastest);
        }
      } else {
        currentHits = [];
        const limitInfo = config.current_slot_date ? ` przed ${config.current_slot_date}` : '';
        setUIState("scanning", "Sprawdzam...", `Brak wolnych terminów${limitInfo}`);
        addLog(`[INFO] Sprawdzono (${allResults.length} osrodkow z PWPW). Brak terminow pasujacych do filtrow (data/godziny).`);
      }

    } catch (err) {
      if (isNetworkError(err)) {
        setUIState("scanning", "Brak połączenia z siecią", "Tymczasowy brak dostępu do internetu. Ponawiam...");
        addLog(`[NETWORK WARNING] Tymczasowy brak sieci (DNS/Doze mode): ${err.message}. Następny cykl ponowi próbę.`);
      } else {
        setUIState("error", "Błąd sesji / połączenia", err.message);
        addLog(`[ERROR] ${err.message}`);
      }
    }
  }

  async function runCdpAutoReschedule(fastestHit) {
    if (!config.auto_select_slot && !config.auto_confirm_reschedule) return;

    addLog("[CDP AUTOMATION] Rozpoczynam automatyczne klikanie po CDP w Chrome (Zmień termin -> Wybór godziny)...");
    await sleep(2500);

    try {
      const listRes = await fetch("http://127.0.0.1:9222/json/list");
      const tabs = await listRes.json();
      const targetTab = tabs.find(t => t.url && t.url.includes("info-kierowca.pl")) || tabs[0];

      if (!targetTab || !targetTab.webSocketDebuggerUrl) {
        addLog("[CDP WARNING] Nie mozna polaczyc z otwartym portem CDP 9222 w Chrome.");
        return;
      }

      const wsUrl = targetTab.webSocketDebuggerUrl;
      const ws = new WebSocket(wsUrl);

      ws.onopen = async () => {
        addLog("[CDP CONNECTED] Polaczono z portem zdalnego sterowania Chrome CDP 9222!");
        let msgId = 1;

        const evalJs = (jsCode) => new Promise((resolve) => {
          const id = msgId++;
          const handler = (evt) => {
            try {
              const data = JSON.parse(evt.data);
              if (data.id === id) {
                ws.removeEventListener('message', handler);
                resolve(data.result ? data.result.value : null);
              }
            } catch (e) { resolve(null); }
          };
          ws.addEventListener('message', handler);
          ws.send(JSON.stringify({
            id: id,
            method: "Runtime.evaluate",
            params: { expression: jsCode, returnByValue: true }
          }));
        });

        const clickTextJs = (text) => `
          (function(txt) {
            var all = document.querySelectorAll('button, a, [role="button"]');
            var best = null;
            for (var i = 0; i < all.length; i++) {
              var el = all[i];
              var t = (el.innerText || el.textContent || '').trim();
              if (t && t.length < 60 && t.toLowerCase().indexOf(txt.toLowerCase()) !== -1) {
                if (!best || t.length < best[1].length) best = [el, t];
              }
            }
            if (best) { best[0].click(); return true; }
            return false;
          })(${JSON.stringify(text)})
        `;

        const selectSlotJs = (examLabel, timeStr) => `
          (function(examLabel, timeStr) {
            var radios = document.querySelectorAll('input[type="radio"]');
            for (var i = 0; i < radios.length; i++) {
              var radio = radios[i];
              var cur = radio;
              var t = '';
              for (var depth = 0; depth < 6 && cur; depth++) {
                t = (cur.innerText || cur.textContent || '').trim();
                if (t.indexOf(examLabel) !== -1 && t.indexOf(timeStr) !== -1) break;
                cur = cur.parentElement;
              }
              if (t.indexOf(examLabel) !== -1 && t.indexOf(timeStr) !== -1) {
                radio.click();
                return true;
              }
            }
            return false;
          })(${JSON.stringify(examLabel)}, ${JSON.stringify(timeStr)})
        `;

        // Step 1: Click "Zmień termin"
        addLog("[CDP STEP 1] Klikam 'Zmień termin'...");
        await evalJs(clickTextJs("Zmień termin"));
        await sleep(1500);

        // Step 2: Click "Zmień termin rezerwacji"
        addLog("[CDP STEP 2] Klikam 'Zmień termin rezerwacji'...");
        await evalJs(clickTextJs("Zmień termin rezerwacji"));
        await sleep(2000);

        // Step 3: Select matching slot if auto_select_slot is enabled
        if (config.auto_select_slot && fastestHit) {
          const d = new Date(fastestHit.datetime);
          const timeStr = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
          const examLabel = fastestHit.exam_type === 'Praktyka' ? 'Egzamin praktyczny' : 'Egzamin teoretyczny';
          
          addLog(`[CDP STEP 3] Wybieram slot ${examLabel} ${timeStr}...`);
          await evalJs(selectSlotJs(examLabel, timeStr));
          await sleep(1000);

          // Step 4: Click "Przejdź do podsumowania"
          addLog("[CDP STEP 4] Klikam 'Przejdź do podsumowania'...");
          await evalJs(clickTextJs("Przejdź do podsumowania"));
          await sleep(1500);

          // Step 5: If auto_confirm_reschedule is enabled, click "Potwierdź i przejdź dalej"
          if (config.auto_confirm_reschedule) {
            addLog("[CDP STEP 5] Automatyczne zatwierdzenie: Klikam 'Potwierdź i przejdź dalej'!");
            await evalJs(clickTextJs("Potwierdź i przejdź dalej"));
          }
        }
      };

    } catch (err) {
      addLog(`[CDP ERROR] Blad automatycznych klikniet po CDP: ${err.message}`);
    }
  }

  function isNetworkError(err) {
    if (!err) return false;
    const msg = (err.message || String(err)).toLowerCase();
    return msg.includes('unable to resolve host') ||
           msg.includes('no address associated with hostname') ||
           msg.includes('failed to fetch') ||
           msg.includes('networkerror') ||
           msg.includes('unknownhostexception') ||
           msg.includes('connectexception') ||
           msg.includes('sockettimeout') ||
           msg.includes('offline');
  }

  function logRawSlotsDiagnostic(rawResults) {
    let summaryLines = [];
    for (const word of rawResults) {
      const wordName = word.wordName || getWordName(word.wordId || word.organizationId);
      const exams = word.examCollectionForDay || [];
      for (const exam of exams) {
        const dtStr = exam.practiceDateTime || exam.theoryDateTime;
        const places = exam.placePracticeAmount || exam.placeTheoryAmount || 0;
        if (dtStr && places > 0) {
          summaryLines.push(`${wordName} | ${exam.examType || 'Exam'} | ${dtStr} | Wolnych: ${places}`);
        }
      }
    }
    if (summaryLines.length > 0) {
      addLog(`[RAW SLOTS] Odczytano łącznie ${summaryLines.length} surowych wolnych terminów z PWPW:\n` + summaryLines.slice(0, 15).join('\n') + (summaryLines.length > 15 ? `\n... oraz ${summaryLines.length - 15} wiecej` : ''));
    } else {
      addLog(`[RAW SLOTS] Serwer PWPW zwrócił 0 wolnych miejsc w żadnym z przesłanych ośrodków na najbliższe 30 dni.`);
    }
  }

  function getCategoryId(code) {
    if (typeof code === 'number') return code;
    const catMap = {
      "A": 1, "A1": 2, "A2": 3, "AM": 4, "B": 5, "B1": 6, "B+E": 7,
      "C": 8, "C1": 9, "C+E": 10, "C1+E": 11, "D": 12, "D1": 13,
      "D+E": 14, "D1+E": 15, "T": 16, "PT": 17
    };
    return catMap[code] || 5;
  }

  async function doPwpwRequest(orgChunk) {
    const payload = {
      startDate: new Date().toISOString().split('T')[0],
      organizationId: orgChunk,
      category: getCategoryId(config.category),
      profileNumber: (config.profile_number || '').replace(/\s+/g, ''),
      profileType: "Pkk"
    };

    const cookieStr = `__Secure-PUDOJT=${session.pudojt}; __Secure-PUDOJTMD=${session.pudojtmd || ''}`;
    const headers = {
      'Content-Type': 'application/json',
      'Cookie': cookieStr,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://info-kierowca.pl/reservation',
      'Origin': 'https://info-kierowca.pl'
    };

    const payloadLogStr = JSON.stringify(payload);
    addLog(`[POST REQ] PWPW Payload: ${payloadLogStr}`);

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      const res = await window.Capacitor.Plugins.CapacitorHttp.request({
        method: 'POST',
        url: PWPW_SEARCH_URL,
        headers: headers,
        data: payload
      });
      
      if (res.status !== 200) {
        const errDetail = typeof res.data === 'object' ? JSON.stringify(res.data) : (res.data || '');
        addLog(`[HTTP ERROR] Status ${res.status}: ${errDetail}`);
        throw new Error(`HTTP ${res.status} - ${errDetail || 'Bad Request'}`);
      }
      addLog(`[HTTP 200] PWPW Zwrocilo ${Array.isArray(res.data) ? res.data.length + ' ośrodków' : 'odpowiedź'}`);
      return res.data;
    } else {
      const res = await fetch(PWPW_SEARCH_URL, {
        method: 'POST',
        headers: headers,
        body: payloadLogStr
      });
      const textData = await res.text();
      if (!res.ok) {
        addLog(`[HTTP ERROR] Status ${res.status}: ${textData}`);
        throw new Error(`HTTP ${res.status} - ${textData}`);
      }
      addLog(`[HTTP 200] PWPW Zwrocilo odpowiedz.`);
      try { return JSON.parse(textData); } catch(e) { return []; }
    }
  }

  function filterSlots(rawResults) {
    const hits = [];
    const maxDate = config.current_slot_date ? new Date(config.current_slot_date + 'T23:59:59') : new Date('2099-12-31');
    const watchIds = new Set(config.organization_ids.map(id => Number(id)));
    const wantedType = config.exam_type || 'Practice';

    for (const word of rawResults) {
      const wordId = Number(word.wordId || word.organizationId);
      if (!watchIds.has(wordId)) continue; // Discard filler/unselected exam centers

      const wordName = word.wordName || getWordName(wordId);
      const exams = word.examCollectionForDay || [];

      if (exams.length > 0) {
        for (const exam of exams) {
          const examType = exam.examType; // 'Practice' / 'Theory' or 'Theoretical'
          if (wantedType === 'Practice' && examType !== 'Practice') continue;
          if (wantedType === 'Theory' && examType !== 'Theory' && examType !== 'Theoretical') continue;

          const dtStr = exam.practiceDateTime || exam.theoryDateTime;
          if (!dtStr) continue;

          const places = exam.placePracticeAmount || exam.placeTheoryAmount || 0;
          if (places <= 0) continue;

          const d = new Date(dtStr);
          const hour = d.getHours();

          if (hour < config.earliest_slot_hour || hour >= config.latest_slot_hour) continue;

          if (d <= maxDate) {
            hits.push({
              word: wordName,
              exam_type: examType === 'Practice' ? 'Praktyka' : 'Teoria',
              datetime: dtStr,
              places: places,
              rawDate: d
            });
          }
        }
      } else {
        const sched = word.schedule || {};
        const dtStr = word.practiceDateTime || word.theoryDateTime || sched.date;
        const places = word.placePracticeAmount || word.placeTheoryAmount || 0;

        if (dtStr && places > 0) {
          const d = new Date(dtStr);
          const hour = d.getHours();

          if (hour >= config.earliest_slot_hour && hour < config.latest_slot_hour && d <= maxDate) {
            hits.push({
              word: wordName,
              exam_type: wantedType === 'Practice' ? 'Praktyka' : 'Teoria',
              datetime: dtStr,
              places: places,
              rawDate: d
            });
          }
        }
      }
    }

    hits.sort((a, b) => a.rawDate - b.rawDate);
    return hits;
  }

  function prepareChunks(ids) {
    const wanted = [...new Set(ids.map(id => Number(id)))];
    const chunks = [];
    const SEARCH_ORG_ID_COUNT = 5;
    
    let fillerPool = wordCentersData
      .map(w => Number(w.id))
      .filter(id => !wanted.includes(id));

    for (let i = fillerPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [fillerPool[i], fillerPool[j]] = [fillerPool[j], fillerPool[i]];
    }

    for (let i = 0; i < wanted.length; i += SEARCH_ORG_ID_COUNT) {
      let chunk = wanted.slice(i, i + SEARCH_ORG_ID_COUNT);
      let poolIdx = 0;
      while (chunk.length < SEARCH_ORG_ID_COUNT && poolIdx < fillerPool.length) {
        const filler = fillerPool[poolIdx++];
        if (!chunk.includes(filler)) {
          chunk.push(filler);
        }
      }
      chunks.push(chunk);
    }
    return chunks;
  }

  async function triggerAlerts(slot) {
    const title = `Wolny termin: ${fmtDate(slot.datetime)}`;
    const body = `${slot.word} (${slot.exam_type}) - Miejsc: ${slot.places}`;

    if (navigator.vibrate) navigator.vibrate([500, 250, 500, 250, 500]);

    // Send Native Android System Notification
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
      try {
        await window.Capacitor.Plugins.LocalNotifications.schedule({
          notifications: [
            {
              title: title,
              body: body,
              id: 1,
              schedule: { at: new Date(Date.now() + 100) }
            }
          ]
        });
      } catch (e) {
        console.warn("Local notification error", e);
      }
    }

    // Send Remote Push via ntfy.sh if channel configured
    if (config.ntfy_channel) {
      fetch(`https://ntfy.sh/${config.ntfy_channel}`, {
        method: 'POST',
        headers: { 'Title': title, 'Priority': 'high' },
        body: body
      }).catch(e => console.warn("ntfy error", e));
    }
  }

  async function requestWakeLock() {
    if (!config.wakelock_enabled) return;
    try {
      if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
    } catch (e) {
      console.warn("Wakelock error", e);
    }
  }

  function startPollingLoop() {
    if (pollTimer) clearInterval(pollTimer);
    runCheck();
    pollTimer = setInterval(runCheck, Math.max(15, config.poll_interval_seconds) * 1000);
  }

  function startCountdownLoop() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      if (isPaused) {
        $('countdown').textContent = "Pauza";
        return;
      }
      if (nextCheckTimestamp) {
        const diff = Math.max(0, Math.round((nextCheckTimestamp - Date.now()) / 1000));
        const m = Math.floor(diff / 60);
        const s = diff % 60;
        $('countdown').textContent = `Następny sprawdzian za ${m}:${s < 10 ? '0' : ''}${s}`;
      }
      updateSessionExpiryDisplay();
    }, 1000);
  }

  function updateSessionExpiryDisplay() {
    if (!session.captured_at) {
      $('session-expiry').textContent = "Brak sesji";
      return;
    }
    const captured = new Date(session.captured_at).getTime();
    const expires = captured + (3600 * 1000);
    const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
    const leftMin = Math.floor(left / 60);

    if (leftMin <= 0) {
      $('session-expiry').textContent = "Sesja wygasła";
    } else {
      $('session-expiry').textContent = `Sesja wygasa za ~${leftMin} min`;
    }
  }

  // --- UI Handlers & Setup ---
  function initUI() {
    $('profile_number').value = config.profile_number || '';
    $('current_slot_date').value = config.current_slot_date || '';
    $('earliest_hour').value = config.earliest_slot_hour || 7;
    $('latest_hour').value = config.latest_slot_hour || 20;
    updateHoursLabel();

    $('auto_confirm_reschedule').checked = !!config.auto_confirm_reschedule;
    $('auto_select_slot').checked = !!config.auto_select_slot;
    $('auto_open_browser').checked = config.auto_open_browser !== false;
    $('wakelock_enabled').checked = config.wakelock_enabled !== false;
    $('poll_interval_seconds').value = config.poll_interval_seconds || 15;
    $('poll-interval-label').textContent = `co ${config.poll_interval_seconds || 15}s`;
    $('ntfy_channel').value = config.ntfy_channel || '';

    // Buttons
    $('kernelsu-fetch-btn').addEventListener('click', fetchCookiesViaKernelSu);
    $('session-refresh-btn').addEventListener('click', fetchCookiesViaKernelSu);
    $('open-chrome-btn').addEventListener('click', openChromeBrowser);

    $('save-manual-cookies-btn').addEventListener('click', () => {
      const p1 = $('cookie-pudojt').value;
      const p2 = $('cookie-pudojtmd').value;
      if (!p1) { alert("Wprowadź __Secure-PUDOJT"); return; }
      saveSession(p1, p2);
      alert("Zapisano sesję.");
      runCheck();
    });

    $('pause-btn').addEventListener('click', () => {
      isPaused = !isPaused;
      $('icon-pause').style.display = isPaused ? 'none' : 'block';
      $('icon-play').style.display = isPaused ? 'block' : 'none';
      updateStatusUI();
    });

    // Dual-thumb hour slider handlers (bidirectional control)
    $('earliest_hour').addEventListener('input', () => {
      let eVal = parseInt($('earliest_hour').value);
      let lVal = parseInt($('latest_hour').value);
      if (eVal >= lVal) {
        $('earliest_hour').value = lVal - 1;
      }
      updateHoursLabel();
    });

    $('latest_hour').addEventListener('input', () => {
      let eVal = parseInt($('earliest_hour').value);
      let lVal = parseInt($('latest_hour').value);
      if (lVal <= eVal) {
        $('latest_hour').value = eVal + 1;
      }
      updateHoursLabel();
    });

    // Poll interval slider handler
    $('poll_interval_seconds').addEventListener('input', (e) => {
      $('poll-interval-label').textContent = `co ${e.target.value}s`;
    });

    // Exam Type Pills
    $('pill-practice').addEventListener('click', () => {
      config.exam_type = 'Practice';
      $('pill-practice').classList.add('active');
      $('pill-theory').classList.remove('active');
    });
    $('pill-theory').addEventListener('click', () => {
      config.exam_type = 'Theory';
      $('pill-theory').classList.add('active');
      $('pill-practice').classList.remove('active');
    });

    // Category Pills
    const catPills = document.querySelectorAll('.cat-pill');
    catPills.forEach(btn => {
      btn.addEventListener('click', () => {
        catPills.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        config.category = btn.dataset.cat;
      });
    });

    $('test-push-btn').addEventListener('click', () => {
      const ch = $('ntfy_channel').value.trim();
      if (!ch) { alert("Wprowadź nazwę kanału ntfy"); return; }
      fetch(`https://ntfy.sh/${ch}`, {
        method: 'POST',
        headers: { 'Title': 'Test Notifiera', 'Priority': 'high' },
        body: 'Powiadomienie testowe z info-kierowca notifier'
      }).then(() => alert("Wysłano powiadomienie testowe na ntfy.sh")).catch(e => alert("Błąd: " + e.message));
    });

    // Form Submit
    $('wiz-form').addEventListener('submit', (e) => {
      e.preventDefault();
      saveConfig({
        profile_number: $('profile_number').value,
        current_slot_date: $('current_slot_date').value,
        earliest_slot_hour: parseInt($('earliest_hour').value) || 7,
        latest_slot_hour: parseInt($('latest_hour').value) || 20,
        auto_confirm_reschedule: $('auto_confirm_reschedule').checked,
        auto_select_slot: $('auto_select_slot').checked,
        auto_open_browser: $('auto_open_browser').checked,
        wakelock_enabled: $('wakelock_enabled').checked,
        poll_interval_seconds: parseInt($('poll_interval_seconds').value) || 15,
        ntfy_channel: $('ntfy_channel').value.trim()
      });
      alert("Zapisano ustawienia.");
      startPollingLoop();
    });

    setupWordSearch();
  }

  function updateHoursLabel() {
    const e = parseInt($('earliest_hour').value) || 7;
    const l = parseInt($('latest_hour').value) || 20;
    const fmt = h => (h < 10 ? '0' : '') + h + ':00';
    $('hours-range-label').textContent = `${fmt(e)} – ${fmt(l)}`;

    // Update Track Highlight
    const min = 6, max = 22;
    const leftPct = ((e - min) / (max - min)) * 100;
    const rightPct = 100 - (((l - min) / (max - min)) * 100);
    const track = $('dual-track');
    if (track) {
      track.style.background = `linear-gradient(to right, #232730 ${leftPct}%, #4e8e66 ${leftPct}%, #4e8e66 ${100 - rightPct}%, #232730 ${100 - rightPct}%)`;
    }
  }

  function setupWordSearch() {
    const input = $('center-search');
    const dropdown = $('center-dropdown');

    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      if (!q) { dropdown.style.display = 'none'; return; }
      const matches = wordCentersData.filter(w =>
        w.name.toLowerCase().includes(q) || (w.location && w.location.toLowerCase().includes(q))
      ).slice(0, 8);

      if (matches.length === 0) {
        dropdown.innerHTML = '<div>Brak wyników</div>';
      } else {
        dropdown.innerHTML = matches.map(w => `
          <div data-id="${w.id}">${w.name} <small style="opacity:0.5">${w.location || ''}</small></div>
        `).join('');
      }
      dropdown.style.display = 'block';
    });

    dropdown.addEventListener('click', (e) => {
      const div = e.target.closest('div[data-id]');
      if (div) {
        const id = parseInt(div.dataset.id);
        if (!config.organization_ids.includes(id)) {
          config.organization_ids.push(id);
          saveConfig({ organization_ids: config.organization_ids });
          renderSelectedCenters();
        }
        dropdown.style.display = 'none';
        input.value = '';
      }
    });

    renderSelectedCenters();
  }

  function renderSelectedCenters() {
    const container = $('selected-centers');
    if (!config.organization_ids || config.organization_ids.length === 0) {
      container.innerHTML = '<div class="empty-words-hint">Brak wybranych ośrodków. Wpisz miasto powyżej, aby dodać.</div>';
      return;
    }
    container.innerHTML = config.organization_ids.map(id => `
      <div class="selected-center-row">
        <span>${getWordName(id)}</span>
        <span class="remove-btn" onclick="removeCenter(${id})">&times;</span>
      </div>
    `).join('');
  }

  window.removeCenter = function (id) {
    config.organization_ids = config.organization_ids.filter(x => x !== id);
    saveConfig({ organization_ids: config.organization_ids });
    renderSelectedCenters();
  };

  function updateStatusUI() {
    const badge = $('session-badge');
    if (session.pudojt) {
      badge.textContent = "Aktywna";
      badge.className = "badge active";
      $('cookie-pudojt').value = session.pudojt;
      $('cookie-pudojtmd').value = session.pudojtmd || '';
    } else {
      badge.textContent = "Nieaktywna";
      badge.className = "badge";
    }
  }

  function setUIState(type, headlineText, sublineText) {
    $('headline').textContent = headlineText;
    $('subline').textContent = sublineText;
    const dot = $('status-dot');

    if (type === 'hit') {
      dot.className = 'status-dot error';
      $('hits-container').style.display = 'block';
      renderHits();
    } else if (type === 'error') {
      dot.className = 'status-dot error';
    } else {
      dot.className = 'status-dot';
      $('hits-container').style.display = 'none';
    }
  }

  function renderHits() {
    $('hits-container').innerHTML = currentHits.map(h => `
      <div class="hit-item" style="cursor:pointer;" onclick="openChromeBrowser('https://info-kierowca.pl/reservation')">
        <div class="hi-title">${fmtDate(h.datetime)}</div>
        <div class="hi-sub">${h.word} (${h.exam_type}) · Wolnych miejsc: ${h.places}</div>
        <div style="margin-top:6px; font-size:12px; color:#4e8e66; font-weight:600;">Przejdz do rezerwacji w Chrome ➔</div>
      </div>
    `).join('');
  }

  function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    historyLogs.unshift({ time, msg });
    if (historyLogs.length > 50) historyLogs.pop();

    $('history').innerHTML = historyLogs.map(l => `
      <div class="history-item">
        <span class="ts">${l.time}</span>
        <span>${l.msg}</span>
      </div>
    `).join('');
  }

  function getWordName(id) {
    const found = wordCentersData.find(w => w.id === id);
    return found ? found.name : `WORD ID ${id}`;
  }

  function getCentersSummary() {
    if (!config.organization_ids || config.organization_ids.length === 0) {
      return "Brak wybranych ośrodków WORD";
    }
    return `Monitoruję ${config.organization_ids.length} ośrodków WORD`;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('pl-PL', {
      weekday: 'short', day: '2-digit', month: 'short',
      year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

})();
