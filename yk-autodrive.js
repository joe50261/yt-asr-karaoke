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
 *
 * 漂移重選（nudge）：selectAsrVariant 回 true 只代表 setOption 當下被接受——播放器
 * 隨後仍可能自己把選軌重設（廣告邊界、初始化套用使用者偏好、導航殘留）。若這發生在
 * 等待中的 body 到貨之前，那次 fetch 就死了、body 永遠不會來，鏈會卡在半路（畫面停在
 * 原文、譯文永不出現）。所以 'orig'/'trans' 兩相位在「body 未到＋觀察到選擇已不在我們
 * 驅動的變體上」時重選一次；'trans' 也要求「人在目標上」才收 'done'（body 可能來自
 * 池的跨導航快取，收太早會在播放器實際掉軌時鎖死 one-shot）。重選有上限
 * （MAX_NUDGES/one-shot）：病態播放器（setOption 接受但不生效）不會造成逐 tick
 * 重選/洗版，也不會無限對戰使用者；超限後停手，body 若日後到貨鏈仍會繼續前進。
 *
 * 卡等重踢（stall re-kick）：fetch 也可能死得「觀察不到」——選擇還好好掛在變體上，
 * 但回應是空/壞 body（pot 失手、5xx），storeOriginal 驗證擋下、不入池，body 永遠
 * 不到而畫面看不出異狀。on-variant 空等超過 STALL_TICKS 個 tick 就重選同一變體一次
 * （播放器沒有字幕快取，同變體重選＝重發 timedtext——切一遍的同一招；人已在該變體上，
 * 不構成對戰使用者）。計的是 rAF tick 數不是牆鐘（本模組不設計時器），額度與 nudge
 * 共用 MAX_NUDGES。
 *
 * 初始化窗守門（不與內建 race）：播放器 init 的偏好還原不是一次動作，是一段
 * 「到播放開始才收尾」的序列——實測（yk-watch 2026-07-18 log）它在 baseline
 * （buffering、ct=0）先還原一次，最後一手落在 buffering→playing 轉移前 ~160ms。
 * 在這段窗內 setOption 就是與內建 race：先動的必被它最後一手蓋掉（done 後 ~1.1s
 * 被重置回手動軌的整起事故），engine 因 currentAsrSelection 回 null 而 stepAside，
 * 失敗還被 done/bound 的成功 log 蓋住。時間讓路（固定 ~2s）被實測否決：窗多長由
 * 播放器決定，唯一可靠的「內建已出完手」訊號是**本影片首次進入播放**
 * （playerState=1、非廣告）。所以 'start' 相位一律等 played 才驅動——偵測內建的
 * 窗、排在它後面，而不是搶先然後補救。自動播放關閉時 = 使用者按播放才驅動
 * （播放前本來就沒有卡拉OK可看）。
 *
 * done 後對帳（reseed，後備）：初始化窗守門把「init 收尾重置」整類消滅在源頭；
 * reseed 只留給播放中段的重置（廣告邊界等不明生命週期點）。done 相位每 tick
 * 對帳：選擇偏離目標且字幕仍開著時，若偏離「開始」貼近生命週期錨點
 * （watch.anchorAge：baseline／playerState 轉移／廣告邊界；或 done 剛落地）就把
 * 目標重選回來——貼近錨點的偏離是播放器重置，穩態深處的偏離是使用者換軌
 * （尊重，不對戰）。錨可晚到（實測重置早於 ps 轉移），窗內逐 tick 續判補得到。
 * 字幕被關一律尊重（使用者意志的明確訊號）。上限 MAX_RESEEDS/one-shot；照樣過
 * 在途守門（重置常自帶它的 timedtext fetch，等它落地，不取消）。
 *
 * Log 紀律：只在「動作邊緣」記（每次 select、步驟推進、re-arm、redrive 執行），每行
 * 帶 v=<影片id>——drive() 每 tick 都跑，穩態必須零輸出。變體一律用 log.variant 的
 * 統一標籤（原文 'en'、翻譯 'en→zh-Hant'）；內部相位名（orig/trans）不出現在 log。
 */
