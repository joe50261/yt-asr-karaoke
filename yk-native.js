/**
 * yk-native — the "原生播放模式" (native playback mode) as its OWN hot-swappable DI module.
 *
 * Instead of self-drawing an overlay (yk-overlay) over a hidden native caption, this mode
 * HIJACKS the player's timedtext response: at the moment the player fetches the asr body,
 * we COOK a karaoke-styled json3 and swap it in (via yk-capture's transform seam), then hand
 * it back so YouTube's OWN caption renderer draws the per-word highlight. We never fetch and
 * never draw; the player renders everything.
 *
 * The module owns THREE layers, all unit-testable through DI mocks:
 *  - cookKaraoke(entries, opts): a PURE function (parsed lines -> json3 string). No url, no
 *    capture, no DOM — testable with the engine's own [{key,lines}] bind shape as input.
 *  - cook(url, originalText): the impure transform handed to capture. It parses the body,
 *    looks up the OTHER variant for dual-track, and calls cookKaraoke. Memoized per fetch.
 *  - the EDGE MACHINE (syncEdge/standDown/isOn/inBustWindow): the native-mode lifecycle.
 *    It lives HERE (not in the engine) so the whole feature — cook + when-to-cook — is one
 *    independently hot-swappable unit, and so the state machine is reachable by unit tests
 *    (mock settings/yt/capture in, drive syncEdge, assert refetch calls). The engine only
 *    calls syncEdge each tick, standDown on teardown, and branches its render on isOn().
 *
 * Edge-machine key idea: a SELECTION change (autodrive or the user switching tracks) already
 * makes the player fetch a fresh body, which the registered cook transforms — so it needs NO
 * cache-bust, only recording. We force an OFF→ON re-fetch (yt.refetchCaption) ONLY when the
 * player is sitting on a body the cook should change but won't re-fetch on its own: the FIRST
 * observation after entering native (a cached REAL body), or a cook-input change with the
 * SAME selection (a settings toggle, or the single→dual upgrade when the original arrives).
 * Not busting on selection changes is also what avoids racing autodrive.
 *
 * The json3 recipe is LIVE-VERIFIED (see memory native-json3-karaoke-cook-recipe):
 *  - each repaint event is a STANDALONE pop-on cue (wsWinStyles {juJustifCode:2}, NO sdScrollDir;
 *    the cue self-positions via wpWinPosId — there is NO persistent window-def event and NO wWinId).
 *    Contiguous, non-overlapping cues REPLACE in place; a shared persistent window (window-def +
 *    wWinId) instead ROLLS UP — over full-video playback every repaint piles into a growing stack;
 *  - per word-onset a repaint event repaints the whole line, the active word's seg using the
 *    ACTIVE pen, earlier words PAST, later FUTURE — word state via timing.wordState so native,
 *    overlay and the side transcript can never disagree on what's active;
 *  - pen colour fcForeColor is an INTEGER RGB (a "#hex" string makes the player DROP the event);
 *  - dual-track = two window POSITIONS (distinct wpWinPosId / avVerPos), verified to render as two
 *    independent moving-highlight rows, no cross-wipe.
 */
