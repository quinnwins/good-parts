const KEYS = ['apiKey', 'claudeKey', 'openaiKey'];
const status = document.getElementById('status');
const skipSponsors = document.getElementById('skipSponsors');

chrome.storage.local.get(['provider', 'skipSponsors', ...KEYS]).then((saved) => {
  for (const k of KEYS) document.getElementById(k).value = saved[k] || '';
  skipSponsors.checked = saved.skipSponsors !== false;
  const provider = saved.provider || 'claude';
  document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
});

document.getElementById('save').addEventListener('click', async () => {
  const values = Object.fromEntries(KEYS.map((k) => [k, document.getElementById(k).value.trim()]));
  values.provider = document.querySelector('input[name="provider"]:checked').value;
  values.skipSponsors = skipSponsors.checked;
  await chrome.storage.local.set(values);
  status.textContent = 'Saved';
});
