const apiKeyInput = document.getElementById('apiKey');
const engineSelect = document.getElementById('engine');
const modelSelect = document.getElementById('model');
const sourceLangSelect = document.getElementById('sourceLang');
const targetLangSelect = document.getElementById('targetLang');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');

function renderModelOptions(selectedModel) {
  const valid = mtIsValidModel(selectedModel) ? selectedModel : MT_DEFAULT_MODEL;
  modelSelect.innerHTML = mtRenderModelOptions(valid);
}

function showStatus(text, isError = false) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

async function load() {
  const data = await chrome.storage.sync.get({
    apiKey: '',
    model: MT_DEFAULT_MODEL,
    engine: 'auto',
    sourceLang: 'en',
    targetLang: 'cs',
  });

  apiKeyInput.value = data.apiKey;
  engineSelect.value = data.engine || 'auto';
  renderModelOptions(data.model);
  sourceLangSelect.value = data.sourceLang;
  targetLangSelect.value = data.targetLang;
}

async function persist(partial, message) {
  const current = await chrome.storage.sync.get({
    apiKey: '',
    model: MT_DEFAULT_MODEL,
    engine: 'auto',
    sourceLang: 'en',
    targetLang: 'cs',
  });

  await chrome.storage.sync.set({ ...current, ...partial });
  if (message) showStatus(message);
}

saveBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const model = modelSelect.value || MT_DEFAULT_MODEL;
  const engine = engineSelect.value || 'auto';

  if (engine !== 'chrome' && !apiKey) {
    showStatus('Zadejte OpenRouter API klic (nebo zvolte Chrome engine).', true);
    return;
  }

  await persist(
    {
      apiKey,
      model,
      engine,
      sourceLang: sourceLangSelect.value,
      targetLang: targetLangSelect.value,
    },
    'Nastaveni ulozeno.',
  );
});

engineSelect.addEventListener('change', async () => {
  await persist({ engine: engineSelect.value }, `Engine: ${engineSelect.selectedOptions[0].text}`);
});

modelSelect.addEventListener('change', async () => {
  await persist({ model: modelSelect.value }, `Model: ${mtModelLabel(modelSelect.value)}`);
});

load();
