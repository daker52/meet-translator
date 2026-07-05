const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
  ? 'audio/webm;codecs=opus'
  : 'audio/webm';

let mediaStream = null;
let recorder = null;
let recordTimer = null;
let sourceLang = 'en';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'START_TAB_AUDIO') {
    sourceLang = message.sourceLang || 'en';
    startTabAudio(message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || 'Chyba' }));
    return true;
  }

  if (message.type === 'STOP_TAB_AUDIO') {
    stopTabAudio();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function startTabAudio(streamId) {
  stopTabAudio();

  if (!streamId) throw new Error('Chybi streamId z tabCapture.');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  recorder = new MediaRecorder(mediaStream, { mimeType: mime });

  recorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size < 1500) return;
    const buffer = await event.data.arrayBuffer();
    chrome.runtime.sendMessage({
      type: 'TAB_AUDIO_CHUNK',
      audio: arrayBufferToBase64(buffer),
      format: 'webm',
      sourceLang,
    });
  };

  recorder.start();
  recordTimer = setInterval(() => {
    if (recorder?.state === 'recording') recorder.stop();
    if (mediaStream && recorder) recorder.start();
  }, 3000);
}

function stopTabAudio() {
  if (recordTimer) {
    clearInterval(recordTimer);
    recordTimer = null;
  }

  if (recorder) {
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* ignore */
    }
    recorder = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
