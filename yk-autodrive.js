/**
 * yk-autodrive — the "auto-translate" (auto-DRIVE) feature as its OWN hot-swappable DI module, so
 * iterating the drive logic is a SINGLE small MCP inject (re-eval this one ~40-line file);
 * the engine just calls drive() each tick and is never re-sent. (The DI re-resolves +
 * restarts the engine because it depends on us, but that uses the engine's EXISTING
 * factory — no engine source travels.) This is the whole point of the per-feature module
 * granularity: one feature = one independently-swappable unit.
 *
 * EDGE-triggered, not polling: setting the menu's target language drives the player ONCE
 * onto the asr translation, then we stand down — we never poll/override the player after.
 * Setting 關閉 (autoDualLang === '') is an explicit RESET that re-arms the one-shot, and a
 * video change re-arms it too (self-tracked via yt.currentVideoId — no engine coordination).
 *
 * We never fetch: yt.selectAsrVariant uses the player's OWN setOption (the PLAYER fetches,
 * pot-gated; yk-capture's hook grabs the body). Every transition is gated on OBSERVED state
 * (captured bodies + the player's current selection) — there are no timers, no guessed
 * delays. Owns only its own latch; deps are the lower modules it orchestrates.
 */
(function () {
  'use strict';
  window.__YK__.register('autodrive', ['settings', 'yt', 'capture'], (settings, yt, capture) => {
    let phase = 'start'; // start → orig → trans → done (one-shot per video / per target)
    let vid = ''; // current video id
    let lastTarget = ''; // last autoDualLang we acted on

    // Called by the engine every tick with the picked asr track + its language. Drives the
    // player at most twice (original, then translation), then sits at 'done' (stand down).
    function drive(track, trackLang) {
      const cur = yt.currentVideoId();
      const target = settings.current.autoDualLang;
      // Re-arm the one-shot whenever the video changes OR the target language changes —
      // the latter covers switching A→B directly, and 關閉 (target='') which then no-ops
      // below. Without this, 'done' would latch and a new target would never drive.
      if (cur !== vid || target !== lastTarget) {
        vid = cur;
        lastTarget = target;
        phase = 'start';
      }
      if (!target || phase === 'done' || !track || yt.isAdShowing()) return;
      const haveOrig = !!capture.capturedJsonForVariant(track, '');
      const haveTrans = !!capture.capturedJsonForVariant(track, target);
      const sel = yt.currentAsrSelection(trackLang);
      const onTarget = !!sel && sel.tlang === target;
      switch (phase) {
        case 'start':
          // 'start' always drives toward the target (even if both bodies are already
          // captured) so a 關閉→on after the player drifted re-selects the translation.
          if (!haveOrig) {
            if (yt.selectAsrVariant(track, '')) phase = 'orig'; // original first (translation-direct never loads it)
          } else if (onTarget && haveTrans) {
            phase = 'done'; // already there (player on target, both loaded)
          } else if (yt.selectAsrVariant(track, target)) {
            phase = 'trans';
          }
          break;
        case 'orig': // waiting for the original's body before switching to the translation
          if (haveOrig && yt.selectAsrVariant(track, target)) phase = 'trans';
          break;
        case 'trans': // waiting for the translation's body; then we are done (stand down)
          if (haveTrans) phase = 'done';
          break;
      }
    }

    return {
      drive,
      dispose() {
        phase = 'start';
        vid = '';
        lastTarget = '';
      },
    };
  });
})();
