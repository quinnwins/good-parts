const input = document.getElementById('key');
const status = document.getElementById('status');

chrome.storage.local.get('apiKey').then(({ apiKey }) => { input.value = apiKey || ''; });

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: input.value.trim() });
  status.textContent = 'Saved';
});
