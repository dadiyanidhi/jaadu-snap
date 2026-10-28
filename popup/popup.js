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
};

const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');

async function callTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return /^(https:|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(tab?.url || '') ? tab : null;
}

async function sendToTab(msg) {
  const tab = await callTab();
  if (!tab) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null;
  }
}

async function refreshStatus() {
  const tab = await callTab();
  if (!tab) {
    setStatus('Open your video call (Meet, Teams, Zoom web…) to use effects.');
    return;
  }
  const s = await sendToTab({ type: 'getStatus' });
  if (!s) setStatus('Reload this tab to activate the extension.', 'err');
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
  chrome.storage.local.remove('facepalmImage');

  for (const btn of document.querySelectorAll('[data-trigger]')) {
    btn.addEventListener('click', () => sendToTab({ type: 'trigger', name: btn.dataset.trigger }));
  }
  for (const btn of document.querySelectorAll('[data-background]')) {
    btn.addEventListener('click', async () => {
      await sendToTab({ type: 'background', action: btn.dataset.background });
      if (btn.dataset.background === 'capture') setStatus('Step out of frame now: capturing in 3 s…', 'ok');
    });
  }

  refreshStatus();
  setInterval(refreshStatus, 1500);
}

init();
