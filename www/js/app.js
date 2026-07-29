/**
 * Info-Kierowca Notifier - Capacitor Mobile Engine (JavaScript Port)
 */

(function () {
  'use strict';

  // --- Constants & Defaults ---
  const PWPW_SEARCH_URL = "https://info-kierowca.pl/bknd/exam/api/v1/Schedules/user/MultipleCentersExams";
  const DEFAULT_CONFIG = {
    profile_number: "",
    category: "B",
    exam_type: "Practice",
    organization_ids: [25, 26, 27, 28, 29], // Default Warsaw WORD centers
    current_slot_date: "2026-09-02",
    poll_interval_seconds: 15,
    ntfy_channel: "",
    audio_alarm: true,
    wakelock_enabled: true
  };

  // State Variables
  let config = loadConfig();
  let session = loadSession();
  let history = [];
  let currentHits = [];
  let isPaused = false;
  let pollTimer = null;
  let wakeLockObj = null;
  let wordCentersData = [];

  // --- DOM Elements ---
  const $ = id => document.getElementById(id);

  // --- Initialization ---
  document.addEventListener('DOMContentLoaded', async () => {
    await loadReferenceData();
    initUI();
    updateStatusUI();
    requestWakeLock();
    startPollingLoop();
  });

  // --- Data & Storage Handlers ---
  function loadConfig() {
    try {
      const saved = localStorage.getItem('ikw_mobile_config');
      return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG };
    } catch (e) {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(cfg) {
    config = { ...config, ...cfg };
    localStorage.setItem('ikw_mobile_config', JSON.stringify(config));
  }

  function loadSession() {
    try {
      const saved = localStorage.getItem('ikw_mobile_session');
      return saved ? JSON.parse(saved) : { pudojt: "", pudojtmd: "", captured_at: null };
    } catch (e) {
      return { pudojt: "", pudojtmd: "", captured_at: null };
    }
  }

  function saveSession(pudojt, pudojtmd) {
    session = {
      pudojt: pudojt.trim(),
      pudojtmd: pudojtmd.trim(),
      captured_at: new Date().toISOString()
    };
    localStorage.setItem('ikw_mobile_session', JSON.stringify(session));
    updateStatusUI();
  }

  async function loadReferenceData() {
    try {
      const res = await fetch('js/word_centers.json');
      wordCentersData = await res.json();
    } catch (e) {
      console.warn("Could not load word_centers.json reference file", e);
    }
  }

  // --- PWPW Network Requests ---
  async function doPwpwSearch(orgChunk) {
    if (!session.pudojt) {
      throw new Error("Brak ciasteczka sesji __Secure-PUDOJT");
    }

    const payload = {
      startDate: new Date().toISOString().split('T')[0],
      organizationId: orgChunk,
      category: config.category,
      profileNumber: config.profile_number.replace(/\s+/g, ''),
      profileType: "Pkk"
    };

    const cookieHeader = `__Secure-PUDOJT=${session.pudojt}; __Secure-PUDOJTMD=${session.pudojtmd || ''}`;

    // Capacitor Native HTTP fallback / Browser Fetch
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      const response = await window.Capacitor.Plugins.CapacitorHttp.request({
        method: 'POST',
        url: PWPW_SEARCH_URL,
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieHeader
        },
        data: payload
      });
      if (response.status !== 200) {
        throw new Error(`PWPW Błąd HTTP ${response.status}`);
      }
      return response.data;
    } else {
      const response = await fetch(PWPW_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieHeader
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`PWPW Błąd HTTP ${response.status}`);
      }
      return await response.json();
    }
  }

  // --- Main Search Polling Loop ---
  async function runCheck() {
    if (isPaused) return;

    if (!session.pudojt) {
      setUIState("error", "Brak aktywnej sesji", "Wklej ciasteczka mObywatel w sekcji poniżej.", "Wprowadź sesję");
      return;
    }

    setUIState("scanning", "Sprawdzam terminy...", getSelectedCentersSummary(), "Skanowanie serwera PWPW");

    try {
      const chunks = prepareOrgChunks(config.organization_ids);
      let allSlots = [];

      for (let i = 0; i < chunks.length; i++) {
        const rawResults = await doPwpwSearch(chunks[i]);
        if (Array.isArray(rawResults)) {
          allSlots = allSlots.concat(rawResults);
        }
        if (i < chunks.length - 1) {
          await sleep(1500); // 1.5s pause between chunks for IP safety
        }
      }

      // Process and filter slots
      const matchingHits = processAndFilterSlots(allSlots);

      if (matchingHits.length > 0) {
        currentHits = matchingHits;
        const fastest = matchingHits[0];
        const dateStr = fmtDate(fastest.datetime);
        setUIState("hit", `Znaleziono: ${dateStr}!`, `${fastest.word} · ${fastest.places} wolne miejsca`, "SUKCES");

        addHistoryLog(`🎉 HIT: ${dateStr} · ${fastest.word}`);
        triggerSlotFoundAlert(fastest);
      } else {
        currentHits = [];
        setUIState("scanning", "Brak wcześniejszych terminów", `Ostatnio sprawdzono: ${new Date().toLocaleTimeString()}`, "Szukam...");
        addHistoryLog(`Sprawdzono. Brak terminów przed ${config.current_slot_date}`);
      }

    } catch (err) {
      console.error("Poller check error:", err);
      setUIState("error", "Błąd połączenia / Wygasła sesja", err.message, "BŁĄD");
      addHistoryLog(`⚠️ Błąd: ${err.message}`);
    }
  }

  function prepareOrgChunks(orgIds) {
    const wanted = [...new Set(orgIds)];
    const chunks = [];
    const allIds = wordCentersData.map(w => w.id).filter(id => !wanted.includes(id));

    for (let i = 0; i < wanted.length; i += 5) {
      let chunk = wanted.slice(i, i + 5);
      while (chunk.length < 5 && allIds.length > 0) {
        chunk.push(allIds[Math.floor(Math.random() * allIds.length)]);
      }
      chunks.push(chunk);
    }
    return chunks.length > 0 ? chunks : [[25, 26, 27, 28, 29]];
  }

  function processAndFilterSlots(rawSlots) {
    const hits = [];
    const maxDate = new Date(config.current_slot_date + 'T23:59:59');

    for (const item of rawSlots) {
      const schedule = item.schedule || {};
      const dateStr = schedule.date;
      const placeCount = item.placePracticeAmount || item.placeTheoryAmount || 0;

      if (!dateStr || placeCount <= 0) continue;

      const slotDate = new Date(dateStr);
      if (slotDate < maxDate) {
        const centerName = getWordName(item.organizationId);
        hits.push({
          word: centerName,
          datetime: dateStr,
          places: placeCount,
          rawDate: slotDate
        });
      }
    }

    hits.sort((a, b) => a.rawDate - b.rawDate);
    return hits;
  }

  // --- Alerts & Notifications (Sound / Vibration / Push / LocalNotif) ---
  function triggerSlotFoundAlert(slot) {
    const title = `🚨 SZYBSZY TERMIN EGZAMINU!`;
    const body = `${fmtDate(slot.datetime)} w ${slot.word} (${slot.places} miejsca)`;

    // 1. Audio Synthesizer Beep Alarm
    if (config.audio_alarm) {
      playLoudAlarmSound();
    }

    // 2. Device Vibration
    if (navigator.vibrate) {
      navigator.vibrate([500, 250, 500, 250, 800]);
    }

    // 3. ntfy.sh Push Alert
    if (config.ntfy_channel) {
      fetch(`https://ntfy.sh/${config.ntfy_channel}`, {
        method: 'POST',
        headers: { 'Title': title, 'Priority': 'high' },
        body: body
      }).catch(e => console.warn("ntfy push error", e));
    }

    // 4. Capacitor Native Local Notification
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
      window.Capacitor.Plugins.LocalNotifications.schedule({
        notifications: [{
          title: title,
          body: body,
          id: Math.floor(Math.random() * 10000),
          schedule: { at: new Date(Date.now() + 100) }
        }]
      });
    }
  }

  function playLoudAlarmSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const playBeep = (freq, duration, delay) => {
        setTimeout(() => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.value = 0.8;
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + duration);
        }, delay);
      };
      playBeep(880, 0.2, 0);
      playBeep(1100, 0.2, 250);
      playBeep(1320, 0.4, 500);
    } catch (e) {
      console.warn("Audio alarm play error", e);
    }
  }

  // --- 24/7 Wakelock & Background Execution ---
  async function requestWakeLock() {
    if (!config.wakelock_enabled) return;
    try {
      if ('wakeLock' in navigator) {
        wakeLockObj = await navigator.wakeLock.request('screen');
        console.log("WakeLock active - phone CPU will remain active when screen turns off");
      }
    } catch (err) {
      console.warn("WakeLock error:", err);
    }
  }

  function startPollingLoop() {
    if (pollTimer) clearInterval(pollTimer);
    runCheck();
    pollTimer = setInterval(runCheck, Math.max(15, config.poll_interval_seconds) * 1000);
  }

  // --- UI Update Handlers ---
  function initUI() {
    // Populate Form Inputs
    $('set-pkk').value = config.profile_number || '';
    $('set-category').value = config.category || 'B';
    $('set-current-date').value = config.current_slot_date || '2026-09-02';
    $('set-poll-interval').value = config.poll_interval_seconds || 15;
    $('set-ntfy-channel').value = config.ntfy_channel || '';
    $('set-audio-alarm').checked = config.audio_alarm !== false;
    $('set-wakelock').checked = config.wakelock_enabled !== false;

    if (session.pudojt) {
      $('cookie-pudojt').value = session.pudojt;
      $('cookie-pudojtmd').value = session.pudojtmd || '';
    }

    // Event Listeners
    $('save-session-btn').addEventListener('click', () => {
      const p1 = $('cookie-pudojt').value;
      const p2 = $('cookie-pudojtmd').value;
      if (!p1) {
        alert("Wklej wartość ciasteczka __Secure-PUDOJT!");
        return;
      }
      saveSession(p1, p2);
      alert("Sesja została pomyślnie zapisana! Uruchamiam poller.");
      runCheck();
    });

    $('toggle-pause-btn').addEventListener('click', () => {
      isPaused = !isPaused;
      $('icon-pause').style.display = isPaused ? 'none' : 'block';
      $('icon-play').style.display = isPaused ? 'block' : 'none';
      updateStatusUI();
    });

    $('nav-settings').addEventListener('click', () => {
      $('settings-modal').style.display = 'flex';
      renderSelectedWords();
    });

    $('close-settings-btn').addEventListener('click', () => {
      $('settings-modal').style.display = 'none';
    });

    $('nav-sound-test').addEventListener('click', () => {
      playLoudAlarmSound();
      if (navigator.vibrate) navigator.vibrate([300, 100, 300]);
      alert("Próbka alarmu dźwiekowego i wibracji odtworzona!");
    });

    $('settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      saveConfig({
        profile_number: $('set-pkk').value,
        category: $('set-category').value,
        current_slot_date: $('set-current-date').value,
        poll_interval_seconds: parseInt($('set-poll-interval').value) || 15,
        ntfy_channel: $('set-ntfy-channel').value,
        audio_alarm: $('set-audio-alarm').checked,
        wakelock_enabled: $('set-wakelock').checked
      });
      $('settings-modal').style.display = 'none';
      startPollingLoop();
      alert("Ustawienia zostały zapisane!");
    });

    // Word Search Combobox Setup
    setupWordSearch();
  }

  function setupWordSearch() {
    const searchInput = $('word-search');
    const dropdown = $('word-dropdown');

    searchInput.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase().trim();
      if (!query) {
        dropdown.style.display = 'none';
        return;
      }
      const matches = wordCentersData.filter(w => 
        w.name.toLowerCase().includes(query) || (w.location && w.location.toLowerCase().includes(query))
      ).slice(0, 10);

      if (matches.length === 0) {
        dropdown.innerHTML = '<div class="dropdown-item">Brak wyników</div>';
      } else {
        dropdown.innerHTML = matches.map(w => `
          <div class="dropdown-item" data-id="${w.id}">
            <span>${w.name}</span>
            <span style="opacity:0.5">${w.location || ''}</span>
          </div>
        `).join('');
      }
      dropdown.style.display = 'block';
    });

    dropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.dropdown-item');
      if (item && item.dataset.id) {
        const id = parseInt(item.dataset.id);
        if (!config.organization_ids.includes(id)) {
          config.organization_ids.push(id);
          saveConfig({ organization_ids: config.organization_ids });
          renderSelectedWords();
        }
        dropdown.style.display = 'none';
        searchInput.value = '';
      }
    });
  }

  function renderSelectedWords() {
    const container = $('selected-words');
    if (!config.organization_ids || config.organization_ids.length === 0) {
      container.innerHTML = '<div class="field-hint">Brak wybranych WORD-ów.</div>';
      return;
    }
    container.innerHTML = config.organization_ids.map(id => {
      const name = getWordName(id);
      return `
        <div class="word-chip">
          <span>${name}</span>
          <span class="remove" onclick="removeWord(${id})">&times;</span>
        </div>
      `;
    }).join('');
  }

  window.removeWord = function (id) {
    config.organization_ids = config.organization_ids.filter(x => x !== id);
    saveConfig({ organization_ids: config.organization_ids });
    renderSelectedWords();
  };

  function updateStatusUI() {
    if (session.pudojt) {
      $('session-status-badge').textContent = 'Aktywna';
      $('session-status-badge').className = 'badge active';
      $('session-val').textContent = session.captured_at ? fmtDate(session.captured_at) : 'Załadowana';
    } else {
      $('session-status-badge').textContent = 'Brak sesji';
      $('session-status-badge').className = 'badge';
      $('session-val').textContent = 'Wklej ciasteczka';
    }
  }

  function setUIState(type, headline, subline, badgeText) {
    $('status-headline').textContent = headline;
    $('status-subline').textContent = subline;
    $('status-badge').textContent = badgeText;

    const pulse = $('status-pulse');
    if (type === 'hit') {
      pulse.className = 'status-pulse';
      $('status-badge').style.background = 'var(--danger)';
      $('hits-card').style.display = 'block';
      renderHitsList();
    } else if (type === 'error') {
      pulse.className = 'status-pulse error';
    } else {
      pulse.className = 'status-pulse';
      $('hits-card').style.display = 'none';
    }
  }

  function renderHitsList() {
    const list = $('hits-list');
    list.innerHTML = currentHits.map(h => `
      <div class="hit-item">
        <div class="hit-title">📅 ${fmtDate(h.datetime)}</div>
        <div class="hit-sub">📍 ${h.word} (Wolne miejsca: ${h.places})</div>
      </div>
    `).join('');
  }

  function addHistoryLog(msg) {
    const ts = new Date().toLocaleTimeString();
    history.unshift({ ts, msg });
    if (history.length > 50) history.pop();

    const list = $('history-list');
    list.innerHTML = history.map(item => `
      <div class="history-item">
        <span class="ts">${item.ts}</span>
        <span>${item.msg}</span>
      </div>
    `).join('');
  }

  // --- Helper Functions ---
  function getWordName(id) {
    const found = wordCentersData.find(w => w.id === id);
    return found ? found.name : `WORD ID: ${id}`;
  }

  function getSelectedCentersSummary() {
    if (config.organization_ids.length === 1) {
      return getWordName(config.organization_ids[0]);
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
    return new Promise(resolve => setTimeout(resolve, ms));
  }

})();
