/**
 * yk-native — the "原生播放模式" (native playback mode) as its OWN hot-swappable DI module.
 *
 * Instead of self-drawing an overlay (yk-overlay) over a hidden native caption, this mode
 * HIJACKS the player's timedtext response: at the moment the player fetches the asr body,
 * we COOK a karaoke-styled json3 and swap it in (via yk-capture's transform seam), then hand
 * it back so YouTube's OWN caption renderer draws the per-word highlight. The player does
 * all fetching and rendering; this module only computes the replacement body.
 *
 * The module owns THREE layers, all unit-testable through DI mocks:
 *  - cookKaraoke(entries, opts): a PURE function (parsed lines -> json3 string). No url, no
 *    capture, no DOM — testable with the engine's own [{key,lines}] bind shape as input.
 *  - cook(url, originalText): the impure transform handed to capture. It parses the body,
 *    looks up the OTHER variant for dual-track, and calls cookKaraoke. Memoized per fetch.
 *  - sync/reset/isOn: when-to-cook. sync() keeps the transform registration and a settings
 *    signature in step with settings each tick; reset() zeroes that state. It lives HERE
 *    (not in the engine) so the whole feature — cook + when-to-cook — is one independently
 *    hot-swappable unit reachable by unit tests (mock settings/yt/capture in, drive sync,
 *    assert redrive calls). The engine only calls sync each tick, reset on teardown, and
 *    branches its render on isOn().
 *
 * 核心就兩件事——劫持＋切一遍: the transform sits on the capture seam and cooks WHATEVER
 * passes it — and the player issues its own timedtext request on every selection and every
 * video/variant load (any setOption selection issues a fresh request; the player has no
 * caption cache). So native mode mostly just… happens: page load, SPA nav, autodrive's own
 * drive, a user track switch — each produces a request whose response the registered cook
 * transforms. The ONLY thing that needs an explicit push is a SETTINGS flip while a caption
 * is already on screen (nativeMode on/off, dual/top while on): the on-screen body was cooked
 * under the old settings, so we ask autodrive (track selection stays its job) to redrive:
 * re-select the current variant once → the player issues a fresh request → the response
 * passes the seam under the new settings (cooked, or unmodified once the transform is
 * cleared). State: `on` + one settings signature.
 *
 * json3 recipe constraints (what the player's renderer accepts):
 *  - each repaint event is a STANDALONE pop-on cue (wsWinStyles {juJustifCode:2}, NO sdScrollDir;
 *    the cue self-positions via wpWinPosId — there is NO persistent window-def event and NO wWinId).
 *    Contiguous, non-overlapping cues REPLACE in place; a shared persistent window (window-def +
 *    wWinId) instead ROLLS UP — over full-video playback every repaint piles into a growing stack;
 *  - per word-onset a repaint event repaints the whole line, the active word's seg using the
 *    ACTIVE pen, earlier words PAST, later FUTURE — word state via timing.wordState, the
 *    same definition of "active" the overlay and the side transcript use;
 *  - pen colour fcForeColor is an INTEGER RGB (a "#hex" string makes the player DROP the event);
 *  - dual-track = two window POSITIONS (distinct wpWinPosId / avVerPos) rendering as two
 *    independent moving-highlight rows, no cross-wipe.
 */
(function () {
  'use strict';
  window.__YK__.register(
    'native',
    ['config', 'log', 'settings', 'yt', 'parse', 'timing', 'capture', 'autodrive'],
    (config, log, settings, yt, parse, timing, capture, autodrive) => {
      const { LINE_LEAD_MS } = config;

      // Pen indices into the pens[] array built below (0 is the empty default pen).
      const PAST = 1;
      const ACTIVE = 2;
      const FUTURE = 3;
      // Default palette mirrors the 'default' overlay look: dim-grey past, gold active,
      // white future. Colours are INTEGER RGB fcForeColor values (see the header recipe).
      const DEFAULT_PENS = {
        past: { fcForeColor: 0x9aa0a6, foForeAlpha: 255 },
        active: { fcForeColor: 0xffe566, foForeAlpha: 255 },
        future: { fcForeColor: 0xffffff, foForeAlpha: 255 },
      };
      const TAIL_MS = 1200; // how long the last line lingers after its last word
      const ROW_GAP = 14; // avVerPos gap between stacked dual-track rows
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
        // Guards: cook only in native mode, and only bodies of the current video
        // (a transform can persist across SPA nav).
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

      // ---- 掛/卸同步（on 旗標＋一個設定簽名）----
      let on = false; // transform registered?
      let prevSig = null; // null = 首次觀察：只初始化不 redrive（進場字幕來自 player 自己的請求）

      function isOn() {
        return on;
      }

      // 狀態歸零：卸 transform、清簽名（engine teardown 與 hot-swap dispose 同一路徑）。
      function reset() {
        on = false;
        disable();
        prevSig = null;
      }

      // 每 tick 同步：設定 → transform 掛/卸；設定簽名變了就切一遍。
      function sync(track) {
        const native = !!settings.current.nativeMode;
        if (native && !on) {
          on = true;
          enable();
        } else if (!native && on) {
          on = false;
          disable();
        }
        if (!track) return;
        // 廣告期間不觀測：廣告下的畫面/選軌都不是主影片的事實。簽名比較是狀態性的，
        // 廣告結束後第一個 tick 自然補上，事件不會丟。
        if (yt.isAdShowing()) return;
        // 只有會改變畫面上這份 body 的位才進簽名：native off 時 dual/top 是 inert
        // （overlay 模式它們每幀即時生效，無需切一遍）。
        const sig = native
          ? `1|${settings.current.dualTrack ? 1 : 0}|${settings.current.translationOnTop ? 1 : 0}`
          : '0';
        if (prevSig === sig) return; // steady state
        if (prevSig === null) {
          prevSig = sig; // 首次觀察：進場不當場翻煮——player 進場自己的字幕 fetch 會被煮
          return;
        }
        prevSig = sig;
        // 使用者當場翻了設定：畫面上的 body 是按舊設定煮的 → 請 driver 切一遍（重選
        // 當前變體，player 自己重新請求，回應按新設定過 seam）。選軌變更不在此觀測：
        // player 對新選擇自己會請求，回應照樣過 seam。
        autodrive.redrive();
      }

      return {
        cookKaraoke, // exported for unit tests (pure)
        cook,
        enable,
        disable,
        sync,
        reset,
        isOn,
        // hot-swap: a transform left behind would keep cooking with the outgoing code.
        // The incoming instance re-registers via sync next tick; a recipe change shows on
        // the player's next request (or nudge autodrive.redrive() from the MCP session).
        dispose: reset,
      };
    },
  );
})();
