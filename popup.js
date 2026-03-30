// popup.js — Real-Time Speech Translator v2
// LANGUAGES is defined in languages.js (loaded before this script).

// ── Default settings ─────────────────────────────────────────────────────────
let settings = {
  sourceLang:       'en',
  targetLang:       'uz',
  fontSize:         18,
  opacity:          0.85,
  position:         'bottom',
  apiKey:           '',
  whitelistEnabled: false,
  domainWhitelist:  [],
};

let isRunning = false;

// ── DOM references ───────────────────────────────────────────────────────────
const sourceLangEl      = document.getElementById('sourceLang');
const targetLangEl      = document.getElementById('targetLang');
const swapLangBtn       = document.getElementById('swapLang');
const toggleBtn         = document.getElementById('toggleBtn');
const toggleText        = document.getElementById('toggleBtnText');
const statusBadge       = document.getElementById('statusBadge');
const statusText        = document.getElementById('statusText');
const fontSizeEl        = document.getElementById('fontSize');
const fontSizeVal       = document.getElementById('fontSizeVal');
const opacityEl         = document.getElementById('opacity');
const opacityVal        = document.getElementById('opacityVal');
const posTopBtn         = document.getElementById('posTop');
const posBottomBtn      = document.getElementById('posBottom');
const clearBtn          = document.getElementById('clearBtn');
const exportTxtBtn      = document.getElementById('exportTxt');
const exportSrtBtn      = document.getElementById('exportSrt');
const transcriptList    = document.getElementById('transcriptList');
const apiKeyEl          = document.getElementById('apiKey');
const whitelistToggleEl = document.getElementById('whitelistEnabled');
const whitelistInputEl  = document.getElementById('domainWhitelist');
const whitelistContainer= document.getElementById('whitelistContainer');
const addCurrentSiteBtn = document.getElementById('addCurrentSite');
const privacyBanner     = document.getElementById('privacyBanner');
const dismissPrivacyBtn = document.getElementById('dismissPrivacy');
const ariaLiveEl        = document.getElementById('ariaLive');

// ── Populate language dropdowns ───────────────────────────────────────────────
function populateLangDropdowns() {
  LANGUAGES.forEach(({ code, name }) => {
    [sourceLangEl, targetLangEl].forEach((sel) => {
      const opt       = document.createElement('option');
      opt.value       = code;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  });
}

// ── Apply settings to UI ──────────────────────────────────────────────────────
function applySettingsToUI() {
  sourceLangEl.value      = settings.sourceLang;
  targetLangEl.value      = settings.targetLang;
  fontSizeEl.value        = settings.fontSize;
  opacityEl.value         = settings.opacity;
  fontSizeVal.textContent = settings.fontSize + 'px';
  opacityVal.textContent  = Math.round(settings.opacity * 100) + '%';
  updatePosButtons(settings.position);

  apiKeyEl.value                  = settings.apiKey || '';
  whitelistToggleEl.checked       = !!settings.whitelistEnabled;
  whitelistInputEl.value          = (settings.domainWhitelist || []).join(', ');
  whitelistContainer.hidden       = !settings.whitelistEnabled;
}

function updatePosButtons(pos) {
  posTopBtn.classList.toggle('pos-active',    pos === 'top');
  posBottomBtn.classList.toggle('pos-active', pos === 'bottom');
}

// ── Status badge ──────────────────────────────────────────────────────────────
function setStatus(state, label) {
  statusBadge.className   = 'status-badge status-' + state;
  statusText.textContent  = label;
}

// ── Toggle button UI ──────────────────────────────────────────────────────────
function setRunning(running) {
  isRunning = running;
  if (running) {
    toggleBtn.className = 'toggle-btn btn-stop';
    toggleText.textContent = 'Stop Listening';
    toggleBtn.querySelector('.btn-icon').innerHTML =
      '<rect x="6" y="6" width="12" height="12" rx="2" ry="2" fill="currentColor" stroke="none"/>';
    setStatus('listening', 'Listening');
  } else {
    toggleBtn.className = 'toggle-btn btn-start';
    toggleText.textContent = 'Start Listening';
    toggleBtn.querySelector('.btn-icon').innerHTML = `
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>`;
    setStatus('idle', 'Idle');
  }
}

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const existing = document.getElementById('__st-toast');
  if (existing) existing.remove();

  const toast       = document.createElement('div');
  toast.id          = '__st-toast';
  toast.className   = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 2800);
}

// ── Message passing ───────────────────────────────────────────────────────────
function sendToContent(action, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { target: 'content', action, ...extra },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[Popup] sendMessage error:', chrome.runtime.lastError.message);
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response && typeof response === 'object' ? response : { success: true });
        }
      }
    );
  });
}

