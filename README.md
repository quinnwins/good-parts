# Good Parts

A Chrome extension that lets you watch the best parts of a YouTube video at normal speed, plays the rest at 2x, and skips the filler and sponsors.

## Install

1. Download the newest `good-parts-x.y.z.zip` from [Releases](../../releases) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped `good-parts` folder.

## Use

Open a YouTube video and press **⏭ Good parts** in the player's bottom bar. It shows how long the cut takes, for example **⏭ 2x · 11 min**. The button next to it switches between that and a shorter cut, where the rest plays at 3x. Press the gold button again to go back to the full video.

On videos 8 minutes or longer, Good Parts works out the cut after you've watched 30 seconds, so the button can say **Watch in 11 min** before you press it.

## How it works

- Good Parts reads the video's captions and asks an AI which parts are the best. Claude works with no key. You can pick Gemini or GPT, or add your own Claude key, in settings: `chrome://extensions`, then Good Parts, Details, Extension options.
- Videos without captions need a Gemini key, because only Gemini can watch a video itself.
- Sponsor reads are skipped on every video, using [SponsorBlock](https://sponsor.ajay.app/). You can turn this off in settings.

## Privacy

- A video's title and captions go to the AI you picked. Without your own Claude key, they go to the Good Parts server, which asks Claude and saves the answer, so the next person who watches that video gets it instantly. The server allows each internet address 30 new videos a day.
- SponsorBlock is asked about a group of videos that share the start of a scrambled form of the video's ID, so it never learns which one you're watching.
- Your keys stay in your browser.

## For developers

- `share.sh` builds the zip from the extension's own files, so key files never go in it.
- Pushing a tag that matches `manifest.json`'s version (for example `v1.7.4`) builds the zip and publishes it as a release.
- `server/` is the Cloudflare Worker behind the free Claude. Deploy it with `npx wrangler deploy` in that folder.

## License

MIT. See [LICENSE](LICENSE).
