// DevenClaw Claude Usage Relay — content script
// Runs on claude.ai/settings/usage, scrapes usage data and relays via background worker

const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

function scrapeUsage() {
  const data = {
    session: null,
    weeklyAll: null,
    weeklySonnet: null,
    scrapedAt: new Date().toISOString(),
  };

  // Find all text content on the page
  const body = document.body.innerText;

  // Current session
  const sessionReset = body.match(/Current session\s*\n\s*Resets in ([^\n]+)/);
  const sessionPct = body.match(/Current session[\s\S]*?(\d+)% used/);
  if (sessionPct) {
    data.session = {
      percent: parseInt(sessionPct[1]),
      resetIn: sessionReset ? sessionReset[1].trim() : null,
    };
  }

  // Weekly limits — All models
  const allModelsReset = body.match(/All models\s*\n\s*Resets ([^\n]+)/);
  // Find "All models" section percent — it's the first percent after "All models"
  const allModelSection = body.split('All models')[1];
  if (allModelSection) {
    const allPct = allModelSection.match(/(\d+)% used/);
    if (allPct) {
      data.weeklyAll = {
        percent: parseInt(allPct[1]),
        resets: allModelsReset ? allModelsReset[1].trim() : null,
      };
    }
  }

  // Sonnet only
  const sonnetReset = body.match(/Sonnet only[\s\S]*?Resets ([^\n]+)/);
  const sonnetSection = body.split('Sonnet only')[1];
  if (sonnetSection) {
    const sonnetPct = sonnetSection.match(/(\d+)% used/);
    if (sonnetPct) {
      data.weeklySonnet = {
        percent: parseInt(sonnetPct[1]),
        resets: sonnetReset ? sonnetReset[1].trim() : null,
      };
    }
  }

  return data;
}

async function scrapeAndSend() {
  // Wait a bit for page to fully render
  await new Promise(r => setTimeout(r, 2000));
  const data = scrapeUsage();
  if (data.session || data.weeklyAll || data.weeklySonnet) {
    // Send to background worker (avoids CORS issues)
    chrome.runtime.sendMessage({ type: 'usage-data', data }, (resp) => {
      if (resp?.ok) {
        console.log('[DevenClaw] Usage data sent via background:', data);
      } else {
        console.warn('[DevenClaw] Background relay failed:', resp?.error);
      }
    });
  } else {
    console.warn('[DevenClaw] Could not scrape usage data');
  }
}

// Run on page load
scrapeAndSend();

// Re-scrape periodically while page is open
setInterval(scrapeAndSend, POLL_INTERVAL_MS);

// Also scrape when page becomes visible again (e.g., tab switch)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    scrapeAndSend();
  }
});