// ── Save & sync ───────────────────────────────────────────────────────────────
function saveSettings() {
  chrome.storage.local.set({ translatorSettings: settings });
}

function syncSettingsToContent() {
  sendToContent('updateSettings', { settings });
}

// ── Domain whitelist check ────────────────────────────────────────────────────
async function checkDomainAllowed() {
  if (!settings.whitelistEnabled) return true;
  const whitelist = settings.domainWhitelist || [];
  if (whitelist.length === 0) return true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return true;
    const hostname = new URL(tab.url).hostname;
    return whitelist.some((d) => hostname.includes(d.trim()));
  } catch (e) {
    return true;
  }
}

// ── Transcript helpers ────────────────────────────────────────────────────────
function buildTranscriptItem(original, translated, quality = null) {
  const item      = document.createElement('div');
  item.className  = 'transcript-item';

  let qualityHtml = '';
  if (quality !== null) {
    const pct = Math.round(quality * 100);
    if (pct < 80) {
      const cls = pct < 50 ? 'quality-low' : 'quality-mid';
      qualityHtml = ` <span class="quality-badge ${cls}">${pct}%</span>`;
    }
  }

  item.innerHTML = `
    <div class="transcript-original">${escapeHtml(original)}${qualityHtml}</div>
    <div class="transcript-translated">${escapeHtml(translated)}</div>
  `;
  return item;
}

function addTranscriptItem(original, translated, quality = null) {
  const hint = transcriptList.querySelector('.empty-hint');
  if (hint) hint.remove();

  transcriptList.prepend(buildTranscriptItem(original, translated, quality));

  // Keep max 50 items (matches MAX_HISTORY in content.js)
  while (transcriptList.children.length > 50) {
    transcriptList.removeChild(transcriptList.lastChild);
  }

  // Announce to screen readers
  if (ariaLiveEl) ariaLiveEl.textContent = `Translation: ${translated}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Restore history from content script ──────────────────────────────────────
async function restoreHistory() {
  const resp = await sendToContent('getHistory');
  if (!resp || !resp.success || !resp.history || resp.history.length === 0) return;

  const hint = transcriptList.querySelector('.empty-hint');
  if (hint) hint.remove();

  resp.history.forEach(({ original, translated, quality }) => {
    transcriptList.appendChild(buildTranscriptItem(original, translated, quality));
  });
}

// ── Export transcript ─────────────────────────────────────────────────────────
function formatSrtTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h   = Math.floor(totalSec / 3600).toString().padStart(2, '0');
  const m   = Math.floor((totalSec % 3600) / 60).toString().padStart(2, '0');
  const s   = (totalSec % 60).toString().padStart(2, '0');
  const ms3 = (ms % 1000).toString().padStart(3, '0');
  return `${h}:${m}:${s},${ms3}`;
}

async function exportTranscript(format) {
  const resp = await sendToContent('getHistory');
  if (!resp || !resp.success || !resp.history || resp.history.length === 0) {
    showToast('No transcript to export', 'warning');
    return;
  }

  const items = resp.history;
  let content, filename;

  if (format === 'txt') {
    content = items
      .map((item, i) => `[${i + 1}] ${item.original}\n     → ${item.translated}`)
      .join('\n\n');
    filename = `transcript-${Date.now()}.txt`;
  } else {
    // SRT — relative timestamps starting at 00:00:00,000
    const baseTs = items[0].ts;
    content = items
      .map((item, i) => {
        const relStart = item.ts - baseTs;
        const relEnd   = relStart + 4500;
        return `${i + 1}\n${formatSrtTime(relStart)} --> ${formatSrtTime(relEnd)}\n${item.original}\n${item.translated}\n`;
      })
      .join('\n');
    filename = `transcript-${Date.now()}.srt`;
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Exported as ${format.toUpperCase()}`, 'success');
}

// ── Privacy notice ────────────────────────────────────────────────────────────
async function checkPrivacy() {
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(['privacyAcknowledged'], resolve)
  );
  if (!stored.privacyAcknowledged) {
    privacyBanner.removeAttribute('hidden');
  }
}

dismissPrivacyBtn.addEventListener('click', () => {
  chrome.storage.local.set({ privacyAcknowledged: true });
  privacyBanner.setAttribute('hidden', '');
});

// ── Event listeners ───────────────────────────────────────────────────────────

// Start / Stop
toggleBtn.addEventListener('click', async () => {
  if (isRunning) {
    const resp = await sendToContent('stop');
    if (resp && resp.success) setRunning(false);
  } else {
    const allowed = await checkDomainAllowed();
    if (!allowed) {
      showToast('This site is not in your whitelist', 'warning');
      return;
    }
    setStatus('listening', 'Starting…');
    const resp = await sendToContent('start', { settings });
    if (resp && resp.success) {
      setRunning(true);
    } else {
      setStatus('error', 'Error');
      showToast(resp.error || 'Could not start. Try refreshing the page.', 'error');
      setTimeout(() => setStatus('idle', 'Idle'), 3000);
    }
  }
});

