/**
 * yk-autodrive — the ONE automatic caption-track driver, as its own hot-swappable DI
 * module. All automatic setOption track-selection lives here — nobody else drives the
 * player (the user's own clicks aside). Two jobs:
 *
 *  1. AUTO-START (the 自動翻譯 one-shot): setting the menu's target language drives the
 *     player ONCE onto the asr translation (original first, so dual-track has both
 *     bodies), then stops at 'done'. Re-armed by a video change, a target change,
 *     or engine.teardown → reset() (the tick's navigation guard means drive() never runs
 *     off-video, so autodrive cannot observe "I left" on its own).
 *
 *  2. REDRIVE（切一遍）: yk-native calls redrive() when a cook-input setting flipped and
 *     the on-screen caption was cooked under the old settings. Execution = RE-SELECTING
 *     the current variant, one step: any setOption selection makes the player issue a
 *     fresh timedtext request (it has no caption cache), and the response passes the
 *     capture seam under the new settings (cooked when a transform is registered,
 *     unmodified otherwise). A boolean with no cancel path is enough.
 *
 * All driving goes through yt.selectAsrVariant (the player's own setOption; the PLAYER
 * fetches, pot-gated). Every transition is gated on OBSERVED state — no timers; the
 * redrive flag is simply re-tried each tick until the player accepts it.
 */
(function () {
  'use strict';
  window.__YK__.register('autodrive', ['settings', 'yt', 'capture'], (settings, yt, capture) => {
    let phase = 'start'; // start → orig → trans → done (one-shot per video / per target)
    let vid = ''; // current video id
    let lastTarget = ''; // last autoDualLang we acted on
    let redriveWanted = false; // 「切一遍」旗標：下一個可行 tick 重選當前變體一次

    function redrive() {
      redriveWanted = true;
    }

    function serveRedrive(track, trackLang) {
      if (!redriveWanted || !track || yt.isAdShowing()) return;
      const sel = yt.currentAsrSelection(trackLang);
      if (!sel) {
        redriveWanted = false; // 字幕沒在顯示＝沒有過期的 body；重選反而會替使用者打開字幕
        return;
      }
      // 重選當前變體（切一遍本體）；失敗（player 未 ready）旗標留著，下一 tick 重試。
      if (yt.selectAsrVariant(track, sel.tlang)) redriveWanted = false;
    }

    // 一次性自動啟動鏈：至多驅動兩步（原文、然後譯文），完成即 'done'。
    function autoStart(track, trackLang, target) {
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
        case 'trans': // waiting for the translation's body; then we are done
          if (haveTrans) phase = 'done';
          break;
      }
    }

    // Called by the engine every tick with the picked asr track + its language.
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
      autoStart(track, trackLang, target);
      serveRedrive(track, trackLang);
    }

    function reset() {
      phase = 'start';
      vid = '';
      lastTarget = '';
      redriveWanted = false;
    }

    return {
      drive,
      redrive,
      // 由 engine 在 teardown 時呼叫（與 transcript.reset 同型）：one-shot latch 是模組級、
      // 跨導航存活，而 engine tick 的導航守門讓 drive 在離開影片後不再跑——autodrive 自己
      // 觀察不到「離開」。沒有這個 re-arm，同支影片導離再導回會卡在 done、不再自動啟動。
      reset,
      dispose: reset,
    };
  });
})();
