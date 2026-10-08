// On install or reload: pick up keys dropped next to the extension, so they work without a setup step.
const KEY_FILES = { apiKey: 'key.txt', claudeKey: 'claude-key.txt' };
chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get(Object.keys(KEY_FILES));
  for (const [name, file] of Object.entries(KEY_FILES)) {
    if (saved[name]) continue;
    try {
      const key = (await (await fetch(chrome.runtime.getURL(file))).text()).trim();
      if (key) await chrome.storage.local.set({ [name]: key });
    } catch {}
  }
});

// Content scripts can't open the settings page themselves.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === 'openOptions') chrome.runtime.openOptionsPage();
});
