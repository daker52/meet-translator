(() => {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  const SPEECH_LANG_MAP = {
    en: 'en-US',
    cs: 'cs-CZ',
    de: 'de-DE',
    sk: 'sk-SK',
    es: 'es-ES',
    fr: 'fr-FR',
  };

  const CAPTION_REGION_LABEL =
    /caption|titulk|titulky|živé|zive|live|sous-titre|untertitel|leyenda|subtit|字幕/i;
  const CAPTION_LINE_SELECTORS = [
    '[jsname="YSxPC"] span',
    '[jsname="YSxPC"]',
    '[data-message-text]',
    '.a4cQT',
    '.iOzk7',
  ];
  const LANGUAGE_DUMP_RE =
    /(\bBETA\b|\bBeta\b|afrikánština|afrikaans|albánština|amharština|arménština|jazyk schůzky|font size|open settings|otevřít nastavení|velikost písma|language of the meeting|přejít dolů|go down|skip to bottom|subtitles by|created by|titulky vytvořil|vytvořil|johnyx|blogspot\.com|hradeckesluzby\.cz|amara\.org|opensubtitles)/i;
  const OUR_ROOT_IDS = ['meet-translator-panel', 'meet-translator-live', 'meet-translator-toggle'];

  const DEBOUNCE_MS = 120;
  const MIN_CHARS = 3;

  let active = false;
  let mode = 'captions';
  let settings = {
    sourceLang: 'en',
    targetLang: 'cs',
    model: MT_DEFAULT_MODEL,
    engine: 'auto',
  };

  let recognition = null;
  let captionObserver = null;
  let captionPollTimer = null;
  let captionRegion = null;
  let lastCaptionText = '';
  let lastSpeechText = '';
  let lastTabAudioText = '';
  let pendingTranslate = null;
  let translateRequestId = 0;
  let streamPort = null;
  let chromeTranslator = null;
  let chromeTranslatorReady = false;

  let translatedPrefix = '';
  let translatedDisplay = '';
  let lastHistoryLine = '';
  let currentTranslateOptions = { fullReplace: true };

  const overlay = createOverlay();
  document.body.appendChild(overlay.root);
  document.body.appendChild(overlay.liveBar);
  document.body.appendChild(overlay.toggleBtn);

  initDraggableLiveBar();
  loadSettings();
  initStreamPort();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'TAB_AUDIO_TRANSCRIPT' && active && mode === 'tabaudio') {
      handleTranscript(message.text, message.final, 'tabaudio');
    }
    if (message?.type === 'TAB_AUDIO_ERROR' && active && mode === 'tabaudio') {
      setStatus(`STT: ${message.error}`, 'error');
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sourceLang) {
      settings.sourceLang = changes.sourceLang.newValue;
      resetTranslator();
    }
    if (changes.targetLang) {
      settings.targetLang = changes.targetLang.newValue;
      resetTranslator();
    }
    if (changes.engine) {
      settings.engine = changes.engine.newValue;
      resetTranslator();
    }
    if (changes.model) {
      settings.model = mtIsValidModel(changes.model.newValue)
        ? changes.model.newValue
        : MT_DEFAULT_MODEL;
      if (overlay.modelSelect) {
        overlay.modelSelect.innerHTML = mtRenderModelOptions(settings.model);
      }
    }
    if (changes.liveBarPos && overlay.liveBar) {
      applyLiveBarPosition(changes.liveBarPos.newValue);
    }
    if (active && mode === 'mic') restartSpeech();
  });

  overlay.toggleBtn.addEventListener('click', () => {
    if (active) stop();
    else start();
  });

  overlay.modeCaptions.addEventListener('click', () => switchMode('captions'));
  overlay.modeTabAudio.addEventListener('click', () => switchMode('tabaudio'));
  overlay.modeMic.addEventListener('click', () => switchMode('mic'));

  overlay.modelSelect.addEventListener('change', async () => {
    settings.model = overlay.modelSelect.value;
    await chrome.storage.sync.set({ model: settings.model });
    setStatus(`Model: ${mtModelLabel(settings.model)}`, 'active');
  });

  function createOverlay() {
    const root = document.createElement('div');
    root.id = 'meet-translator-panel';
    root.innerHTML = `
      <header>
        <span class="mt-title">Meet Prekladac</span>
        <span class="mt-status" data-status>Neaktivni</span>
        <button class="mt-close" type="button" title="Skryt panel">×</button>
      </header>
      <div class="mt-modes">
        <button type="button" data-mode="captions" class="active">Titulky z Meetu</button>
        <button type="button" data-mode="tabaudio">Zvuk schuzky (vse)</button>
        <button type="button" data-mode="mic">Jen muj hlas</button>
      </div>
      <section class="mt-block mt-model-block">
        <label>AI model (OpenRouter)</label>
        <select data-model-select></select>
      </section>
      <section class="mt-block">
        <label>Puvodni text</label>
        <div class="mt-text mt-source" data-source>—</div>
      </section>
      <section class="mt-block">
        <label>Preklad</label>
        <div class="mt-text mt-translation" data-translation>—</div>
      </section>
      <section class="mt-history">
        <label>Historie</label>
        <ul data-history></ul>
      </section>
      <footer class="mt-hint">
        <b>Titulky z Meetu:</b> Nejlepsi pro protistranu (zapnete C).<br>
        <b>Zvuk schuzky:</b> Bere vse (vyzaduje OpenRouter Whisper).<br>
        <b>Jen muj hlas:</b> Web Speech (jen mikrofon).
      </footer>
    `;

    const liveBar = document.createElement('div');
    liveBar.id = 'meet-translator-live';
    liveBar.hidden = true;
    liveBar.innerHTML = `
      <div class="mt-live-drag-handle" title="Presunout titulky">⠿</div>
      <div class="mt-live-source" data-live-source></div>
      <div class="mt-live-translation" data-live-translation></div>
    `;

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'meet-translator-toggle';
    toggleBtn.type = 'button';
    toggleBtn.title = 'Meet Prekladac';
    toggleBtn.textContent = 'CS';

    root.querySelector('.mt-close').addEventListener('click', () => {
      root.classList.remove('visible');
    });

    const modelSelect = root.querySelector('[data-model-select]');
    modelSelect.innerHTML = mtRenderModelOptions(MT_DEFAULT_MODEL);

    return {
      root,
      liveBar,
      toggleBtn,
      status: root.querySelector('[data-status]'),
      source: root.querySelector('[data-source]'),
      translation: root.querySelector('[data-translation]'),
      history: root.querySelector('[data-history]'),
      modeCaptions: root.querySelector('[data-mode="captions"]'),
      modeTabAudio: root.querySelector('[data-mode="tabaudio"]'),
      modeMic: root.querySelector('[data-mode="mic"]'),
      modelSelect,
      liveSource: liveBar.querySelector('[data-live-source]'),
      liveTranslation: liveBar.querySelector('[data-live-translation]'),
      liveHandle: liveBar.querySelector('.mt-live-drag-handle'),
    };
  }

  function initDraggableLiveBar() {
    const bar = overlay.liveBar;
    const handle = overlay.liveHandle;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    chrome.storage.sync.get({ liveBarPos: null }, (data) => {
      if (data.liveBarPos) applyLiveBarPosition(data.liveBarPos);
      else applyLiveBarPosition({ top: '72px', left: '50%', centered: true });
    });

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      bar.classList.add('dragging');
      const rect = bar.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      bar.style.bottom = 'auto';
      bar.style.transform = 'none';
      bar.style.left = `${startLeft}px`;
      bar.style.top = `${startTop}px`;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const left = startLeft + e.clientX - startX;
      const top = startTop + e.clientY - startY;
      bar.style.left = `${Math.max(8, Math.min(left, window.innerWidth - bar.offsetWidth - 8))}px`;
      bar.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bar.offsetHeight - 8))}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
      chrome.storage.sync.set({
        liveBarPos: {
          top: bar.style.top,
          left: bar.style.left,
          centered: false,
        },
      });
    });
  }

  function applyLiveBarPosition(pos) {
    const bar = overlay.liveBar;
    if (!pos) return;
    bar.style.bottom = 'auto';
    if (pos.centered) {
      bar.style.top = pos.top || '72px';
      bar.style.left = '50%';
      bar.style.transform = 'translateX(-50%)';
    } else {
      bar.style.top = pos.top || '72px';
      bar.style.left = pos.left || '50%';
      bar.style.transform = 'none';
    }
  }

  function initStreamPort() {
    try {
      streamPort = chrome.runtime.connect({ name: 'translate-stream' });
      streamPort.onDisconnect.addListener(() => {
        streamPort = null;
        setTimeout(initStreamPort, 500);
      });
      streamPort.onMessage.addListener(handleStreamMessage);
    } catch {
      streamPort = null;
    }
  }

  function handleStreamMessage(msg) {
    if (!msg || msg.requestId !== translateRequestId) return;

    if (msg.type === 'CHUNK') {
      overlay.translation.classList.add('streaming');
      const display = applyTranslation(msg.text, currentTranslateOptions);
      overlay.translation.textContent = display;
      overlay.liveTranslation.textContent = display;
      setStatus('Prekladam…', 'busy');
      return;
    }

    if (msg.type === 'DONE') {
      overlay.translation.classList.remove('streaming');
      finishTranslation(
        applyTranslation(msg.translation, currentTranslateOptions),
        overlay.source.textContent,
        msg.cached,
      );
      return;
    }

    if (msg.type === 'ERROR') {
      overlay.translation.classList.remove('streaming');
      setStatus(msg.error || 'Chyba prekladu', 'error');
    }
  }

  async function loadSettings() {
    const data = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!data) return;

    settings.sourceLang = data.sourceLang || 'en';
    settings.targetLang = data.targetLang || 'cs';
    settings.engine = data.engine || 'auto';
    settings.model = mtIsValidModel(data.model) ? data.model : MT_DEFAULT_MODEL;

    if (overlay.modelSelect) {
      overlay.modelSelect.innerHTML = mtRenderModelOptions(settings.model);
    }

    await ensureChromeTranslator();
  }

  async function resetTranslator() {
    chromeTranslator = null;
    chromeTranslatorReady = false;
    await ensureChromeTranslator();
  }

  async function ensureChromeTranslator() {
    if (settings.engine === 'openrouter') return false;
    if (typeof Translator === 'undefined') return false;

    try {
      const availability = await Translator.availability({
        sourceLanguage: settings.sourceLang,
        targetLanguage: settings.targetLang,
      });

      if (availability === 'unavailable') return false;

      chromeTranslator = await Translator.create({
        sourceLanguage: settings.sourceLang,
        targetLanguage: settings.targetLang,
      });
      chromeTranslatorReady = true;
      return true;
    } catch {
      chromeTranslatorReady = false;
      return false;
    }
  }

  function setStatus(text, kind = '') {
    overlay.status.textContent = text;
    overlay.status.dataset.kind = kind;
  }

  function switchMode(nextMode) {
    if (mode === nextMode) return;
    mode = nextMode;
    overlay.modeCaptions.classList.toggle('active', mode === 'captions');
    overlay.modeTabAudio.classList.toggle('active', mode === 'tabaudio');
    overlay.modeMic.classList.toggle('active', mode === 'mic');
    resetTranslationState();
    if (active) {
      stopEngines();
      startEngines();
    }
  }

  function resetTranslationState() {
    translatedPrefix = '';
    translatedDisplay = '';
    lastCaptionText = '';
    lastSpeechText = '';
    lastTabAudioText = '';
    lastHistoryLine = '';
  }

  function start() {
    if (!SpeechRecognition && mode === 'mic') {
      setStatus('Web Speech API neni podporovano.', 'error');
      overlay.root.classList.add('visible');
      return;
    }

    active = true;
    resetTranslationState();
    overlay.toggleBtn.classList.add('active');
    overlay.root.classList.add('visible');
    overlay.liveBar.hidden = false;
    setStatus('Realtime…', 'active');
    ensureChromeTranslator();
    startEngines();
  }

  function stop() {
    active = false;
    overlay.toggleBtn.classList.remove('active');
    overlay.liveBar.hidden = true;
    setStatus('Neaktivni');
    cancelPendingTranslation();
    stopEngines();
  }

  function startEngines() {
    if (mode === 'mic') startSpeech();
    else if (mode === 'tabaudio') startTabAudioMode();
    else startCaptionWatcher();
  }

  function stopEngines() {
    stopSpeech();
    stopCaptionWatcher();
    chrome.runtime.sendMessage({ type: 'STOP_TAB_CAPTURE' });
  }

  function restartSpeech() {
    if (!active || mode !== 'mic') return;
    stopSpeech();
    startSpeech();
  }

  async function startTabAudioMode() {
    tryEnableMeetCaptions();
    startCaptionWatcher();

    const res = await chrome.runtime.sendMessage({
      type: 'START_TAB_CAPTURE',
      sourceLang: settings.sourceLang,
    });

    if (!res?.ok) {
      setStatus(res?.error || 'Nelze zachytit zvuk schuzky.', 'error');
      return;
    }

    setStatus('Zvuk schuzky + titulky…', 'active');
  }

  function handleTranscript(text, isFinal, source) {
    const display = text.trim();
    if (!display || display.length < MIN_CHARS) return;

    if (source === 'tabaudio' && display === lastTabAudioText) return;
    if (source === 'mic' && display === lastSpeechText) return;

    overlay.source.textContent = display;
    overlay.liveSource.textContent = display;

    if (source === 'tabaudio') lastTabAudioText = display;
    if (source === 'mic') lastSpeechText = display;

    queueTranslate(display, { final: isFinal !== false, fullReplace: true });
  }

  function startSpeech() {
    if (!SpeechRecognition) return;

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = SPEECH_LANG_MAP[settings.sourceLang] || 'en-US';

    recognition.onstart = () => setStatus('Mikrofon (jen vas hlas)…', 'active');

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed') {
        setStatus('Povolte mikrofon.', 'error');
        stop();
        return;
      }
      if (event.error === 'no-speech') return;
      setStatus(`Chyba STT: ${event.error}`, 'error');
    };

    recognition.onend = () => {
      if (active && mode === 'mic') {
        try {
          recognition.start();
        } catch {
          /* restart race */
        }
      }
    };

    recognition.onresult = (event) => {
      let interim = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (result.isFinal) finalText += `${text} `;
        else interim += text;
      }

      const display = (finalText || interim).trim();
      if (!display) return;
      handleTranscript(display, Boolean(finalText.trim()), 'mic');
    };

    try {
      recognition.start();
    } catch (err) {
      setStatus(`Nelze spustit STT: ${err.message}`, 'error');
    }
  }

  function stopSpeech() {
    if (!recognition) return;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
    recognition = null;
  }

  function walkDeep(root, visit) {
    if (!root) return;
    visit(root);
    const children = root.children || root.childNodes || [];
    Array.from(children).forEach((child) => {
      if (child.nodeType !== 1) return;
      walkDeep(child, visit);
      if (child.shadowRoot) walkDeep(child.shadowRoot, visit);
    });
  }

  function queryAllDeep(selector) {
    const results = [];
    walkDeep(document.body, (node) => {
      if (node.nodeType === 1 && node.matches?.(selector)) results.push(node);
    });
    return results;
  }

  function cleanText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function isOurElement(node) {
    if (!node || node.nodeType !== 1) return false;
    return OUR_ROOT_IDS.some((id) => node.id === id || node.closest(`#${id}`));
  }

  function isUiContainer(node) {
    if (!node) return true;
    const role = (node.getAttribute('role') || '').toLowerCase();
    if (['menu', 'listbox', 'dialog', 'option', 'combobox', 'menuitem', 'tooltip'].includes(role)) {
      return true;
    }
    return Boolean(
      node.closest(
        '[role="menu"], [role="listbox"], [role="dialog"], [role="tooltip"], select, [jsname="EaZ7Me"], [jsname="V68bde"]',
      ),
    );
  }

  function isInBottomArea(node) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 8) return false;
    return rect.top > window.innerHeight * 0.35;
  }

  function isPlausibleCaptionText(text) {
    const normalized = cleanText(text);
    if (normalized.length < MIN_CHARS) return false;
    if (normalized.length > 400) return false;
    if (LANGUAGE_DUMP_RE.test(normalized)) return false;

    // Ignore things that look like URLs or credits
    if (/https?:\/\/[^\s]+/.test(normalized)) return false;
    if (/subtitles|titulky|created by|vytvořil/i.test(normalized) && normalized.length > 40) return false;

    const betaCount = (normalized.match(/\bBETA\b/gi) || []).length;
    if (betaCount >= 1 && normalized.length > 60) return false;

    const parenCount = (normalized.match(/\([^)]{3,}\)/g) || []).length;
    if (parenCount >= 2) return false;

    if (/^(language|jazyk|langue|sprache)\b/i.test(normalized)) return false;
    if (normalized.split(' ').length > 30) return false;

    return true;
  }

  function tryEnableMeetCaptions() {
    const selectors = [
      '[jsname="r6bRZb"]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="titulk" i]',
      'button[aria-label*="titulky" i]',
      'button[data-tooltip*="caption" i]',
      'button[data-tooltip*="titulk" i]',
      '[data-promo-anchor-id="captions"]',
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (!btn || isOurElement(btn)) continue;
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed === 'false') {
        btn.click();
        return true;
      }
      if (pressed === 'true') return true;
    }
    return false;
  }

  function findCaptionRegion() {
    // 1. Try the most specific Google Meet selector first
    const primary = document.querySelector('[jsname="tgaKEf"]');
    if (primary && !isOurElement(primary) && !isUiContainer(primary)) {
      return primary;
    }

    // 2. Fallback to aria-label regions
    const regions = queryAllDeep('[role="region"][aria-label]');
    for (const region of regions) {
      if (isOurElement(region) || isUiContainer(region)) continue;
      const label = region.getAttribute('aria-label') || '';
      if (CAPTION_REGION_LABEL.test(label)) return region;
    }

    return null;
  }

  function extractTextFromRow(row) {
    const leafTexts = [];
    row.querySelectorAll('span, div, p').forEach((node) => {
      if (node.children.length > 2) return;
      if (node.querySelector('img, button, svg')) return;
      const t = cleanText(node.textContent);
      if (isPlausibleCaptionText(t)) leafTexts.push(t);
    });

    if (leafTexts.length) return leafTexts[leafTexts.length - 1];

    const full = cleanText(row.textContent);
    return isPlausibleCaptionText(full) ? full : '';
  }

  function extractLatestCaptionLine(region) {
    if (!region) return '';

    const candidates = [];

    // Prioritize jsname="YSxPC" which contains the actual text spans
    region.querySelectorAll('[jsname="YSxPC"] span, [jsname="YSxPC"]').forEach((node) => {
      const t = cleanText(node.textContent);
      if (isPlausibleCaptionText(t)) candidates.push(t);
    });

    if (candidates.length) return candidates[candidates.length - 1];

    for (const selector of CAPTION_LINE_SELECTORS) {
      region.querySelectorAll(selector).forEach((node) => {
        if (isUiContainer(node)) return;
        const t = cleanText(node.textContent);
        if (isPlausibleCaptionText(t)) candidates.push(t);
      });
    }

    if (candidates.length) return candidates[candidates.length - 1];

    const lines = (region.innerText || '')
      .split('\n')
      .map(cleanText)
      .filter(isPlausibleCaptionText);

    return lines.length ? lines[lines.length - 1] : '';
  }

  function scrapeCaptionCandidates() {
    const region = findCaptionRegion();
    if (region) {
      return extractLatestCaptionLine(region);
    }

    const candidates = [];
    queryAllDeep('[jsname="YSxPC"] span, [jsname="YSxPC"]').forEach((node) => {
      if (isOurElement(node) || isUiContainer(node) || !isInBottomArea(node)) return;
      const t = cleanText(node.textContent);
      if (isPlausibleCaptionText(t)) candidates.push(t);
    });

    if (candidates.length) return candidates[candidates.length - 1];

    queryAllDeep('[aria-live="polite"], [aria-live="assertive"]').forEach((node) => {
      if (isOurElement(node) || isUiContainer(node) || !isInBottomArea(node)) return;
      const t = cleanText(node.textContent);
      if (isPlausibleCaptionText(t)) candidates.push(t);
    });

    if (candidates.length) return candidates[candidates.length - 1];

    return '';
  }

  function readCaptionText() {
    if (!captionRegion || !document.contains(captionRegion)) {
      captionRegion = findCaptionRegion();
      bindCaptionObserver();
    }

    const fromRegion = extractLatestCaptionLine(captionRegion);
    if (fromRegion) return fromRegion;

    return scrapeCaptionCandidates();
  }

  function bindCaptionObserver() {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }

    const target = captionRegion || document.body;
    captionObserver = new MutationObserver(scanCaptions);
    captionObserver.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function startCaptionWatcher() {
    tryEnableMeetCaptions();
    captionRegion = findCaptionRegion();
    bindCaptionObserver();

    if (!captionRegion) {
      setStatus('Zapnete titulky v Meetu (klavesa C)', 'error');
    } else {
      setStatus('Titulky + preklad…', 'active');
    }

    scanCaptions();
    captionPollTimer = setInterval(() => {
      if (!captionRegion) tryEnableMeetCaptions();
      scanCaptions();
    }, 280);
  }

  function stopCaptionWatcher() {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    if (captionPollTimer) {
      clearInterval(captionPollTimer);
      captionPollTimer = null;
    }
    captionRegion = null;
    lastCaptionText = '';
  }

  function scanCaptions() {
    if (!active || (mode !== 'captions' && mode !== 'tabaudio')) return;

    const best = readCaptionText();
    if (!best || best.length < MIN_CHARS) return;
    if (best === lastCaptionText) return;

    const prev = lastCaptionText;
    lastCaptionText = best;
    overlay.source.textContent = best;
    overlay.liveSource.textContent = best;

    if (best.startsWith(prev) && prev.length > 0) {
      const delta = best.slice(prev.length).trim();
      if (delta.length >= MIN_CHARS) {
        queueTranslate(delta, { final: false, fullReplace: false });
      }
      return;
    }

    queueTranslate(best, { final: true, fullReplace: true });
  }

  function cancelPendingTranslation() {
    clearTimeout(pendingTranslate);
    translateRequestId += 1;
    if (streamPort) {
      streamPort.postMessage({ type: 'CANCEL', requestId: translateRequestId - 1 });
    }
  }

  function queueTranslate(text, options = {}) {
    const trimmed = text.trim();
    if (trimmed.length < MIN_CHARS) return;

    clearTimeout(pendingTranslate);
    const delay = options.final ? 0 : DEBOUNCE_MS;

    pendingTranslate = setTimeout(() => {
      currentTranslateOptions = options;
      if (options.fullReplace) {
        translatedPrefix = '';
        translatedDisplay = '';
      }
      runTranslation(trimmed, options);
    }, delay);
  }

  async function runTranslation(text, options) {
    const useChrome =
      settings.engine === 'chrome' ||
      (settings.engine === 'auto' && chromeTranslatorReady);

    if (useChrome && chromeTranslator) {
      try {
        setStatus('Chrome preklad…', 'busy');
        let result = text;

        if (typeof chromeTranslator.translateStreaming === 'function') {
          overlay.translation.classList.add('streaming');
          let streamed = '';
          const stream = chromeTranslator.translateStreaming(text);
          for await (const chunk of stream) {
            streamed += chunk;
            overlay.translation.textContent = applyTranslation(streamed, options);
            overlay.liveTranslation.textContent = overlay.translation.textContent;
          }
          result = streamed.trim();
          overlay.translation.classList.remove('streaming');
        } else {
          result = (await chromeTranslator.translate(text)).trim();
        }

        finishTranslation(applyTranslation(result, options), overlay.source.textContent, false);
        return;
      } catch {
        if (settings.engine === 'chrome') {
          setStatus('Chrome preklad selhal.', 'error');
          return;
        }
      }
    }

    if (!streamPort) initStreamPort();
    if (!streamPort) {
      const result = await chrome.runtime.sendMessage({ type: 'TRANSLATE', text });
      if (!result?.ok) {
        if (!result?.aborted) setStatus(result?.error || 'Chyba prekladu', 'error');
        return;
      }
      finishTranslation(applyTranslation(result.translation, options), overlay.source.textContent, result.cached);
      return;
    }

    translateRequestId += 1;
    const requestId = translateRequestId;
    overlay.translation.classList.add('streaming');
    setStatus('AI stream…', 'busy');
    streamPort.postMessage({ type: 'STREAM', text, requestId, options });
  }

  function applyTranslation(piece, options) {
    if (options.fullReplace) {
      translatedDisplay = piece;
      return translatedDisplay;
    }

    translatedDisplay = translatedPrefix
      ? `${translatedPrefix} ${piece}`.trim()
      : piece;
    return translatedDisplay;
  }

  function finishTranslation(translation, sourceText, cached) {
    if (!translation) return;

    translatedDisplay = translation;
    translatedPrefix = translation;

    overlay.translation.textContent = translation;
    overlay.liveTranslation.textContent = translation;
    overlay.translation.classList.remove('streaming');

    const historyKey = `${sourceText}::${translation}`;
    if (historyKey !== lastHistoryLine && translation.length > 2) {
      addHistory(sourceText, translation);
      lastHistoryLine = historyKey;
    }

    setStatus(cached ? 'Hotovo (cache)' : 'Live', 'active');
  }

  function addHistory(source, translation) {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${escapeHtml(translation)}</strong><span>${escapeHtml(source)}</span>`;
    overlay.history.prepend(li);

    while (overlay.history.children.length > 20) {
      overlay.history.removeChild(overlay.history.lastChild);
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
