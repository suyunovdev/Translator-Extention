// background.js — Service Worker for Real-Time Speech Translator v2
// Uses chrome.alarms for keep-alive (correct MV3 approach).
// Single onMessage listener handles all routing.

// ── Keep-alive via chrome.alarms (replaces fragile setTimeout) ──────────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 }); // every 24s
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // No-op — accessing chrome.alarms itself keeps the service worker alive
  }
});

// ── Lifecycle ────────────────────────────────────────────────────────────────
self.addEventListener('install', () => {
  console.log('[SpeechTranslator BG] v2 installed.');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SpeechTranslator BG] v2 activated.');
  event.waitUntil(clients.claim());
});

// ── Keyboard shortcut handler ────────────────────────────────────────────────
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-listening') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;
    const tabId = tabs[0].id;
    chrome.tabs.sendMessage(tabId, { target: 'content', action: 'toggle' }, (response) => {
      if (chrome.runtime.lastError) {
        // Content script not ready — inject then retry
        chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
          if (chrome.runtime.lastError) return;
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { target: 'content', action: 'toggle' });
          }, 300);
        });
      }
    });
  });
});

// ── Unified message relay ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // popup → content script
  if (message.target === 'content') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        sendResponse({ success: false, error: 'No active tab found' });
        return;
      }
      const tabId = tabs[0].id;

      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          // Inject content script and retry once
          chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
            if (chrome.runtime.lastError) {
              sendResponse({
                success: false,
                error: `Cannot inject: ${chrome.runtime.lastError.message}`,
              });
              return;
            }
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, message, (r) => {
                if (chrome.runtime.lastError) {
                  sendResponse({ success: false, error: chrome.runtime.lastError.message });
                } else {
                  sendResponse(r || { success: true });
                }
              });
            }, 350);
          });
        } else {
          sendResponse(response || { success: true });
        }
      });
    });
    return true; // async response
  }

  // content script → popup
  if (message.target === 'popup') {
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup is closed — ignore silently
    });
    sendResponse({ success: true });
    return false;
  }
});
