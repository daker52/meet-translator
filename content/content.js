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
    /caption|titulk|sous-titre|untertitel|leyenda|subtit|字幕/i;
  const CAPTION_LINE_SELECTORS = [
    '[data-message-text]',
    '[jsname="YSxPC"]',
    '.NWpY1d',
    '.a4cQT',
    '.iOzk7',
  ];
  const LANGUAGE_DUMP_RE =
    /(\bBETA\b|\bBeta\b|afrikánština|afrikaans|albánština|amharština|arménština|jazyk schůzky|font size|open settings|otevřít nastavení|velikost písma)/i;
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

  loadSettings();
  initStreamPort();

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
    if (active && mode === 'speech') restartSpeech();
  });

  overlay.toggleBtn.addEventListener('click', () => {
    if (active) stop();
    else start();
  });

  overlay.modeSpeech.addEventListener('click', () => switchMode('speech'));
  overlay.modeCaptions.addEventListener('click', () => switchMode('captions'));
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
        <button type="button" data-mode="captions" class="active">Meet titulky</button>
        <button type="button" data-mode="speech">Web Speech</button>
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
        Realtime: zapnete titulky v Meetu (C), vyberte rychly model (Llama 3.2 3B) nebo Chrome preklad v popupu.
      </footer>
    `;

    const liveBar = document.createElement('div');
    liveBar.id = 'meet-translator-live';
    liveBar.hidden = true;
    liveBar.innerHTML = `
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
      modeSpeech: root.querySelector('[data-mode="speech"]'),
      modeCaptions: root.querySelector('[data-mode="captions"]'),
      modelSelect,
      liveSource: liveBar.querySelector('[data-live-source]'),
      liveTranslation: liveBar.querySelector('[data-live-translation]'),
    };
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
    overlay.modeSpeech.classList.toggle('active', mode === 'speech');
    overlay.modeCaptions.classList.toggle('active', mode === 'captions');
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
    lastHistoryLine = '';
  }

  function start() {
    if (!SpeechRecognition && mode === 'speech') {
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
    if (mode === 'speech') startSpeech();
    else startCaptionWatcher();
  }

  function stopEngines() {
    stopSpeech();
    stopCaptionWatcher();
  }

  function restartSpeech() {
    if (!active || mode !== 'speech') return;
    stopSpeech();
    startSpeech();
  }

  function startSpeech() {
    if (!SpeechRecognition) return;

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = SPEECH_LANG_MAP[settings.sourceLang] || 'en-US';

    recognition.onstart = () => setStatus('Nasloucham…', 'active');

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
      if (active && mode === 'speech') {
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

      overlay.source.textContent = display;
      overlay.liveSource.textContent = display;

      if (display === lastSpeechText) return;
      lastSpeechText = display;

      if (finalText.trim()) {
        queueTranslate(display, { final: true, fullReplace: true });
      } else if (display.length >= MIN_CHARS) {
        queueTranslate(display, { final: false, fullReplace: true });
      }
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

  function isOurElement(node) {
    if (!node || node.nodeType !== 1) return false;
    return OUR_ROOT_IDS.some((id) => node.id === id || node.closest(`#${id}`));
  }

  function isUiContainer(node) {
    if (!node) return true;
    const role = (node.getAttribute('role') || '').toLowerCase();
    if (['menu', 'listbox', 'dialog', 'option', 'combobox', 'menuitem'].includes(role)) {
      return true;
    }
    return Boolean(node.closest('[role="menu"], [role="listbox"], [role="dialog"], select, [jsname="EaZ7Me"]'));
  }

  function isPlausibleCaptionText(text) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length < MIN_CHARS) return false;
    if (normalized.length > 420) return false;
    if (LANGUAGE_DUMP_RE.test(normalized) && normalized.length > 60) return false;

    const betaCount = (normalized.match(/\bBETA\b/gi) || []).length;
    if (betaCount >= 1 && normalized.length > 80) return false;

    const parenCount = (normalized.match(/\([^)]{3,}\)/g) || []).length;
    if (parenCount >= 3) return false;

    if (/^(language|jazyk|langue|sprache)\b/i.test(normalized)) return false;
    if (normalized.split(' ').length > 35) return false;

    return true;
  }

  function findCaptionRegion() {
    const labelledRegions = document.querySelectorAll('[role="region"][aria-label]');
    for (const region of labelledRegions) {
      if (isOurElement(region) || isUiContainer(region)) continue;
      const label = region.getAttribute('aria-label') || '';
      if (CAPTION_REGION_LABEL.test(label)) return region;
    }

    const primary = document.querySelector('[jsname="tgaKEf"]');
    if (primary && !isOurElement(primary) && !isUiContainer(primary)) {
      const sample = (primary.innerText || '').trim();
      if (!sample || isPlausibleCaptionText(sample) || sample.length < 80) {
        return primary;
      }
    }

    return null;
  }

  function extractLatestCaptionLine(region) {
    if (!region) return '';

    let best = '';

    for (const selector of CAPTION_LINE_SELECTORS) {
      region.querySelectorAll(selector).forEach((node) => {
        if (isUiContainer(node)) return;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > best.length && isPlausibleCaptionText(text)) {
          best = text;
        }
      });
    }

    if (best) return best;

    const rawLines = (region.innerText || '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    for (let i = rawLines.length - 1; i >= 0; i -= 1) {
      const line = rawLines[i];
      if (isPlausibleCaptionText(line)) return line;
    }

    return '';
  }

  function readCaptionText() {
    if (!captionRegion || !document.contains(captionRegion)) {
      captionRegion = findCaptionRegion();
      bindCaptionObserver();
    }
    return extractLatestCaptionLine(captionRegion);
  }

  function bindCaptionObserver() {
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    if (!captionRegion) return;

    captionObserver = new MutationObserver(scanCaptions);
    captionObserver.observe(captionRegion, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
  function startCaptionWatcher() {
    captionRegion = findCaptionRegion();
    bindCaptionObserver();

    if (!captionRegion) {
      setStatus('Zapnete titulky v Meetu (klavesa C)', 'error');
    } else {
      setStatus('Titulky + preklad…', 'active');
    }

    scanCaptions();
    captionPollTimer = setInterval(scanCaptions, 300);
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
