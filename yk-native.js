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
 *  - the EDGE MACHINE (syncEdge/standDown/isOn): the native-mode lifecycle.
 *    It lives HERE (not in the engine) so the whole feature — cook + when-to-cook — is one
 *    independently hot-swappable unit, and so the state machine is reachable by unit tests
 *    (mock settings/yt/capture in, drive syncEdge, assert refetch calls). The engine only
 *    calls syncEdge each tick, standDown on teardown, and branches its render on isOn().
 *
 * Mode-edge key idea（核心就兩件事：劫持＋切一遍）: the transform sits on the capture seam
 * and cooks WHATEVER the player fetches — and the player fetches on every selection and every
 * video/variant load (live-verified 2026-07-02: ANY setOption selection issues a real fresh
 * request; there is NO player-side caption cache). So native mode mostly just… happens: page
 * load, SPA nav, autodrive's own drive, a user track switch — each produces a fetch that the
 * registered cook transforms. The ONLY thing that needs an explicit push is a SETTINGS flip
 * while a caption is already on screen (nativeMode on/off, dual/top while on): the on-screen
 * body is then KNOWN stale, so we ask autodrive (the ONE driver — we never touch selection
 * ourselves) to redrive: re-select the current variant once → fresh fetch → cooked (or, with
 * the transform just cleared, the REAL body — that is also how turning native off restores).
 * State: `on` + one settings signature. No selection tracking, no pool latching, no orders.
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
    ['config', 'log', 'settings', 'yt', 'parse', 'timing', 'capture', 'autodrive'],
    (config, log, settings, yt, parse, timing, capture, autodrive) => {
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

      // ---- the mode edge（極簡：on 旗標＋一個設定簽名）----
      let on = false; // transform registered?
      let prevSig = null; // null = 首次觀察：只初始化不 redrive（進場靠 player 的自然 fetch 生效）
      let lastTrack = null; // standDown 還原用（teardown 呼叫時 engine 已不再傳參）
      let lastTrackLang = '';

      function isOn() {
        return on;
      }

      // Leave native mode. restore=true additionally un-cooks what the player is DISPLAYING:
      // the transform is already cleared, so ONE re-select of the current variant makes the
      // player fetch (always a real request — no player cache, live-verified) and render the
      // REAL body. If the user has meanwhile switched away themselves (sel null and NOT an ad
      // — ads report a null selection without the user having done anything), we deliberately
      // do nothing: the cooked body is not on screen, and re-selecting would override them.
      function standDown(restore) {
        const wasOn = on;
        on = false;
        disable();
        if (restore && wasOn && lastTrack) {
          const sel = yt.currentAsrSelection(lastTrackLang);
          // 廣告中 sel 恆 null——那不是「使用者切走」：盡力還原到原文變體（優於把 cooked
          // 殘留留在快取軌上；廣告中 tracklist 可能為空 → 失敗走同一條 warn 路徑）。
          const tl = sel ? sel.tlang : yt.isAdShowing() ? '' : null;
          if (tl != null && !yt.selectAsrVariant(lastTrack, tl)) {
            // One-shot path (teardown): no tick will retry, so surface it instead of
            // silently leaving the cooked caption on screen.
            log.warn('native restore re-select failed; the player may keep the cooked caption');
          }
        }
        prevSig = null;
        lastTrack = null;
        lastTrackLang = '';
      }

      // Per-tick mode-edge driver：劫持的掛/卸＋「設定簽名變了就切一遍」。
      function syncEdge(track, trackLang) {
        const native = !!settings.current.nativeMode;
        if (native && !on) {
          on = true;
          enable();
        } else if (!native && on) {
          on = false;
          disable(); // transform 先卸：redrive 抓回來的就是真身——這就是關閉的當場還原
        }
        lastTrack = track || null;
        lastTrackLang = trackLang || '';
        if (!track) return;
        // 廣告期間不觀測：廣告下的畫面/選軌都不是主影片的事實。簽名比較是狀態性的，
        // 廣告結束後第一個 tick 自然補上，事件不會丟。
        if (yt.isAdShowing()) return;
        // 只有會改變畫面上這份 body 的位才進簽名：native off 時 dual/top 是 inert
        // （overlay 模式它們每幀即時生效，無需 re-fetch）。
        const sig = native
          ? `1|${settings.current.dualTrack ? 1 : 0}|${settings.current.translationOnTop ? 1 : 0}`
          : '0';
        if (prevSig === sig) return; // steady state
        if (prevSig === null) {
          prevSig = sig; // 首次觀察：進場不當場翻煮——player 進場自己的字幕 fetch 會被煮
          return;
        }
        prevSig = sig;
        // 使用者當場翻了設定：畫面上的 body 確定過期 → 請 driver 切一遍（重選當前變體
        // → player 必發 fresh fetch → 被煮或還原真身）。選擇變更根本不觀測：player 對
        // 新選擇自己會抓，自然被煮。
        autodrive.redrive();
      }

      return {
        cookKaraoke, // exported for unit tests (pure)
        cook,
        enable,
        disable,
        syncEdge,
        standDown,
        isOn,
        // hot-swap: drop the transform + edge state so a stale cook never lingers. No restore:
        // the incoming instance re-enters via syncEdge next tick; a recipe change shows on the
        // next natural fetch (or nudge autodrive.redrive() by hand from the MCP session).
        dispose: () => standDown(false),
      };
    },
  );
})();
