# YouTube Caption Karaoke (Chrome Extension, Manifest V3)

Turns a YouTube video's auto-generated captions into a full-line **karaoke
overlay**: the active line is shown centered over the player and each word is
highlighted in sync with the audio using the caption track's **real per-word
timing**.

## What it does

- Runs only on `https://www.youtube.com/*` `/watch` pages.
- Installs network-capture hooks at `document_start` (before the player loads),
  so the player's first `timedtext` `json3` request is captured automatically —
  you do **not** need to manually turn captions on.
- Picks the auto-speech-recognition (`asr`) caption track from the player
  response, parses the captured json3, and renders a karaoke overlay
  (`.yk-word--active` / `--past` / `--future`).
- Re-initializes automatically on YouTube SPA navigation (next video,
  search → video, etc.).
- A small **Karaoke: ON/OFF** button appears in the top-right of the player
  (visible on hover). The state is persisted in `localStorage`.

## What it does NOT do

- It does **not** mute the video or change audio.
- It does **not** disable autoplay-next or otherwise interfere with playback.
- It does **not** simulate or interpolate word timing. Highlighting is driven
  only by the caption data's real `tOffsetMs` values.

## Word-level timing caveat

Most YouTube auto-captions (ASR) include per-word offsets, so words light up one
by one. However, **some videos' auto-captions are line-level only** (no per-word
offsets). For those, every word in a line shares the same start time, so the
overlay highlights **per line** instead of per word. This is expected: we never
fabricate timing that the caption track does not provide.

If a video has no caption track at all (no auto-captions available), the overlay
will not appear.

## Load unpacked (development)

1. Open `chrome://extensions` in Chrome (or any Chromium browser).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this `extension/` folder.
5. Open any `https://www.youtube.com/watch?...` video that has auto-captions.

## Files

- `manifest.json` — MV3 manifest. The content script runs in the `MAIN` world at
  `document_start` and requires no special permissions.
- `content.js` — the karaoke logic (network capture, track pick, json3 parse,
  line grouping, overlay render, SPA re-init, on/off toggle).
- `popup.html` — informational action popup.
- `icons/` — 16/48/128 px icons.

## Notes

- No host permissions are requested; the content script only touches the page it
  is injected into (matched to `www.youtube.com`).
- The logic is adapted from the project's validated `karaoke.js`. The shipped
  version removes dev-only behaviors (mute, autoplay changes, forced CC toggling)
  and adds early hook installation + SPA lifecycle handling.
