// Background service worker — handles cross-origin requests and periodic refresh

const DEVENCLAW_URL = 'https://mc.neved.in/api/claude-usage';
const USAGE_URL = 'https://claude.ai/settings/usage';
const ALARM_NAME = 'claude-usage-refresh';

// Listen for usage data from content script and relay to DevenClaw
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'usage-data') {
    fetch(DEVENCLAW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.data),
    })
      .then((resp) => {
        if (resp.ok) {
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: `HTTP ${resp.status}` });
        }
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }
});

// Create alarm to refresh usage page every 2 minutes
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 2 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    // Check if the usage tab is already open
    chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' }, (tabs) => {
      if (tabs.length > 0) {
        // Reload the existing tab to trigger content script
        chrome.tabs.reload(tabs[0].id);
      } else {
        // Open a pinned background tab so scraping works even without a visible tab
        chrome.tabs.create({ url: USAGE_URL, active: false, pinned: true });
      }
    });
  }
});
