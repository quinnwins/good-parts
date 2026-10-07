// First install: pick up a key dropped next to the extension as key.txt, so it works without a setup step.
chrome.runtime.onInstalled.addListener(async () => {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) return;
  try {
    const key = (await (await fetch(chrome.runtime.getURL('key.txt'))).text()).trim();
    if (key) await chrome.storage.local.set({ apiKey: key });
  } catch {}
});

// Content scripts can't open the settings page themselves.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === 'openOptions') chrome.runtime.openOptionsPage();
});