(function () {
  'use strict';
  window.__YK__.register(
    'native',
    ['config', 'log', 'settings', 'yt', 'parse', 'timing', 'capture'],
    (config, log, settings, yt, parse, timing, capture) => {
      const { LINE_LEAD_MS } = config;

      // Pen indices into the pens[] array built below (0 is the empty default pen).
      const PAST = 1;
      const ACTIVE = 2;
      const FUTURE = 3;
      // Default palette mirrors the 'default' overlay look: dim-grey past, gold active,
      // white future. Colours are INTEGER RGB (fcForeColor) — the live-verified requirement.
      const DEFAULT_PENS = {
        past: { fcForeColor: 0x9aa0a6, foForeAlpha: 255 },
        active: { fcForeColor: 0xffe566, foForeAlpha: 255 },
        future: { fcForeColor: 0xffffff, foForeAlpha: 255 },
      };
      const TAIL_MS = 1200; // how long the last line lingers after its last word
      const ROW_GAP = 14; // avVerPos gap between stacked dual-track rows (verified clean at 14)
      const BOTTOM_AV = 90; // bottom row vertical position (% from top, apPoint:7 bottom anchor)

      function penIdForState(s) {
        return s === 'active' ? ACTIVE : s === 'past' ? PAST : FUTURE;
      }

      // Expand ONE variant's lines into pop-on repaint events at window position `posId`. A line
      // is shown over [line.start - LEAD, nextLine.start - LEAD) (matching timing.findActiveLine's
      // contiguous activation), and within that one event per state-change boundary repaints the
      // full line with each word's pen from timing.wordState. Each event is a STANDALONE cue
      // (it carries wpWinPosId + wsWinStyleId itself; there is NO persistent window-defining event
      // and NO wWinId). That is what makes the renderer REPLACE in place: the cues are contiguous
      // and non-overlapping in time, so exactly one shows at a time and the previous clears. A
      // shared persistent window (the roll-up pattern: one window-def + wWinId) instead ACCUMULATES
      // every repaint into a growing pile over continuous full-video playback (the stacking bug).
      function lineEventsForWindow(lines, posId) {
        const events = [];
        for (let li = 0; li < lines.length; li++) {
          const line = lines[li];
          // Clamp to >=0 so a first line that starts within LINE_LEAD_MS of 0 can't produce a
          // negative boundary — that would inflate the first event's duration (tStartMs floors
          // to 0 while dDuration kept the negative offset) and yield two events at tStartMs 0,
          // i.e. an ambiguous double-paint on the opening line.
          const showStart = Math.max(0, line.start - LINE_LEAD_MS);
          const showEnd =
            li + 1 < lines.length ? Math.max(0, lines[li + 1].start - LINE_LEAD_MS) : line.end + TAIL_MS;
          if (showEnd <= showStart) continue;
          // Boundary times where ANY word changes state (wordState uses ±30ms), clipped to
          // the visible window. Between consecutive boundaries the state vector is constant.
          const bounds = new Set([showStart]);
          for (const w of line.words) {
            const a = w.start - 30;
            const b = w.end + 30;
            if (a > showStart && a < showEnd) bounds.add(a);
            if (b > showStart && b < showEnd) bounds.add(b);
          }
          const ts = [...bounds].sort((x, y) => x - y);
          ts.push(showEnd);
          for (let i = 0; i < ts.length - 1; i++) {
            const t0 = ts[i];
            const t1 = ts[i + 1];
            if (t1 <= t0) continue;
            events.push({
              tStartMs: Math.round(t0),
              dDurationMs: Math.round(t1 - t0),
              wpWinPosId: posId,
              wsWinStyleId: 1,
              segs: line.words.map((w) => ({
                utf8: w.text,
                pPenId: penIdForState(timing.wordState(w, t0)),
              })),
            });
          }
        }
        return events;
      }

      // PURE: parsed variants -> karaoke json3 string. `entries` is the engine's bind shape
      // [{key, lines}] already in display order (entries[0] = top row). 1 entry = single row,
      // 2 = dual-track. `opts.pens` overrides the palette.
      function cookKaraoke(entries, opts) {
        opts = opts || {};
        const pens = opts.pens || DEFAULT_PENS;
        const n = entries.length;
        const wpWinPositions = [{}];
        const events = [];
        entries.forEach((entry, i) => {
          const posId = i + 1;
          const avVerPos = BOTTOM_AV - (n - 1 - i) * ROW_GAP; // top row higher, bottom row at 90
          wpWinPositions.push({ apPoint: 7, ahHorPos: 50, avVerPos });
          // standalone, self-positioned repaint cues (no persistent window-def / wWinId) so each
          // replaces the previous in place rather than rolling up — see lineEventsForWindow.
          events.push(...lineEventsForWindow(entry.lines, posId));
        });
        return JSON.stringify({
          wireMagic: 'pb3',
          pens: [{}, pens.past, pens.active, pens.future],
          wsWinStyles: [{}, { juJustifCode: 2 }], // centred, POP-ON (no sdScrollDir => replace-in-place)
          wpWinPositions,
          events,
        });
      }

      // ---- impure transform handed to capture ----
      const memo = new Map(); // url -> { sig, cooked }
      const MEMO_MAX = 8; // per-fetch URLs rotate (pot/expire), so cap instead of growing all session

      function urlParam(url, name) {
        try {
          return new URL(url, location.origin).searchParams.get(name) || '';
        } catch {
          return '';
        }
      }

      function linesFromJson(json) {
        return parse.groupLines(parse.parseCaptionEvents(json));
      }

      // The transform: given the player's asr fetch URL + the ORIGINAL body, return the cooked
      // karaoke json3 (or the original unchanged when we should not cook). capture only calls
      // this for asr timedtext URLs. The player may read responseText/response several times,
      // so the memo check comes BEFORE any body parse — the sig is built from URL params +
      // settings + a parse-free pool existence check, making a memo hit O(1).
      function cook(url, originalText) {
        // Defensive no-ops: only cook in native mode, and never cook a body that belongs
        // to a different video (a transform can persist across SPA nav).
        if (!settings.current.nativeMode) return originalText;
        const v = urlParam(url, 'v');
        if (v && v !== yt.currentVideoId()) return originalText;

        const tlang = urlParam(url, 'tlang');
        const lang = urlParam(url, 'lang');
        const dual = !!settings.current.dualTrack && tlang !== '';
        const haveOrig = dual && capture.hasCapturedVariant({ languageCode: lang }, '');

        const sig = `${tlang}|${dual ? 1 : 0}|${settings.current.translationOnTop ? 1 : 0}|${haveOrig ? 1 : 0}`;
        const cached = memo.get(url);
        if (cached && cached.sig === sig) return cached.cooked;

        const thisJson = parse.captionJsonFromText(originalText);
        if (!thisJson) return originalText;
        const thisLines = linesFromJson(thisJson);
        if (!thisLines.length) return originalText;

        // hasCapturedVariant is presence-only; the parse can still miss (a pool entry written
        // by a pre-validation build), so re-check the parsed value before going dual.
        const origJson = haveOrig ? capture.capturedJsonForVariant({ languageCode: lang }, '') : null;
        let entries;
        if (dual && origJson) {
          const origLines = linesFromJson(origJson);
          const transEntry = { key: tlang, lines: thisLines };
          const origEntry = { key: '', lines: origLines };
          // Same ordering as engine.syncBinding: translationOnTop puts the translation on top.
          entries = settings.current.translationOnTop ? [transEntry, origEntry] : [origEntry, transEntry];
        } else {
          entries = [{ key: tlang, lines: thisLines }];
        }
        let cooked;
        try {
          cooked = cookKaraoke(entries, {});
        } catch (e) {
          log.warn('cookKaraoke failed; serving original:', e);
          return originalText;
        }
        memo.set(url, { sig, cooked });
        while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
        return cooked;
      }

      function enable() {
        capture.registerTransform(cook);
      }
      function disable() {
        capture.clearTransform();
        memo.clear();
      }

      // ---- the edge machine ----
      const BUST_WINDOW_MS = 300; // OFF→ON gap in yt.refetchCaption (~120ms) plus margin
      const BUST_COOLDOWN_MS = 1000; // debounce forced re-fetches; a skipped change retries next tick

      const edge = {
        on: false, // transform registered?
        tlang: null, // last-observed selection; null = sentinel (forces ONE bust on first observation)
        sig: null, // last-recorded cook-input signature
        bustAt: 0, // last cache-bust timestamp (cooldown + the autodrive pause window)
        origCap: false, // latch: original variant present in the pool (never evicted, so once true stays true)
        track: null, // last track seen by syncEdge — what standDown restores against
        trackLang: '',
      };

      function isOn() {
        return edge.on;
      }

      // While a bust's OFF→ON swap is in flight the engine must pause the auto-drive, or it
      // would re-select the (cached) variant and consume the fresh fetch the cook needs.
      function inBustWindow() {
        return Date.now() - edge.bustAt < BUST_WINDOW_MS;
      }

      // Leave native mode. restore=true additionally un-cooks what the player is DISPLAYING:
      // if it still shows our asr variant (or we are mid-bust, i.e. the transient captions-off
      // is our own doing), force a re-fetch so the real body replaces the cooked one. If the
      // user has meanwhile switched to another track / turned captions off themselves, sel is
      // null and NOT mid-bust — then we deliberately do nothing: the cooked body is not on
      // screen, and re-selecting would override the user's choice.
      function standDown(restore) {
        const wasOn = edge.on;
        edge.on = false;
        disable();
        if (restore && wasOn && edge.track) {
          const sel = yt.currentAsrSelection(edge.trackLang);
          const tl = sel ? sel.tlang : inBustWindow() ? edge.tlang : null;
          if (tl != null) {
            if (yt.refetchCaption(edge.track, tl)) {
              edge.bustAt = Date.now();
            } else {
              // One-shot path (teardown): no tick will retry, so surface it instead of
              // silently leaving the cooked caption on screen.
              log.warn('native restore re-fetch failed; the player may keep the cooked caption');
            }
          }
        }
        edge.tlang = null;
        edge.sig = null;
        edge.origCap = false;
        edge.track = null;
        edge.trackLang = '';
      }

      // Per-tick edge driver (the engine calls this every frame while active).
      function syncEdge(track, trackLang) {
        if (!settings.current.nativeMode) {
          if (edge.on) standDown(true);
          return;
        }
        if (!edge.on) {
          edge.on = true;
          edge.tlang = null; // sentinel: forces ONE bust for the current cached body
          edge.sig = null;
          edge.origCap = false;
          enable();
        }
        edge.track = track || null;
        edge.trackLang = trackLang || '';
        if (!track) return;
        const sel = yt.currentAsrSelection(edge.trackLang);
        if (!sel) return; // nothing selected, or mid-bust (captions transiently off)
        // origCap only matters when a second (original) row is wanted: a translation selected
        // AND dual-track on. When it flips true that's the single→dual upgrade trigger. Latched:
        // the pool never evicts, so once present it stays present — no per-frame pool scan after.
        const dualWanted = settings.current.dualTrack && sel.tlang !== '';
        if (dualWanted && !edge.origCap) edge.origCap = !!capture.hasCapturedVariant(track, '');
        const origCap = dualWanted && edge.origCap;
        // Only bits that can CHANGE the cook's output for the CURRENT selection enter the sig.
        // On the original track ('' tlang) dual/top are inert (cook only goes dual when a
        // translation is selected), so toggling them must not bust — that OFF→ON flicker
        // would buy a byte-identical caption.
        const sig = `${dualWanted ? 1 : 0}|${dualWanted && settings.current.translationOnTop ? 1 : 0}|${origCap ? 1 : 0}`;
        const first = edge.tlang === null;
        const selChanged = !first && sel.tlang !== edge.tlang;
        const sigChanged = !first && sig !== edge.sig;
        if (!first && !selChanged && !sigChanged) return; // steady state
        if (selChanged && !sigChanged) {
          // pure selection change → the player's own fresh fetch already cooked it; just record
          edge.tlang = sel.tlang;
          edge.sig = sig;
          return;
        }
        // selChanged AND sigChanged (e.g. autodrive drives ''→translation with dual on) still
        // busts, deliberately: the player may serve the new selection from ITS cache (no fresh
        // fetch for the cook), and that cached body could be a stale-sig cook. One extra
        // OFF→ON on dual start is the price of never showing a stale composition.
        // first-after-enter, or a same-selection cook-input change → force a re-fetch. Cooldown
        // guards rapid re-fire; we record ONLY when the bust actually HAPPENED — a change
        // skipped by the cooldown, or a refetch the player refused (no setOption yet / it
        // threw: refetchCaption returns false without scheduling anything), stays unrecorded
        // so the next tick retries. Never dropped.
        const now = Date.now();
        if (now - edge.bustAt < BUST_COOLDOWN_MS) return;
        if (!yt.refetchCaption(track, sel.tlang)) return;
        edge.tlang = sel.tlang;
        edge.sig = sig;
        edge.bustAt = now;
      }

      return {
        cookKaraoke, // exported for unit tests (pure)
        cook,
        enable,
        disable,
        syncEdge,
        standDown,
        isOn,
        inBustWindow,
        // hot-swap: drop the transform + edge state so a stale cook never lingers. No restore:
        // the incoming instance re-enters via syncEdge next tick and re-busts on its own.
        dispose: () => standDown(false),
      };
    },
  );
})();
