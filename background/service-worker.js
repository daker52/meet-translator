importScripts('../lib/models.js');

const DEFAULT_MODEL = MT_FAST_MODEL;
const STT_MODEL = 'openai/whisper-1';
const activeStreams = new Map();
const OFFSCREEN_URL = 'offscreen/offscreen.html';

const translationCache = new Map();
const CACHE_MAX = 400;

let creatingOffscreen = null;

function cacheKey(text, targetLang, model) {
  return `${model}::${targetLang}::${text.trim().toLowerCase()}`;
}

async function getSettings() {
  return chrome.storage.sync.get({
    apiKey: '',
    model: DEFAULT_MODEL,
    targetLang: 'cs',
    sourceLang: 'en',
    engine: 'auto',
  });
}

function sanitizeHeaderValue(value) {
  return String(value).replace(/[^\u0000-\u00FF]/g, '').trim();
}

function buildPrompt(sourceLang, targetLang) {
  const map = { cs: 'Czech', en: 'English', de: 'German', sk: 'Slovak', es: 'Spanish', fr: 'French' };
  const from = map[sourceLang] || sourceLang;
  const to = map[targetLang] || targetLang;
  return `Translate ${from} to ${to}. Reply with translation only.`;
}

async function fetchCompletion(payload, apiKey, signal) {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${sanitizeHeaderValue(apiKey)}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://meet.google.com',
      'X-Title': 'Meet Translator',
    },
    body: JSON.stringify(payload),
  });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Capture Google Meet tab audio for speech-to-text.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }

  await creatingOffscreen;
}

async function closeOffscreenIfIdle() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument();
  }
}

async function startTabCapture(tabId, sourceLang) {
  await ensureOffscreen();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_TAB_AUDIO',
    streamId,
    sourceLang,
  });
}

async function stopTabCapture() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_TAB_AUDIO' });
    }
  } catch {
    /* offscreen may be gone */
  }
  await closeOffscreenIfIdle();
}

async function transcribeTabAudio(base64, format, sourceLang, apiKey) {
  const response = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sanitizeHeaderValue(apiKey)}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://meet.google.com',
      'X-Title': 'Meet Translator',
    },
    body: JSON.stringify({
      model: STT_MODEL,
      input_audio: { data: base64, format },
      language: sourceLang,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`STT ${response.status}: ${err.slice(0, 120)}`);
  }

  const data = await response.json();
  return (data?.text || data?.transcript || '').trim();
}

function broadcastToMeetTabs(message) {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  });
}

async function translateText(text, settings, signal) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2) {
    return { ok: false, error: 'Text je prilis kratky.' };
  }

  if (!settings.apiKey) {
    return { ok: false, error: 'Chybi OpenRouter API klic.' };
  }

  const model = settings.model || DEFAULT_MODEL;
  const key = cacheKey(trimmed, settings.targetLang, model);
  if (translationCache.has(key)) {
    return { ok: true, translation: translationCache.get(key), cached: true };
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: buildPrompt(settings.sourceLang, settings.targetLang) },
      { role: 'user', content: trimmed },
    ],
    temperature: 0.1,
    max_tokens: Math.min(256, trimmed.length * 3 + 32),
    stream: false,
  };

  try {
    let response = await fetchCompletion(payload, settings.apiKey, signal);

    if (response.status === 429) {
      await new Promise((r) => setTimeout(r, 400));
      response = await fetchCompletion(payload, settings.apiKey, signal);
    }

    if (!response.ok) {
      const errBody = await response.text();
      return { ok: false, error: `OpenRouter ${response.status}: ${errBody.slice(0, 120)}` };
    }

    const data = await response.json();
    const translation = data?.choices?.[0]?.message?.content?.trim();
    if (!translation) return { ok: false, error: 'Prazdna odpoved od modelu.' };

    translationCache.set(key, translation);
    if (translationCache.size > CACHE_MAX) {
      translationCache.delete(translationCache.keys().next().value);
    }

    return { ok: true, translation, cached: false };
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, error: err?.message || 'Sitova chyba' };
  }
}

