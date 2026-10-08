const KEYS = ['apiKey', 'claudeKey', 'openaiKey'];
const status = document.getElementById('status');

chrome.storage.local.get(['provider', ...KEYS]).then((saved) => {
  for (const k of KEYS) document.getElementById(k).value = saved[k] || '';
  const provider = saved.provider || 'gemini';
  document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
});

document.getElementById('save').addEventListener('click', async () => {
  const values = Object.fromEntries(KEYS.map((k) => [k, document.getElementById(k).value.trim()]));
  values.provider = document.querySelector('input[name="provider"]:checked').value;
  await chrome.storage.local.set(values);
  status.textContent = 'Saved';
});
