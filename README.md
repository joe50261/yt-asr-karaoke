# YouTube Caption Karaoke (Chrome Extension, Manifest V3)

Turns a YouTube video's **auto-generated captions** into a karaoke overlay: the
active line is shown centered over the player and each word lights up in sync
with the audio using the caption track's **real per-word timing** (never
simulated). Also supports YouTube's **auto-translated** auto-captions, including
a **bilingual dual-track** view.

## How it works (the short version)

The extension is a **passive binding** to whatever auto-caption the player is
currently displaying — it never fetches captions and never drives the player:

- **player** — YouTube's player is the only thing that can *fetch* a caption
  track; its requests carry a `pot` (proof-of-origin) token. A direct fetch of
  the caption URL is `pot`-gated and returns an empty body, so we never do it.
- **hook** — a `document_start` hook passively *captures* the body of the
  player's own `timedtext` request for the auto-caption (`kind=asr`, plus
  `tlang=…` for a translation). It only captures; it never fetches.
- **us** — we read the player's currently selected track, find the matching
  captured body, parse its json3, and render the karaoke overlay.

Because of this, **you select the auto-caption yourself** (it's the player's own
caption, not something we force on). See *Using it* below.

## Using it

1. Open a `https://www.youtube.com/watch?...` video.
2. In the player's caption menu (gear → Subtitles), choose the
   **auto-generated** track (e.g. `English (auto-generated)` / `英文 (自動產生)`).
   The karaoke overlay binds to it and highlights per word.
3. For a translation, pick **Auto-translate** → a language
   (e.g. `English (auto-generated) >> 中文`). The overlay switches to that
   language, still per word.
4. The **Karaoke: ON/OFF** button (top-right of the player, visible on hover)
   toggles the overlay. State is remembered per browser (`localStorage`).
5. **Resize the caption box width**: hover the overlay and drag the grip on its
   right edge (the centered box widens/narrows symmetrically, changing how lines
   wrap); double-click the grip to reset to fit the text. Saved per browser.

If you select a **non-auto** caption (a manual/uploaded subtitle) or turn
captions off, the extension **steps aside** and lets the player's own caption
show — it never overrides another caption or leaves a blank one.

## Side transcript

A **字幕全文** button (top-right of the player, below the Karaoke button) opens an
expandable side panel with the **full caption transcript**. The line currently
playing is highlighted and auto-scrolled into view, with its active word
karaoke-highlighted as it's spoken. **Click any line to jump** the video to it.
**Drag the panel's left edge to resize its width**; **double-click that edge to
fit the width** to the longest line (remembered per browser). In
dual-track mode the transcript is bilingual: original and translation rows are
interleaved by time as bilingual pairs — each translation sits tight under its
original with looser space between pairs, and is shown a shade lighter
(distinguished by colour, not indentation) — each highlighting its own
active line. The panel stays in sync with playback, hides when the extension steps
aside, and remembers its open/closed state and width. It **follows YouTube's own
light/dark theme** (keyed off `<html dark>`), so it matches the page in either mode.

## Popup options

Click the toolbar icon:

- **Caption style** — the overlay's look, applied live:
  - `預設` (default) — gold active word with a soft glow and a slight pop.
  - `YT` — matches YouTube's native caption (weight 400, white, near-square box);
    the active word is a flat gold, no flourish.
  - `進階` (advanced) — the active word **fills left-to-right over its spoken
    duration** (a true per-word sweep) with a progress underline and no scaling
    jitter; lighter box with an edge shadow; in dual-track the translation row is
    subordinate (smaller, dimmer) so the source leads.
- **Bilingual (dual-track)** — when an auto-translation is selected, show the
  original *and* the translation as two stacked, per-word rows (overlay) and
  interleaved in the transcript. Each row is timed to its own track and follows
  that track's line structure, so the two stay roughly in step. Needs both bodies
  loaded: select `自動產生` once, then `自動翻譯` (selecting a translation
  directly never loads the original — it then shows just the one available).
- **Translation on top** — in dual-track, stack the translation above the
  original instead of below. Applies to both the overlay and the side transcript
  (they follow the same row order).

## Line breaks

Lines break where the **caption data itself** breaks (YouTube's json3 includes its
own `\n` line markers — the source's intended, semantic lines), plus a speaker
change (`>>`). There is **no word-count cap** — long lines simply wrap via CSS, so
nothing gets chopped mid-phrase. The only fallback is for captions that carry no
`\n` structure at all, where lines break on a speech pause instead.

## What it does NOT do

- Does **not** fetch captions (it can't — `timedtext` is `pot`-gated) and does
  **not** drive/auto-switch the player's caption selection.
- Does **not** mute the video, change audio, or affect autoplay-next.
- Does **not** simulate or interpolate word timing — highlighting uses only the
  caption data's real `tOffsetMs`. Some videos' auto-captions are line-level only
  (no per-word offsets); those highlight per line.
- Does **not** override another caption: it only hides the native caption while
  it is actively showing the asr karaoke.

## Load unpacked (development)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open a `youtube.com/watch` video and select its auto-generated caption.

After editing files, click the extension's **reload** (↻) on `chrome://extensions`
and reload the YouTube tab.

## Files

- `manifest.json` — MV3 manifest. `content.js` runs in the `MAIN` world at
  `document_start`; `bridge.js` runs in the default (isolated) world. Requests
  the `storage` permission (for popup settings); no host permissions.
- `content.js` — the karaoke logic: passive hook/capture, current-track
  detection, json3 parse + line grouping, overlay render (single or dual-track),
  SPA re-init, on/off toggle. **No `innerHTML`** — YouTube enforces Trusted
  Types, so DOM is built with `textContent`/`replaceChildren`.
- `bridge.js` — isolated-world relay: mirrors `chrome.storage` settings to the
  MAIN-world `content.js` via `window.postMessage` (it has `chrome.*`; the MAIN
  world does not).
- `popup.html` / `popup.js` — the settings popup.
- `icons/` — 16/48/128 px icons.

## Notes

- No host permissions are requested; the content script only touches the
  `www.youtube.com` page it is injected into.
- Adapted from the project's `karaoke.js`, with early hook installation, SPA
  lifecycle handling, translation/dual-track binding, and the settings popup.
