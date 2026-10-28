// Isolated-world content script. Relays settings and popup commands between the
// extension (chrome.* APIs) and the main-world camera pipeline (window.postMessage).
(() => {
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

  document.documentElement.dataset.snapfxBase = chrome.runtime.getURL('');

  let status = { hooked: false, detector: 'idle' };

  const toPage = (msg) => window.postMessage({ snapfx: true, ...msg }, location.origin);

  const pushSettings = async () => {
    const stored = await chrome.storage.local.get(DEFAULTS);
    toPage({ type: 'settings', settings: { ...DEFAULTS, ...stored } });
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.snapfx !== true) return;
    if (e.data.type === 'hello') pushSettings();
    if (e.data.type === 'status') status = e.data.status;
  });

  chrome.storage.onChanged.addListener((_, area) => {
    if (area === 'local') pushSettings();
  });

  // The popup messages every frame in the tab; the frame whose camera is
  // hooked answers, otherwise the top frame does after a moment.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'getStatus') {
      if (status.hooked) reply(status);
      else if (window === top) {
        setTimeout(() => reply(status), 150);
        return true;
      }
    } else if (msg?.type === 'trigger' || msg?.type === 'background') {
      toPage(msg);
      reply({ ok: true });
    }
  });

  pushSettings();
})();
