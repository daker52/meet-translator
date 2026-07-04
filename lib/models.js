const MT_FAST_MODEL = 'meta-llama/llama-3.2-3b-instruct:free';

const MT_MODELS = [
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    label: 'Nemotron 3 Ultra 550B',
    group: 'Nejlepší kvalita',
  },
  {
    id: 'qwen/qwen3-next-80b-a3b-instruct:free',
    label: 'Qwen3 Next 80B',
    group: 'Nejlepší kvalita',
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct:free',
    label: 'Llama 3.3 70B',
    group: 'Nejlepší kvalita',
  },
  {
    id: 'openai/gpt-oss-120b:free',
    label: 'GPT-OSS 120B',
    group: 'Nejlepší kvalita',
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    label: 'Nemotron 3 Super 120B',
    group: 'Nejlepší kvalita',
  },
  {
    id: 'nousresearch/hermes-3-llama-3.1-405b:free',
    label: 'Hermes 3 405B',
    group: 'Nejlepší kvalita',
  },
  {
    id: 'google/gemma-4-31b-it:free',
    label: 'Gemma 4 31B',
    group: 'Vyvážené',
  },
  {
    id: 'google/gemma-4-26b-a4b-it:free',
    label: 'Gemma 4 26B',
    group: 'Vyvážené',
  },
  {
    id: 'openai/gpt-oss-20b:free',
    label: 'GPT-OSS 20B',
    group: 'Vyvážené',
  },
  {
    id: 'nvidia/nemotron-3-nano-30b-a3b:free',
    label: 'Nemotron 3 Nano 30B',
    group: 'Vyvážené',
  },
  {
    id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free',
    label: 'Dolphin Mistral 24B Venice',
    group: 'Vyvážené',
  },
  {
    id: 'meta-llama/llama-3.2-3b-instruct:free',
    label: 'Llama 3.2 3B',
    group: 'Nejrychlejší',
  },
  {
    id: 'liquid/lfm-2.5-1.2b-instruct:free',
    label: 'LFM 2.5 1.2B',
    group: 'Nejrychlejší',
  },
  {
    id: 'openrouter/free',
    label: 'OpenRouter Auto (náhodný free)',
    group: 'Auto',
  },
];

const MT_DEFAULT_MODEL = MT_FAST_MODEL;

function mtRenderModelOptions(selectedModel) {
  const groups = [];
  MT_MODELS.forEach((model) => {
    if (!groups.includes(model.group)) groups.push(model.group);
  });

  return groups
    .map((group) => {
      const options = MT_MODELS.filter((m) => m.group === group)
        .map(
          (m) =>
            `<option value="${m.id}"${m.id === selectedModel ? ' selected' : ''}>${m.label}</option>`,
        )
        .join('');
      return `<optgroup label="${group}">${options}</optgroup>`;
    })
    .join('');
}

function mtModelLabel(modelId) {
  return MT_MODELS.find((m) => m.id === modelId)?.label || modelId;
}

function mtIsValidModel(modelId) {
  return MT_MODELS.some((m) => m.id === modelId);
}
