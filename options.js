const KEYS = ['apiKey', 'claudeKey', 'openaiKey'];
const status = document.getElementById('status');

chrome.storage.local.get(['provider', 'faster', ...KEYS]).then((saved) => {
  for (const k of KEYS) document.getElementById(k).value = saved[k] || '';
  document.getElementById('faster').checked = !!saved.faster;
  const provider = saved.provider || 'claude';
  document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
});

document.getElementById('save').addEventListener('click', async () => {
  const values = Object.fromEntries(KEYS.map((k) => [k, document.getElementById(k).value.trim()]));
  values.provider = document.querySelector('input[name="provider"]:checked').value;
  values.faster = document.getElementById('faster').checked;
  await chrome.storage.local.set(values);
  status.textContent = 'Saved';
});
