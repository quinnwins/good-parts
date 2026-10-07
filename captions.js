// Runs inside YouTube's own page so it can see the caption file the player downloads.
// YouTube refuses caption downloads that lack the player's security token, so Good Parts
// catches the player's own download and passes it to content.js.
(() => {
  const isCaptions = (url) => String(url).includes('/api/timedtext');
  const share = (url, text) => {
    const v = new URL(url, location.href).searchParams.get('v');
    if (v && text) window.postMessage({ goodPartsCaptions: { v, text } }, location.origin);
  };

  const fetch = window.fetch;
  window.fetch = async function (input) {
    const res = await fetch.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url;
    if (isCaptions(url)) res.clone().text().then((text) => share(url, text), () => {});
    return res;
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isCaptions(url)) {
      this.addEventListener('load', () => {
        const r = this.response;
        share(url, typeof r === 'string' ? r : r && !(r instanceof ArrayBuffer) ? JSON.stringify(r) : '');
      });
    }
    return open.apply(this, arguments);
  };
})();
