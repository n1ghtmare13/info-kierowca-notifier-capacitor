/**
 * Info-Kierowca Notifier Engine - Complete Port
 */

(function () {
  'use strict';

  const PWPW_SEARCH_URL = "https://info-kierowca.pl/bknd/exam/api/v1/Schedules/user/MultipleCentersExams";

  const DEFAULT_CONFIG = {
    profile_number: "",
    category: "B",
    exam_type: "Practice",
    organization_ids: [25, 26, 27, 28, 29],
    current_slot_date: "2026-09-02",
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
  let wordCentersData = [];

  const $ = id => document.getElementById(id);

  document.addEventListener('DOMContentLoaded', async () => {
    await loadReferenceData();
    initUI();
    updateStatusUI();
    requestWakeLock();
    startPollingLoop();
  });

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

  // --- Automatic Cookie Capturing ---
  async function launchInAppLogin() {
    const loginUrl = "https://info-kierowca.pl/login";
    addLog("Uruchamiam wbudowane okno logowania mObywatel...");

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      await window.Capacitor.Plugins.Browser.open({ url: loginUrl });
    } else {
      window.open(loginUrl, '_blank');
    }
  }

  async function fetchCookiesViaRoot() {
    addLog("Próba odczytu bazy danych Chrome (Root su)...");
    alert("Funkcja Root: Na zrootowanym telefonie skrypt pobiera bazę SQLite z /data/data/com.android.chrome. Upewnij się, że przyznasz uprawnienia SU dla Termuxa/Apki.");
  }

  // --- Main Search Check ---
  async function runCheck() {
    if (isPaused) return;

    if (!session.pudojt) {
      setUIState("error", "Brak aktywnej sesji", "Zaloguj się mObywatelem w sekcji powyżej.");
      return;
    }

    setUIState("scanning", "Sprawdzam terminy...", getCentersSummary());

    try {
      const chunks = prepareChunks(config.organization_ids);
      let allSlots = [];

      for (let i = 0; i < chunks.length; i++) {
        const raw = await doPwpwRequest(chunks[i]);
        if (Array.isArray(raw)) allSlots = allSlots.concat(raw);
        if (i < chunks.length - 1) await sleep(1200);
      }

      const matchingHits = filterSlots(allSlots);

      if (matchingHits.length > 0) {
        currentHits = matchingHits;
        const fastest = matchingHits[0];
        const dateStr = fmtDate(fastest.datetime);

        setUIState("hit", `Znaleziono: ${dateStr}!`, `${fastest.word} (${fastest.places} wolne miejsca)`);
        addLog(`HIT: ${dateStr} · ${fastest.word}`);

        triggerAlerts(fastest);
      } else {
        currentHits = [];
        setUIState("scanning", "Brak wcześniejszych terminów", `Ostatni sprawdzian: ${new Date().toLocaleTimeString()}`);
        addLog(`Sprawdzono. Brak terminów przed ${config.current_slot_date}`);
      }

    } catch (err) {
      setUIState("error", "Błąd połączenia / Sesja wygasła", err.message);
      addLog(`Błąd: ${err.message}`);
    }
  }

  async function doPwpwRequest(orgChunk) {
    const payload = {
      startDate: new Date().toISOString().split('T')[0],
      organizationId: orgChunk,
      category: config.category,
      profileNumber: config.profile_number.replace(/\s+/g, ''),
      profileType: "Pkk"
    };

    const cookieStr = `__Secure-PUDOJT=${session.pudojt}; __Secure-PUDOJTMD=${session.pudojtmd || ''}`;

    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
      const res = await window.Capacitor.Plugins.CapacitorHttp.request({
        method: 'POST',
        url: PWPW_SEARCH_URL,
        headers: { 'Content-Type': 'application/json', 'Cookie': cookieStr },
        data: payload
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return res.data;
    } else {
      const res = await fetch(PWPW_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': cookieStr },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }
  }

  function filterSlots(rawSlots) {
    const hits = [];
    const maxDate = new Date(config.current_slot_date + 'T23:59:59');

    for (const item of rawSlots) {
      const sched = item.schedule || {};
      const dateStr = sched.date;
      const count = item.placePracticeAmount || item.placeTheoryAmount || 0;

      if (!dateStr || count <= 0) continue;

      const d = new Date(dateStr);
      const hour = d.getHours();

      // Hour range filter
      if (hour < config.earliest_slot_hour || hour > config.latest_slot_hour) {
        continue;
      }

      if (d < maxDate) {
        hits.push({
          word: getWordName(item.organizationId),
          datetime: dateStr,
          places: count,
          rawDate: d
        });
      }
    }

    hits.sort((a, b) => a.rawDate - b.rawDate);
    return hits;
  }

  function prepareChunks(ids) {
    const wanted = [...new Set(ids)];
    const chunks = [];
    const pool = wordCentersData.map(w => w.id).filter(id => !wanted.includes(id));

    for (let i = 0; i < wanted.length; i += 5) {
      let chunk = wanted.slice(i, i + 5);
      while (chunk.length < 5 && pool.length > 0) {
        chunk.push(pool[Math.floor(Math.random() * pool.length)]);
      }
      chunks.push(chunk);
    }
    return chunks.length > 0 ? chunks : [[25, 26, 27, 28, 29]];
  }

  function triggerAlerts(slot) {
    const title = `Wolny termin: ${fmtDate(slot.datetime)}`;
    const body = `${slot.word} (${slot.places} wolne miejsca)`;

    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);

    if (config.ntfy_channel) {
      fetch(`https://ntfy.sh/${config.ntfy_channel}`, {
        method: 'POST',
        headers: { 'Title': title, 'Priority': 'high' },
        body: body
      }).catch(e => console.warn("ntfy push error", e));
    }
  }

  async function requestWakeLock() {
    if (!config.wakelock_enabled) return;
    try {
      if ('wakeLock' in navigator) {
        await navigator.wakeLock.request('screen');
      }
    } catch (e) {
      console.warn("Wakelock error", e);
    }
  }

  function startPollingLoop() {
    if (pollTimer) clearInterval(pollTimer);
    runCheck();
    pollTimer = setInterval(runCheck, Math.max(15, config.poll_interval_seconds) * 1000);
  }

  // --- UI Handlers ---
  function initUI() {
    $('set-pkk').value = config.profile_number || '';
    $('set-category').value = config.category || 'B';
    $('set-exam-type').value = config.exam_type || 'Practice';
    $('set-max-date').value = config.current_slot_date || '2026-09-02';
    $('set-earliest-hour').value = config.earliest_slot_hour || 7;
    $('set-latest-hour').value = config.latest_slot_hour || 20;
    $('set-auto-confirm').checked = !!config.auto_confirm_reschedule;
    $('set-auto-select').checked = !!config.auto_select_slot;
    $('set-auto-open').checked = config.auto_open_browser !== false;
    $('set-wakelock').checked = config.wakelock_enabled !== false;
    $('set-ntfy').value = config.ntfy_channel || '';
    $('set-interval').value = config.poll_interval_seconds || 15;

    $('auto-login-btn').addEventListener('click', launchInAppLogin);
    $('root-fetch-btn').addEventListener('click', fetchCookiesViaRoot);

    $('save-manual-cookies').addEventListener('click', () => {
      const p1 = $('cookie-pudojt').value;
      const p2 = $('cookie-pudojtmd').value;
      if (!p1) { alert("Wprowadź ciasteczko __Secure-PUDOJT"); return; }
      saveSession(p1, p2);
      alert("Zapisano sesję. Uruchamiam sprawdzanie.");
      runCheck();
    });

    $('pause-btn').addEventListener('click', () => {
      isPaused = !isPaused;
      $('pause-text').textContent = isPaused ? "Wznów" : "Pauza";
      updateStatusUI();
    });

    $('config-form').addEventListener('submit', (e) => {
      e.preventDefault();
      saveConfig({
        profile_number: $('set-pkk').value,
        category: $('set-category').value,
        exam_type: $('set-exam-type').value,
        current_slot_date: $('set-max-date').value,
        earliest_slot_hour: parseInt($('set-earliest-hour').value) || 7,
        latest_slot_hour: parseInt($('set-latest-hour').value) || 20,
        auto_confirm_reschedule: $('set-auto-confirm').checked,
        auto_select_slot: $('set-auto-select').checked,
        auto_open_browser: $('set-auto-open').checked,
        wakelock_enabled: $('set-wakelock').checked,
        ntfy_channel: $('set-ntfy').value,
        poll_interval_seconds: parseInt($('set-interval').value) || 15
      });
      alert("Zapisano ustawienia.");
      startPollingLoop();
    });

    setupWordSearch();
  }

  function setupWordSearch() {
    const input = $('word-search-input');
    const dropdown = $('word-dropdown-results');

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
          renderWordTags();
        }
        dropdown.style.display = 'none';
        input.value = '';
      }
    });

    renderWordTags();
  }

  function renderWordTags() {
    const container = $('selected-words-tags');
    container.innerHTML = config.organization_ids.map(id => `
      <span class="tag">
        ${getWordName(id)}
        <span class="remove" onclick="removeTag(${id})">&times;</span>
      </span>
    `).join('');
  }

  window.removeTag = function (id) {
    config.organization_ids = config.organization_ids.filter(x => x !== id);
    saveConfig({ organization_ids: config.organization_ids });
    renderWordTags();
  };

  function updateStatusUI() {
    const indicator = $('session-indicator');
    if (session.pudojt) {
      indicator.textContent = "Aktywna";
      indicator.className = "status-indicator active";
    } else {
      indicator.textContent = "Nieaktywna";
      indicator.className = "status-indicator";
    }
  }

  function setUIState(type, headline, subline) {
    $('main-headline').textContent = headline;
    $('main-subline').textContent = subline;
    const dot = $('status-dot');

    if (type === 'hit') {
      dot.className = 'pulse-dot error';
      $('status-tag').textContent = 'ZNALAZŁEM TERMIN!';
      $('hits-container').style.display = 'block';
      renderHits();
    } else if (type === 'error') {
      dot.className = 'pulse-dot error';
      $('status-tag').textContent = 'BŁĄD';
    } else {
      dot.className = 'pulse-dot';
      $('status-tag').textContent = 'SKANOWANIE';
      $('hits-container').style.display = 'none';
    }
  }

  function renderHits() {
    $('hits-container').innerHTML = currentHits.map(h => `
      <div class="hit-row">
        <div class="title">${fmtDate(h.datetime)}</div>
        <div class="sub">${h.word} (miejsc: ${h.places})</div>
      </div>
    `).join('');
  }

  function addLog(msg) {
    const time = new Date().toLocaleTimeString();
    historyLogs.unshift({ time, msg });
    if (historyLogs.length > 50) historyLogs.pop();

    $('history-box').innerHTML = historyLogs.map(l => `
      <div class="log-item">
        <span class="time">${l.time}</span>
        <span>${l.msg}</span>
      </div>
    `).join('');
  }

  function getWordName(id) {
    const found = wordCentersData.find(w => w.id === id);
    return found ? found.name : `WORD ID ${id}`;
  }

  function getCentersSummary() {
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