async function streamTranslate(text, settings, requestId, port) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < 2) {
    port.postMessage({ type: 'ERROR', requestId, error: 'Text je prilis kratky.' });
    return;
  }

  if (!settings.apiKey) {
    port.postMessage({ type: 'ERROR', requestId, error: 'Chybi OpenRouter API klic.' });
    return;
  }

  const model = settings.model || DEFAULT_MODEL;
  const cacheK = cacheKey(trimmed, settings.targetLang, model);
  if (translationCache.has(cacheK)) {
    port.postMessage({
      type: 'DONE',
      requestId,
      translation: translationCache.get(cacheK),
      cached: true,
    });
    return;
  }

  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  const payload = {
    model,
    messages: [
      { role: 'system', content: buildPrompt(settings.sourceLang, settings.targetLang) },
      { role: 'user', content: trimmed },
    ],
    temperature: 0.1,
    max_tokens: Math.min(256, trimmed.length * 3 + 32),
    stream: true,
  };

  try {
    let response = await fetchCompletion(payload, settings.apiKey, controller.signal);

    if (response.status === 429) {
      await new Promise((r) => setTimeout(r, 400));
      response = await fetchCompletion(payload, settings.apiKey, controller.signal);
    }

    if (!response.ok) {
      const errBody = await response.text();
      port.postMessage({
        type: 'ERROR',
        requestId,
        error: `OpenRouter ${response.status}: ${errBody.slice(0, 120)}`,
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('data:')) continue;
        const data = trimmedLine.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const chunk = parsed?.choices?.[0]?.delta?.content || '';
          if (!chunk) continue;
          full += chunk;
          port.postMessage({ type: 'CHUNK', requestId, text: full });
        } catch {
          /* ignore malformed sse chunk */
        }
      }
    }

    const translation = full.trim();
    if (!translation) {
      port.postMessage({ type: 'ERROR', requestId, error: 'Prazdna odpoved od modelu.' });
      return;
    }

    translationCache.set(cacheK, translation);
    if (translationCache.size > CACHE_MAX) {
      translationCache.delete(translationCache.keys().next().value);
    }

    port.postMessage({ type: 'DONE', requestId, translation, cached: false });
  } catch (err) {
    if (err?.name === 'AbortError') {
      port.postMessage({ type: 'ABORTED', requestId });
      return;
    }
    port.postMessage({ type: 'ERROR', requestId, error: err?.message || 'Sitova chyba' });
  } finally {
    activeStreams.delete(requestId);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate-stream') return;

  port.onMessage.addListener((message) => {
    if (message?.type === 'CANCEL' && message.requestId) {
      activeStreams.get(message.requestId)?.abort();
      activeStreams.delete(message.requestId);
      return;
    }

    if (message?.type === 'STREAM') {
      getSettings().then((settings) =>
        streamTranslate(message.text, settings, message.requestId, port),
      );
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false;

  if (message?.type === 'TAB_AUDIO_CHUNK') {
    getSettings()
      .then(async (settings) => {
        if (!settings.apiKey) throw new Error('Chybi OpenRouter API klic pro STT.');
        const text = await transcribeTabAudio(
          message.audio,
          message.format || 'webm',
          message.sourceLang || settings.sourceLang,
          settings.apiKey,
        );
        if (text) {
          broadcastToMeetTabs({ type: 'TAB_AUDIO_TRANSCRIPT', text, final: true });
        }
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'TAB_AUDIO_TRANSCRIPT' || message?.type === 'TAB_AUDIO_ERROR') {
    broadcastToMeetTabs(message);
    return false;
  }

  if (message?.type === 'START_TAB_CAPTURE') {
    startTabCapture(sender.tab?.id, message.sourceLang)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'STOP_TAB_CAPTURE') {
    stopTabCapture().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'TRANSLATE') {
    getSettings()
      .then((settings) => translateText(message.text, settings))
      .then(sendResponse);
    return true;
  }

  if (message?.type === 'GET_SETTINGS') {
    getSettings().then(sendResponse);
    return true;
  }

  return false;
});
