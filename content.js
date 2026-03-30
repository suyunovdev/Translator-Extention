// content.js — Real-Time Speech Translator v2 (Content Script)
// Fixes: drag-position bug, API timeout, rate limiting, event listener cleanup,
//        accessibility (aria-live), language label, quality score, reset button.

(function () {
  'use strict';

  // ── Guard: prevent double-injection ────────────────────────────────────────
  if (window.__speechTranslatorLoaded) return;
  window.__speechTranslatorLoaded = true;

  // ── Constants ──────────────────────────────────────────────────────────────
  const DEBOUNCE_MS        = 800;
  const API_TIMEOUT_MS     = 8000;
  const MAX_HISTORY        = 50;
  const MYMEMORY_URL       = 'https://api.mymemory.translated.net/get';
  const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';

  // MyMemory requires full locale codes for some languages
  const LANG_LOCALE_MAP = {
    'uz': 'uz-UZ', 'az': 'az-AZ', 'ky': 'ky-KG', 'tk': 'tk-TM',
    'tg': 'tg-TJ', 'kk': 'kk-KZ', 'mn': 'mn-MN', 'hy': 'hy-AM',
    'ka': 'ka-GE', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW',
  };

  function toLocale(code) {
    return LANG_LOCALE_MAP[code] || code;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let recognition      = null;
  let isRunning        = false;
  let isTranslating    = false;
  let pendingText      = null;
  let settings = {
    sourceLang:       'en',
    targetLang:       'uz',
    fontSize:         18,
    opacity:          0.85,
    position:         'bottom',
    apiKey:           '',
  };
  let debounceTimer    = null;
  let lastInterim      = '';
  let overlay          = null;
  let subtitleEl       = null;
  let interimEl        = null;
  let statusDotEl      = null;
  let langLabelEl      = null;
  let qualityBadgeEl   = null;
  let ariaLiveEl       = null;
  let isDragging       = false;
  let hasDragged       = false;   // track whether user has manually repositioned overlay
  let dragOffsetX      = 0;
  let dragOffsetY      = 0;
  let history          = [];

  // ── Named event handlers for cleanup ───────────────────────────────────────
  function onDocMouseMove(e) {
    if (!isDragging || !overlay) return;
    overlay.style.left = (e.clientX - dragOffsetX) + 'px';
    overlay.style.top  = (e.clientY - dragOffsetY) + 'px';
  }

  function onDocMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    if (overlay) overlay.style.cursor = 'grab';
  }

  function cleanup() {
    document.removeEventListener('mousemove', onDocMouseMove);
    document.removeEventListener('mouseup',   onDocMouseUp);
  }

  window.addEventListener('beforeunload', cleanup);

  // ── Load settings and build overlay ────────────────────────────────────────
  chrome.storage.local.get(['translatorSettings'], (result) => {
    if (result.translatorSettings) {
      settings = { ...settings, ...result.translatorSettings };
    }
    buildOverlay();
  });

  // ── Fetch with timeout (AbortController) ───────────────────────────────────
  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Overlay position helper ─────────────────────────────────────────────────
  function applyOverlayPosition() {
    if (!overlay) return;
    overlay.style.left      = '50%';
    overlay.style.transform = 'translateX(-50%)';
    overlay.style.right     = 'auto';
    if (settings.position === 'top') {
      overlay.style.top    = '20px';
      overlay.style.bottom = 'auto';
    } else {
      overlay.style.bottom = '24px';
      overlay.style.top    = 'auto';
    }
  }

  function updateLangLabel() {
    if (langLabelEl) {
      langLabelEl.textContent =
        settings.sourceLang.toUpperCase() + ' → ' + settings.targetLang.toUpperCase();
    }
  }

  // ── Build floating overlay ──────────────────────────────────────────────────
  function buildOverlay() {
    if (document.getElementById('__spt-overlay')) return;

    overlay = document.createElement('div');
    overlay.id = '__spt-overlay';
    overlay.setAttribute('role', 'region');
    overlay.setAttribute('aria-label', 'Speech Translator');

    Object.assign(overlay.style, {
      position:            'fixed',
      zIndex:              '2147483647',
      minWidth:            '300px',
      maxWidth:            '700px',
      width:               'max-content',
      padding:             '12px 18px 10px',
      background:          `rgba(15, 15, 20, ${settings.opacity})`,
      border:              '1px solid rgba(255,255,255,0.12)',
      borderRadius:        '16px',
      boxShadow:           '0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)',
      backdropFilter:      'blur(14px)',
      WebkitBackdropFilter:'blur(14px)',
      fontFamily:          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      userSelect:          'none',
      cursor:              'grab',
      transition:          'opacity 0.2s',
      display:             'none',
    });

    applyOverlayPosition();

    // ── Header ────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    Object.assign(header.style, {
      display:       'flex',
      alignItems:    'center',
      gap:           '7px',
      marginBottom:  '6px',
    });

    // Status dot (color indicator)
    statusDotEl = document.createElement('span');
    statusDotEl.id = '__spt-dot';
    Object.assign(statusDotEl.style, {
      width: '8px', height: '8px',
      borderRadius:  '50%',
      background:    '#555',
      display:       'inline-block',
      flexShrink:    '0',
      transition:    'background 0.3s',
    });

    // Language label e.g. "EN → UZ"
    langLabelEl = document.createElement('span');
    langLabelEl.id = '__spt-lang';
    Object.assign(langLabelEl.style, {
      fontSize:       '10px',
      fontWeight:     '700',
      color:          'rgba(255,255,255,0.65)',
      letterSpacing:  '0.6px',
    });
    updateLangLabel();

    // App label
    const appLabel = document.createElement('span');
    Object.assign(appLabel.style, {
      fontSize: '10px',
      color:    'rgba(255,255,255,0.25)',
    });
    appLabel.textContent = '· Speech Translator';

    // Reset position button
    const resetBtn = document.createElement('button');
    resetBtn.title = 'Reset position';
    resetBtn.setAttribute('aria-label', 'Reset overlay position');
    resetBtn.textContent = '⊹';
    Object.assign(resetBtn.style, {
      background:  'none',
      border:      'none',
      color:       'rgba(255,255,255,0.25)',
      fontSize:    '14px',
      cursor:      'pointer',
      padding:     '0 2px',
      lineHeight:  '1',
      transition:  'color 0.2s',
    });
    resetBtn.addEventListener('mouseover', () => (resetBtn.style.color = 'rgba(255,255,255,0.7)'));
    resetBtn.addEventListener('mouseout',  () => (resetBtn.style.color = 'rgba(255,255,255,0.25)'));
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hasDragged = false;
      applyOverlayPosition();
    });

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close translator overlay');
    Object.assign(closeBtn.style, {
      marginLeft:  'auto',
      background:  'none',
      border:      'none',
      color:       'rgba(255,255,255,0.35)',
      fontSize:    '13px',
      cursor:      'pointer',
      padding:     '0 2px',
      lineHeight:  '1',
      transition:  'color 0.2s',
    });
    closeBtn.addEventListener('mouseover', () => (closeBtn.style.color = 'rgba(255,255,255,0.9)'));
    closeBtn.addEventListener('mouseout',  () => (closeBtn.style.color = 'rgba(255,255,255,0.35)'));
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      stopRecognition();
      overlay.style.display = 'none';
      chrome.runtime.sendMessage({ target: 'popup', action: 'stoppedFromOverlay' }).catch(() => {});
    });

    header.append(statusDotEl, langLabelEl, appLabel, resetBtn, closeBtn);

    // ── Interim text ──────────────────────────────────────────────────────
    interimEl = document.createElement('div');
    interimEl.id = '__spt-interim';
    interimEl.setAttribute('aria-hidden', 'true');
    Object.assign(interimEl.style, {
      fontSize:    (settings.fontSize - 2) + 'px',
      color:       'rgba(255,255,255,0.4)',
      minHeight:   '1.3em',
      lineHeight:  '1.4',
      fontStyle:   'italic',
      wordBreak:   'break-word',
    });

    // ── Final translated subtitle ─────────────────────────────────────────
    subtitleEl = document.createElement('div');
    subtitleEl.id = '__spt-subtitle';
    Object.assign(subtitleEl.style, {
      fontSize:    settings.fontSize + 'px',
      fontWeight:  '600',
      color:       '#ffffff',
      lineHeight:  '1.5',
      minHeight:   '1.5em',
      wordBreak:   'break-word',
      textShadow:  '0 1px 4px rgba(0,0,0,0.7)',
    });

    // ── Quality badge ─────────────────────────────────────────────────────
    qualityBadgeEl = document.createElement('span');
    qualityBadgeEl.id = '__spt-quality';
    Object.assign(qualityBadgeEl.style, {
      display:      'none',
      fontSize:     '10px',
      padding:      '1px 6px',
      borderRadius: '4px',
      marginTop:    '4px',
      fontWeight:   '600',
      verticalAlign:'middle',
      marginLeft:   '8px',
    });

    // ── aria-live (screen readers) ────────────────────────────────────────
    ariaLiveEl = document.createElement('div');
    ariaLiveEl.setAttribute('aria-live', 'polite');
    ariaLiveEl.setAttribute('aria-atomic', 'true');
    Object.assign(ariaLiveEl.style, {
      position:   'absolute',
      width:      '1px',
      height:     '1px',
      overflow:   'hidden',
      clip:       'rect(0,0,0,0)',
      whiteSpace: 'nowrap',
    });

    // Subtitle row (text + quality badge inline)
    const subtitleRow = document.createElement('div');
    Object.assign(subtitleRow.style, { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap' });
    subtitleRow.append(subtitleEl, qualityBadgeEl);

    overlay.append(header, interimEl, subtitleRow, ariaLiveEl);
    document.documentElement.appendChild(overlay);

    // ── Drag support ──────────────────────────────────────────────────────
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === closeBtn || e.target === resetBtn) return;
      isDragging   = true;
      hasDragged   = true;
      const rect   = overlay.getBoundingClientRect();
      dragOffsetX  = e.clientX - rect.left;
      dragOffsetY  = e.clientY - rect.top;
      // Lock to absolute coords so position toggles don't fight the drag
      overlay.style.transform = 'none';
      overlay.style.left      = rect.left + 'px';
      overlay.style.top       = rect.top  + 'px';
      overlay.style.bottom    = 'auto';
      overlay.style.right     = 'auto';
      overlay.style.cursor    = 'grabbing';
    });

    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup',   onDocMouseUp);
  }

  // ── Status dot ─────────────────────────────────────────────────────────────
  function setStatus(state) {
    if (!statusDotEl) return;
    const colors = {
      idle:        '#555',
      listening:   '#22c55e',
      translating: '#f59e0b',
      error:       '#ef4444',
    };
    statusDotEl.style.background = colors[state] || colors.idle;
  }

  function showInterim(text) {
    if (interimEl) interimEl.textContent = text;
  }

  function showTranslation(text, quality = null) {
    console.log('[SpeechTranslator] Translation result:', text);
    if (subtitleEl) {
      subtitleEl.textContent = text;
      subtitleEl.style.opacity = '1';
    }

    // Announce to screen readers
    if (ariaLiveEl) ariaLiveEl.textContent = text;

    // Quality badge: show when confidence < 80%
    if (qualityBadgeEl) {
      if (quality !== null) {
        const pct = Math.round(quality * 100);
        if (pct < 80) {
          qualityBadgeEl.style.display = 'inline-block';
          qualityBadgeEl.textContent   = pct + '% match';
          if (pct < 50) {
            qualityBadgeEl.style.background = 'rgba(239,68,68,0.2)';
            qualityBadgeEl.style.color      = '#ef4444';
          } else {
            qualityBadgeEl.style.background = 'rgba(245,158,11,0.2)';
            qualityBadgeEl.style.color      = '#f59e0b';
          }
        } else {
          qualityBadgeEl.style.display = 'none';
        }
      } else {
        qualityBadgeEl.style.display = 'none';
      }
    }
  }

  // ── Translation: MyMemory (primary) ────────────────────────────────────────
  async function translateMyMemory(text, from, to) {
    const langPair = toLocale(from) + '|' + toLocale(to);
    let url = `${MYMEMORY_URL}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;
    if (settings.apiKey) url += `&key=${encodeURIComponent(settings.apiKey)}`;

    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`MyMemory HTTP ${response.status}`);
    const data = await response.json();
    if (data.responseStatus !== 200) throw new Error(data.responseDetails || 'MyMemory error');

    return {
      text:    data.responseData.translatedText,
      quality: typeof data.responseData.match === 'number' ? data.responseData.match : null,
    };
  }

  // ── Translation: Google Translate unofficial (fallback) ────────────────────
  async function translateGoogle(text, from, to) {
    const params = new URLSearchParams({
      client: 'gtx',
      sl:     from === 'auto' ? 'auto' : from.split('-')[0],
      tl:     to.split('-')[0],
      dt:     't',
      q:      text,
    });
    const response = await fetchWithTimeout(`${GOOGLE_TRANSLATE_URL}?${params}`);
    if (!response.ok) throw new Error(`Google Translate HTTP ${response.status}`);
    const data = await response.json();
    // Response format: [[[translatedText, originalText, ...]]]
    const translated = data[0].map((chunk) => chunk[0]).filter(Boolean).join('');
    if (!translated) throw new Error('Empty translation response');
    return { text: translated, quality: null };
  }

  // ── Main translate dispatcher (with rate limiting) ──────────────────────────
  async function translate(text) {
    if (!text || !text.trim()) return;

    // Rate limiting: queue latest while a request is in-flight
    if (isTranslating) {
      pendingText = text;
      return;
    }

    isTranslating = true;
    setStatus('translating');

    try {
      let result;
      try {
        result = await translateMyMemory(text, settings.sourceLang, settings.targetLang);
      } catch (e1) {
        console.warn('[SpeechTranslator] MyMemory failed, trying Google Translate:', e1.message);
        result = await translateGoogle(text, settings.sourceLang, settings.targetLang);
      }

      showTranslation(result.text, result.quality);

      const entry = { original: text, translated: result.text, quality: result.quality, ts: Date.now() };
      history.push(entry);
      if (history.length > MAX_HISTORY) history.shift();

      chrome.runtime.sendMessage({
        target:  'popup',
        action:  'newTranscript',
        payload: { original: text, translated: result.text, quality: result.quality },
      }).catch(() => {});

    } catch (err) {
      const msg = err.name === 'AbortError'
        ? '[Translation timed out — check connection]'
        : '[Translation failed]';
      console.error('[SpeechTranslator] All APIs failed:', err.message);
      showTranslation(msg);
      setStatus('error');
      chrome.runtime.sendMessage({
        target:  'popup',
        action:  'translationError',
        payload: { message: err.name === 'AbortError' ? 'API request timed out' : err.message },
      }).catch(() => {});

    } finally {
      isTranslating = false;
      if (isRunning) setStatus('listening');

      // Drain the pending queue (only one item)
      if (pendingText) {
        const next = pendingText;
        pendingText = null;
        translate(next);
      }
    }
  }

  // ── Speech Recognition setup ────────────────────────────────────────────────
  function setupRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error('[SpeechTranslator] Web Speech API not supported.');
      chrome.runtime.sendMessage({
        target:  'popup',
        action:  'browserNotSupported',
        payload: { message: 'Your browser does not support the Web Speech API. Please use Chrome or Edge.' },
      }).catch(() => {});
      return null;
    }

    const rec           = new SpeechRecognition();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = settings.sourceLang;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      console.log('[SpeechTranslator] Recognition started. Lang:', rec.lang);
      setStatus('listening');
    };

    rec.onresult = (event) => {
      console.log('[SpeechTranslator] onresult fired, results:', event.results.length);
      let interimTranscript = '';
      let finalTranscript   = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += t;
        } else {
          interimTranscript += t;
        }
      }

      if (interimTranscript) {
        showInterim(interimTranscript);
        lastInterim = interimTranscript;
      }

      if (finalTranscript) {
        showInterim('');
        clearTimeout(debounceTimer);
        translate(finalTranscript.trim());
      } else if (interimTranscript) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (lastInterim) {
            translate(lastInterim.trim());
            lastInterim = '';
          }
        }, DEBOUNCE_MS);
      }
    };

    rec.onerror = (event) => {
      if (event.error === 'no-speech') {
        // Normal — silence detected, auto-restart will handle it
        return;
      }
      console.error('[SpeechTranslator] Recognition error:', event.error);
      setStatus('error');

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        isRunning = false;
        chrome.runtime.sendMessage({
          target:  'popup',
          action:  'micDenied',
          payload: { message: 'Microphone access denied. Allow microphone in browser settings.' },
        }).catch(() => {});
        return;
      }

      if (isRunning) {
        setTimeout(() => {
          if (isRunning) { try { rec.start(); } catch (e) {} }
        }, 1000);
      }
    };

    rec.onend = () => {
      setStatus('idle');
      if (isRunning) {
        try { rec.start(); } catch (e) {}
      }
    };

    return rec;
  }

  // ── Start / Stop ────────────────────────────────────────────────────────────
  function startRecognition() {
    if (isRunning) return;
    if (!recognition) recognition = setupRecognition();
    if (!recognition) return;

    recognition.lang = settings.sourceLang;
    isRunning        = true;
    hasDragged       = false; // reset drag so position setting takes effect
    overlay.style.display = 'block';
    applyOverlayPosition();
    updateLangLabel();

    try {
      recognition.start();
    } catch (e) {
      console.warn('[SpeechTranslator] start() error:', e);
    }
  }

  function stopRecognition() {
    isRunning = false;
    clearTimeout(debounceTimer);
    if (recognition) {
      try { recognition.stop(); } catch (e) {}
    }
    showInterim('');
    setStatus('idle');
  }

  // ── Apply settings from popup ───────────────────────────────────────────────
  function applySettings(newSettings) {
    settings = { ...settings, ...newSettings };

    if (subtitleEl) subtitleEl.style.fontSize = settings.fontSize + 'px';
    if (interimEl)  interimEl.style.fontSize  = (settings.fontSize - 2) + 'px';

    if (overlay) {
      overlay.style.background = `rgba(15, 15, 20, ${settings.opacity})`;
      // Only reposition if user hasn't manually dragged overlay
      if (!hasDragged) applyOverlayPosition();
    }

    updateLangLabel();

    // Restart recognition with updated language
    if (recognition && isRunning) {
      try { recognition.stop(); } catch (e) {}
      recognition = null;
    }
  }

  // ── Message listener ────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {

      case 'start':
        if (message.settings) applySettings(message.settings);
        startRecognition();
        sendResponse({ success: true, status: 'started' });
        break;

      case 'stop':
        stopRecognition();
        if (overlay) overlay.style.display = 'none';
        sendResponse({ success: true, status: 'stopped' });
        break;

      case 'toggle':
        if (isRunning) {
          stopRecognition();
          if (overlay) overlay.style.display = 'none';
          chrome.runtime.sendMessage({ target: 'popup', action: 'stoppedFromOverlay' }).catch(() => {});
        } else {
          startRecognition();
          chrome.runtime.sendMessage({ target: 'popup', action: 'startedFromShortcut' }).catch(() => {});
        }
        sendResponse({ success: true, isRunning });
        break;

      case 'updateSettings':
        applySettings(message.settings);
        sendResponse({ success: true });
        break;

      case 'getHistory':
        sendResponse({ success: true, history });
        break;

      case 'clearHistory':
        history = [];
        if (subtitleEl)      subtitleEl.textContent         = '';
        if (interimEl)       interimEl.textContent          = '';
        if (qualityBadgeEl)  qualityBadgeEl.style.display   = 'none';
        if (ariaLiveEl)      ariaLiveEl.textContent         = '';
        sendResponse({ success: true });
        break;

      case 'ping':
        sendResponse({ success: true, isRunning });
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }
    return false;
  });

})();
