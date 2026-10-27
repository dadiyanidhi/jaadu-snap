const DEFAULTS = {
  enabled: true,
  snap: true,
  doubleSnap: true,
  cinema: true,
  facepalm: true,
  snapSound: true,
  sensitivity: 0.5,
  showDebug: false,
  cinemaText: 'ABSOLUTE CINEMA',
  facepalmText: 'bruh.',
  facepalmImage: null,
};
const MAX_IMAGE_SIDE = 640;

const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');

async function meetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith('https://meet.google.com/') ? tab : null;
}

async function sendToMeet(msg) {
  const tab = await meetTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

async function refreshStatus() {
  const tab = await meetTab();
  if (!tab) {
    setStatus('Open a Google Meet tab to use effects.');
    return;
  }
  const s = await sendToMeet({ type: 'getStatus' });
  if (!s) setStatus('Reload the Meet tab to activate the extension.', 'err');
  else if (!s.hooked) setStatus('Waiting for your camera to turn on…');
  else if (s.detector === 'error') setStatus(`Detector failed: ${s.error}`, 'err');
  else if (s.detector !== 'ready') setStatus('Camera hooked. Loading hand tracking…');
  else if (s.room === 'learning') setStatus('Learning your room… keep the camera still for a few seconds.');
  else {
    const room = s.room === 'unavailable' ? 'Room fill unavailable, using blur.' : 'Room learned.';
    const sound = s.sound === 'on' ? 'Snap sound on.' : 'Snap sound off (camera only).';
    setStatus(`Ready. ${room} ${sound}`, 'ok');
  }
}

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function showPreview(src) {
  const img = $('#preview');
  img.hidden = !src;
  if (src) img.src = src;
}

async function init() {
  const settings = await chrome.storage.local.get(DEFAULTS);

  for (const el of document.querySelectorAll('[data-key]')) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
    el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {
      const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
      chrome.storage.local.set({ [key]: value });
    });
  }
  showPreview(settings.facepalmImage);

  for (const btn of document.querySelectorAll('[data-trigger]')) {
    btn.addEventListener('click', () => sendToMeet({ type: 'trigger', name: btn.dataset.trigger }));
  }
  for (const btn of document.querySelectorAll('[data-background]')) {
    btn.addEventListener('click', async () => {
      await sendToMeet({ type: 'background', action: btn.dataset.background });
      if (btn.dataset.background === 'capture') setStatus('Step out of frame now: capturing in 3 s…', 'ok');
    });
  }

  $('#facepalmImage').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await downscale(file);
    await chrome.storage.local.set({ facepalmImage: dataUrl });
    showPreview(dataUrl);
  });
  $('#clearImage').addEventListener('click', async () => {
    await chrome.storage.local.set({ facepalmImage: null });
    $('#facepalmImage').value = '';
    showPreview(null);
  });

  refreshStatus();
  setInterval(refreshStatus, 1500);
}

// Shrinks uploads so they fit comfortably in storage; keeps PNG transparency.
async function downscale(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

init();