// Swap languages
swapLangBtn.addEventListener('click', () => {
  const tmp           = settings.sourceLang;
  settings.sourceLang = settings.targetLang;
  settings.targetLang = tmp;
  applySettingsToUI();
  saveSettings();
  if (isRunning) syncSettingsToContent();
});

// Language selectors
sourceLangEl.addEventListener('change', () => {
  settings.sourceLang = sourceLangEl.value;
  saveSettings();
  if (isRunning) syncSettingsToContent();
});
targetLangEl.addEventListener('change', () => {
  settings.targetLang = targetLangEl.value;
  saveSettings();
  if (isRunning) syncSettingsToContent();
});

// Font size slider
fontSizeEl.addEventListener('input', () => {
  settings.fontSize       = parseInt(fontSizeEl.value, 10);
  fontSizeVal.textContent = settings.fontSize + 'px';
  saveSettings();
  syncSettingsToContent();
});

// Opacity slider
opacityEl.addEventListener('input', () => {
  settings.opacity       = parseFloat(opacityEl.value);
  opacityVal.textContent = Math.round(settings.opacity * 100) + '%';
  saveSettings();
  syncSettingsToContent();
});

// Position buttons
posTopBtn.addEventListener('click', () => {
  settings.position = 'top';
  updatePosButtons('top');
  saveSettings();
  syncSettingsToContent();
});
posBottomBtn.addEventListener('click', () => {
  settings.position = 'bottom';
  updatePosButtons('bottom');
  saveSettings();
  syncSettingsToContent();
});

// API key
apiKeyEl.addEventListener('change', () => {
  settings.apiKey = apiKeyEl.value.trim();
  saveSettings();
  syncSettingsToContent();
});

// Whitelist toggle
whitelistToggleEl.addEventListener('change', () => {
  settings.whitelistEnabled = whitelistToggleEl.checked;
  whitelistContainer.hidden = !whitelistToggleEl.checked;
  saveSettings();
});

// Whitelist input
whitelistInputEl.addEventListener('input', () => {
  settings.domainWhitelist = whitelistInputEl.value
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  saveSettings();
});

// Add current site to whitelist
addCurrentSiteBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    const hostname = new URL(tab.url).hostname;
    const current  = settings.domainWhitelist || [];
    if (current.includes(hostname)) {
      showToast(`${hostname} already in list`, 'info');
      return;
    }
    current.push(hostname);
    settings.domainWhitelist = current;
    whitelistInputEl.value   = current.join(', ');
    saveSettings();
    showToast(`Added: ${hostname}`, 'success');
  } catch (e) {
    showToast('Could not read current site', 'error');
  }
});

// Export buttons
exportTxtBtn.addEventListener('click', () => exportTranscript('txt'));
exportSrtBtn.addEventListener('click', () => exportTranscript('srt'));

// Clear transcript
clearBtn.addEventListener('click', async () => {
  await sendToContent('clearHistory');
  transcriptList.innerHTML = '<p class="empty-hint">Translations will appear here…</p>';
  if (ariaLiveEl) ariaLiveEl.textContent = '';
});

// ── Incoming messages from content script ────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;

  switch (message.action) {
    case 'newTranscript':
      if (message.payload) {
        const { original, translated, quality } = message.payload;
        addTranscriptItem(original, translated, quality);
        if (isRunning) setStatus('listening', 'Listening');
      }
      break;

    case 'stoppedFromOverlay':
      setRunning(false);
      break;

    case 'startedFromShortcut':
      setRunning(true);
      showToast('Started via keyboard shortcut (Ctrl+Shift+S)', 'success');
      break;

    case 'translationError':
      if (message.payload) showToast(message.payload.message, 'warning');
      break;

    case 'micDenied':
      if (message.payload) showToast(message.payload.message, 'error');
      setRunning(false);
      break;

    case 'browserNotSupported':
      if (message.payload) showToast(message.payload.message, 'error');
      setRunning(false);
      break;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  populateLangDropdowns();

  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(['translatorSettings'], resolve)
  );
  if (stored.translatorSettings) {
    settings = { ...settings, ...stored.translatorSettings };
  }
  applySettingsToUI();

  // Check running state
  const pingResp = await sendToContent('ping');
  if (pingResp && pingResp.success && pingResp.isRunning) {
    setRunning(true);
  }

  await restoreHistory();
  await checkPrivacy();
}

init();