(function () {
  'use strict';
  window.__YK__.register('autodrive', ['log', 'settings', 'yt', 'capture', 'watch'], (log, settings, yt, capture, watch) => {
    const MAX_NUDGES = 8; // 漂移重選＋卡等重踢的共用上限（per one-shot；re-arm/reset 歸零）
    const STALL_TICKS = 600; // on-variant 空等幾個 rAF tick 判定 fetch 已死（60fps ≈ 10s）
    const RESEED_WINDOW_TICKS = 300; // done 後偏離的錨點歸因窗（~5s）：偏離開始點與錨點的最大距離
    const MAX_RESEEDS = 3; // done 後重置回選上限（per one-shot）：錨點誤判時也不與使用者無限對戰
    let phase = 'start'; // start → orig → trans → done (one-shot per video / per target)
    let vid = ''; // current video id
    let lastTarget = ''; // last autoDualLang we acted on
    let nudges = 0; // 本輪 one-shot 已用掉的重選次數（漂移＋卡等共用）
    let stall = 0; // 連續「在變體上但 body 未到」的 tick 數（任何 select/轉移歸零）
    let played = false; // 本影片是否已進入播放（ps=1、非廣告）＝內建 init 已出完手；影片變更歸零
    let redriveWanted = false; // 「切一遍」旗標：下一個可行 tick 重選當前變體一次
    let ticks = 0; // 本輪 one-shot 的 drive tick 計數（reseed 的時間軸；re-arm 歸零）
    let doneTick = -1; // done 落地的 tick（done 剛落地也是 reseed 的錨點之一）
    let reseeds = 0; // done 後已回選次數
    let devStart = -1; // 當前偏離的開始 tick（-1 = 未偏離／已回到目標）
    let devAnchored = false; // 這次偏離的開始是否貼近錨點（判定一次偏離、latch 到偏離結束）

    function redrive() {
      redriveWanted = true;
    }

    function serveRedrive(track, trackLang) {
      if (!redriveWanted || !track || yt.isAdShowing()) return;
      const sel = yt.currentAsrSelection(trackLang);
      if (!sel) {
        redriveWanted = false; // 字幕沒在顯示＝沒有過期的 body；重選反而會替使用者打開字幕
        log.info('autodrive', 'v=' + vid, 'redrive skipped: no asr selection on screen');
        return;
      }
      if (capture.anyInFlight()) return; // 在途守門：旗標留著，落地後下一 tick 再切
      // 重選當前變體（切一遍本體）；失敗（player 未 ready）旗標留著，下一 tick 重試。
      if (yt.selectAsrVariant(track, sel.tlang)) {
        watch.markOwn(track, sel.tlang); // 觀測器歸因：這次選軌變化是我們發的
        redriveWanted = false;
        log.info('autodrive', 'v=' + vid, 'redrive: re-selected', log.variant(trackLang, sel.tlang));
      }
    }

    // 漂移重選一步（見頭註）。回 true = 本 tick 已發出重選。
    // 在途守門：想要的變體已有請求在路上時不重選——setOption 會讓播放器 abort 在途
    // 請求重發，abort 只是客戶端不讀回應、伺服器端已計入配額（429 限流下白燒額度）；
    // 等它落地（入池或入失敗台帳）再說。播放器 session 重建造成的取消擋不了，但
    // 我們自己不再貢獻取消。
    function nudge(track, trackLang, tlang) {
      if (nudges >= MAX_NUDGES) return false; // 超限：停手，穩態安靜
      if (capture.anyInFlight()) return false; // 本影片有字幕請求在路上：選了只會取消它
      if (!yt.selectAsrVariant(track, tlang)) return false; // player 未 ready：下 tick 再試，不計次
      watch.markOwn(track, tlang);
      nudges++;
      stall = 0; // 剛發出新 fetch：卡等計數重新起算
      log.warn(
        'autodrive', 'v=' + vid,
        'drift: player left', log.variant(trackLang, tlang),
        'before its body arrived — re-selected it', '(' + nudges + '/' + MAX_NUDGES + ')',
      );
      if (nudges === MAX_NUDGES) {
        log.warn('autodrive', 'v=' + vid, 'nudge budget exhausted — no more re-selects this one-shot');
      }
      return true;
    }

    // 卡等重踢一步（見頭註）：人在變體上、body 空等超過門檻 → 重選同一變體重發 fetch。
    // 門檻按 capture 的壞回應台帳指數退避：同變體連續壞回應（429 限流、5xx、pot 失手的
    // 空 200）每多一次門檻翻倍（上限 2^5 ≈ 5 分鐘）——YouTube 對 tlang= 路徑限流時，
    // 固定 10 秒盲踢只會讓 429 封鎖更久。無失敗紀錄維持原門檻。過門檻後 select 失敗
    // （player 未 ready）不歸零，下 tick 續試。
    function stallRekick(track, trackLang, tlang) {
      const fail = capture.lastFailure(track, tlang);
      const threshold = STALL_TICKS * Math.pow(2, Math.min(fail ? fail.count : 0, 5));
      if (++stall < threshold || nudges >= MAX_NUDGES) return;
      if (capture.anyInFlight()) return; // 本影片有字幕請求在路上：等它落地，別取消重來
      if (!yt.selectAsrVariant(track, tlang)) return;
      watch.markOwn(track, tlang);
      nudges++;
      stall = 0;
      log.warn(
        'autodrive', 'v=' + vid,
        'stall:', log.variant(trackLang, tlang),
        fail
          ? 'last response was HTTP ' + (fail.status || 'error') + ' ×' + fail.count +
            (fail.status === 429 ? ' (rate-limited)' : '') + ' — backed off, re-selected to retry'
          : 'selected but its body never arrived — re-selected to re-issue the fetch',
        '(' + nudges + '/' + MAX_NUDGES + ')',
      );
    }

    // 一次性自動啟動鏈：至多驅動兩步（原文、然後譯文），完成即 'done'。
    function autoStart(track, trackLang, target) {
      if (!target || phase === 'done' || !track || yt.isAdShowing()) return;
      const haveOrig = capture.hasCapturedVariant(track, '');
      const haveTrans = capture.hasCapturedVariant(track, target);
      const sel = yt.currentAsrSelection(trackLang);
      const onTarget = !!sel && sel.tlang === target;
      // log 一律用統一變體標籤（log.variant：原文 'en'、翻譯 'en→zh-Hant'），步驟寫成
      // step 1/2、step 2/2、done——內部相位名（orig/trans）不出現在 log，讀的人不需要
      // 知道狀態機才看得懂。
      switch (phase) {
        case 'start':
          // 初始化窗守門（見頭註）：播放器 init 的偏好還原到「本影片首次進入播放」
          // 才收尾（實測最後一手落在 buffering→playing 轉移前 ~160ms）；窗內任何
          // setOption 都是與內建 race——先動必被它最後一手蓋掉，還會 abort 它的在途
          // 請求白燒配額。等 played（drive 每 tick 觀測）才開始驅動；池裡已有 body
          // 也一樣等——內建的最後一手不看池，照樣蓋。
          if (!played) break;
          // 'start' always drives toward the target (even if both bodies are already
          // captured) so a 關閉→on after the player drifted re-selects the translation.
          // 在途守門（與 nudge/stallRekick 同則）：想要的變體已有請求在路上（例如播放器
          // 自己還原字幕偏好的初始 fetch）就不搶著 setOption——重選會 abort 它、配額
          // 白燒一次；等 body 落地入池，相位靠 haveOrig/haveTrans 照樣前進。
          if (!haveOrig) {
            if (!capture.anyInFlight() && yt.selectAsrVariant(track, '')) {
              watch.markOwn(track, '');
              phase = 'orig'; // original first (translation-direct never loads it)
              stall = 0;
              log.info('autodrive', 'v=' + vid, 'step 1/2: select', log.variant(trackLang, ''), '— waiting for its body');
            }
          } else if (onTarget && haveTrans) {
            phase = 'done'; // already there (player on target, both loaded)
            doneTick = ticks;
            log.info('autodrive', 'v=' + vid, 'done: already on', log.variant(trackLang, target), 'with both bodies');
          } else if (!capture.anyInFlight() && yt.selectAsrVariant(track, target)) {
            watch.markOwn(track, target);
            phase = 'trans';
            stall = 0;
            log.info('autodrive', 'v=' + vid, 'step 2/2: select', log.variant(trackLang, target), '(', log.variant(trackLang, ''), 'body already pooled )');
          }
          break;
        case 'orig': // waiting for the original's body before switching to the translation
          if (haveOrig) {
            if (yt.selectAsrVariant(track, target)) {
              watch.markOwn(track, target);
              phase = 'trans';
              stall = 0;
              log.info('autodrive', 'v=' + vid, 'step 2/2:', log.variant(trackLang, ''), 'body captured — select', log.variant(trackLang, target));
            }
          } else if (!sel || sel.tlang !== '') {
            // 漂移：該變體有壞回應紀錄（429 限流）時不立即重選——body 反正不會來，
            // 立即重選只會再燒配額；改走 stall 的指數退避（select 不看當前選擇，
            // 到點照樣把選擇拉回來）。乾淨漂移（無失敗紀錄）維持立即重選。
            if (capture.lastFailure(track, '')) stallRekick(track, trackLang, '');
            else nudge(track, trackLang, ''); // 播放器把原文選擇丟了、body 還沒來 → 重選
          } else {
            stallRekick(track, trackLang, ''); // 人在原文上、body 遲遲不到 → fetch 可能已死
          }
          break;
        case 'trans': // waiting for the translation's body AND the player holding the target
          if (haveTrans && onTarget) {
            phase = 'done';
            doneTick = ticks;
            stall = 0;
            log.info('autodrive', 'v=' + vid, 'done:', log.variant(trackLang, target), 'captured and selected');
          } else if (!onTarget) {
            // 同上：429 紀錄在身的目標變體，掉軌後按退避重選；乾淨漂移立即重選。
            if (capture.lastFailure(track, target)) stallRekick(track, trackLang, target);
            else nudge(track, trackLang, target); // 掉軌（body 可能已在池中）→ 重選，不提前收 done
          } else {
            stallRekick(track, trackLang, target); // 人在目標上、body 遲遲不到 → fetch 可能已死
          }
          break;
      }
    }

    // done 後對帳（見頭註）：偏離目標＋字幕仍開＋偏離開始貼近生命週期錨點 → 回選目標。
    function reconcile(track, trackLang, target) {
      if (phase !== 'done' || !target || !track || yt.isAdShowing()) return;
      const sel = yt.currentAsrSelection(trackLang);
      if (sel && sel.tlang === target) {
        devStart = -1; // 在目標上：本次偏離（若有）結束，歸因狀態清空
        devAnchored = false;
        return;
      }
      const cs = yt.captionState();
      if (!cs || cs.off) {
        devStart = -1; // 觀測不到／字幕被關＝使用者意志的明確訊號：尊重，不視為偏離
        devAnchored = false;
        return;
      }
      if (devStart < 0) {
        devStart = ticks;
        devAnchored = false;
      }
      // 錨點歸因：偏離開始點落在任一錨（watch 的 baseline/ps 轉移/廣告邊界、或 done
      // 剛落地）的 ±窗內。錨常晚到（實測重置早於 ps 轉移 ~160ms）——窗未過期前
      // 逐 tick 續判，晚到的錨照樣把這次偏離標成「播放器重置」。
      if (!devAnchored && ticks - devStart <= RESEED_WINDOW_TICKS) {
        devAnchored =
          watch.anchorAge() <= RESEED_WINDOW_TICKS ||
          (doneTick >= 0 && devStart - doneTick <= RESEED_WINDOW_TICKS);
      }
      if (!devAnchored || reseeds >= MAX_RESEEDS) return; // 穩態偏離（使用者換軌）或額度用罄：不對戰
      if (capture.anyInFlight()) return; // 在途守門：重置常自帶它的 timedtext fetch，等落地
      if (!yt.selectAsrVariant(track, target)) return; // player 未 ready：下 tick 再試
      watch.markOwn(track, target);
      reseeds++;
      devStart = -1;
      devAnchored = false;
      log.warn(
        'autodrive', 'v=' + vid,
        'reseed: player reset selection to',
        (cs.kind === 'asr' ? 'asr ' : 'manual ') + log.variant(cs.lang, cs.tlang) + (cs.name ? ' "' + cs.name + '"' : ''),
        '— re-selected', log.variant(trackLang, target),
        '(' + reseeds + '/' + MAX_RESEEDS + ')',
      );
      if (reseeds === MAX_RESEEDS) {
        log.warn('autodrive', 'v=' + vid, 'reseed budget exhausted — further external changes are respected');
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
        // 初始化窗只屬於影片變更（新頁面的播放器 init 才有偏好還原序列要等）；
        // 同影片換目標是使用者當下的動作，played 不歸零、gate 已過就直接驅動。
        if (cur !== vid) played = false;
        vid = cur;
        lastTarget = target;
        phase = 'start';
        nudges = 0;
        stall = 0;
        ticks = 0;
        doneTick = -1;
        reseeds = 0;
        devStart = -1;
        devAnchored = false;
        if (target) log.info('autodrive', 'v=' + vid, 'armed: will drive to', log.variant(trackLang, target));
      }
      ticks++;
      // 初始化窗觀測：本影片首次「播放中且非廣告」＝內建 init 的偏好還原已出完手
      // （它的最後一手在進入播放之前）。latch 住，此後暫停/緩衝不再重新擋路。
      if (!played) {
        const cs = yt.captionState();
        if (cs && cs.playerState === 1 && !cs.ad) {
          played = true;
          if (target && phase === 'start') log.info('autodrive', 'v=' + vid, 'player init settled (playing) — start driving');
        }
      }
      autoStart(track, trackLang, target);
      reconcile(track, trackLang, target);
      serveRedrive(track, trackLang);
    }

    function reset() {
      phase = 'start';
      vid = '';
      lastTarget = '';
      nudges = 0;
      stall = 0;
      played = false;
      redriveWanted = false;
      ticks = 0;
      doneTick = -1;
      reseeds = 0;
      devStart = -1;
      devAnchored = false;
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
