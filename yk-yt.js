/**
 * yk-yt — stateless adapter over YouTube's player + DOM. Everything that reads the
 * page/player lives here so the rest of the code never touches YT internals directly.
 * No module state: lifecycle-dependent inputs (trackLang, the abort flag) are passed
 * in as arguments — `isActive` MUST be a function/getter (not a boolean snapshot),
 * or a wait would never abort after teardown.
 */
(function () {
  'use strict';
  window.__YK__.register('yt', ['config'], (config) => {
    const { PLAYER_HOST_SELECTORS } = config;

    function currentVideoId() {
      try {
        return new URLSearchParams(location.search).get('v') || '';
      } catch {
        return '';
      }
    }

    function isWatchPage() {
      return location.pathname === '/watch' && !!currentVideoId();
    }

    // playerResponse 有兩個候選來源：window.ytInitialPlayerResponse（整頁載入時由 inline
    // script 設定，SPA 導航後「不會」更新——它一直是上一次整頁載入那支影片的殭屍）與播放器
    // 自己的 getPlayerResponse()（導航後隨新頁資料就緒）。兩者都以 videoDetails.videoId 對
    // 當前 URL 驗明正身，不合就不用——寧可回 null 讓 waitForPlayerResponse 繼續等，也不能
    // 拿舊影片的 tracklist 綁軌：那會鎖在舊語言上，selectAsrVariant 永遠找不到軌，自動翻譯
    // 在導航後整個不啟動（或反向：舊影片沒字幕 → 空等滿 timeout 停 idle）。
    function getPlayerResponse() {
      const vid = currentVideoId();
      const forThisVideo = (pr) => (!!pr && pr.videoDetails?.videoId === vid ? pr : null);
      let live = null;
      try {
        live = forThisVideo(getPlayerEl()?.getPlayerResponse?.());
      } catch {
        live = null;
      }
      const initial = forThisVideo(window.ytInitialPlayerResponse);
      // 兩份都是本影片時以 live 為準（導航後它跟著播放器走）；唯一例外：live 還沒長出
      // 字幕清單而 initial 已有——身分相同下取「就緒」的那份，waitForPlayerResponse
      // 才不會盯著半熟的 live 空等到 timeout。
      if (live && initial && !captionTracklist(live)?.captionTracks?.length && captionTracklist(initial)?.captionTracks?.length) {
        return initial;
      }
      return live || initial;
    }

    // playerResponse → 字幕軌 tracklist（YT 內部形狀的唯一讀取點；waitForPlayerResponse
    // 的就緒判定與 engine 的抽取同源——分兩份的話，YT 改鍵名時只修一份是無聲劣化：
    // 一邊靜默停 idle，或一邊每支影片空等滿 timeout）。
    function captionTracklist(pr) {
      return pr?.captions?.playerCaptionsTracklistRenderer || null;
    }

    function getVideo() {
      return getPlayerEl()?.querySelector('video') || document.querySelector('video.html5-main-video');
    }

    function getPlayerEl() {
      for (const sel of PLAYER_HOST_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    // True while YouTube is playing an ad: the player gains the `ad-showing`
    // class and the active <video> element is the ad, not the watch video.
    function isAdShowing() {
      const player = getPlayerEl();
      return !!player && player.classList.contains('ad-showing');
    }

    // Identify the auto-generated (ASR) caption track for THIS video using only
    // video-intrinsic data (kind === 'asr'), never the user's caption/UI settings.
    // If there is no ASR track, or several that cannot be disambiguated down to
    // exactly one, return null (not found) rather than guessing.
    function pickAutoCaptionTrack(tracks, tracklist) {
      if (!tracks?.length) return null;
      const asrTracks = tracks.filter((t) => t.kind === 'asr');
      // Exactly one ASR track → unambiguous.
      if (asrTracks.length === 1) return asrTracks[0];
      // No ASR track → this video has no auto-caption to bind to. Not found.
      if (asrTracks.length === 0) return null;
      // Multiple ASR tracks (rare): the only video-intrinsic disambiguator is the
      // video's default audio language. Accept it ONLY if it resolves to exactly
      // one ASR track; anything else is genuinely ambiguous → not found.
      const audioTracks = tracklist?.audioTracks;
      const defAudioIdx = tracklist?.defaultAudioTrackIndex;
      const defAudio = Number.isInteger(defAudioIdx) ? audioTracks?.[defAudioIdx] : undefined;
      const audioCapIdx = defAudio?.captionTrackIndices?.[0];
      const byAudio = Number.isInteger(audioCapIdx) ? tracks[audioCapIdx] : undefined;
      const defCapIdx = tracklist?.defaultCaptionTrackIndex;
      const byDefaultCap = Number.isInteger(defCapIdx) ? tracks[defCapIdx] : undefined;
      const preferredLang = byAudio?.languageCode || byDefaultCap?.languageCode;
      if (!preferredLang) return null;
      const matches = asrTracks.filter((t) => t.languageCode === preferredLang);
      return matches.length === 1 ? matches[0] : null;
    }

    // The auto-translation languages YouTube offers for THIS player, normalized to
    // [{ code, name }]. This is YouTube's own runtime list (≈156, localized); the in-page
    // settings menu (yk-panel) reads it live to build its Auto-translate menu, so its
    // options are exactly what the player offers. [] when the captions API
    // isn't ready (the menu then shows 關閉 only until captions load).
    function translationLanguages() {
      const player = getPlayerEl();
      if (!player?.getOption) return [];
      let tls;
      try {
        tls = player.getOption('captions', 'translationLanguages');
      } catch {
        return [];
      }
      if (!Array.isArray(tls)) return [];
      return tls
        .map((l) => ({
          code: l.languageCode,
          // languageName is a plain localized string (NOT { simpleText }).
          name: typeof l.languageName === 'string' ? l.languageName : l.languageCode,
        }))
        .filter((l) => l.code);
    }

    // The asr caption variant the player CURRENTLY displays: { tlang } where tlang is
    // the auto-translation target ('' = original asr). Returns null when the player's
    // selected caption is NOT our asr track — a manual/translated-of-manual track, a
    // different asr language, or captions off — in which case the caller steps aside.
    // `trackLang` is the language we bound to (engine.state.trackLang).
    function currentAsrSelection(trackLang) {
      const player = getPlayerEl();
      if (!player?.getOption) return null;
      let cur;
      try {
        cur = player.getOption('captions', 'track');
      } catch {
        return null;
      }
      if (cur?.kind !== 'asr') return null;
      if (trackLang && cur.languageCode && cur.languageCode !== trackLang) return null;
      return { tlang: cur.translationLanguage?.languageCode || '' };
    }

    // Drive the player to display ONE asr variant: tlang === '' selects the original
    // auto-caption; otherwise its auto-translation to `tlang`. setOption makes the
    // PLAYER fetch the body (its request carries the pot token); the capture hook
    // grabs what it fetched. This is a SINGLE step with no
    // timing. Returns false when the player's caption API or the asr track isn't
    // available yet (caller retries next tick); true once setOption succeeded.
    //
    // 播放器沒有應用層字幕快取：任何 setOption 選軌（含同變體原樣重選）都會讓
    // 播放器重新請求 timedtext——「切一遍」（重選當前變體）就建立在這點上。
    function selectAsrVariant(track, tlang) {
      const player = getPlayerEl();
      if (!player?.setOption || !player?.getOption) return false;
      let asr;
      try {
        const list = player.getOption('captions', 'tracklist', { includeAsr: true });
        asr = list?.find?.(
          (t) => t.kind === 'asr' && (!track?.languageCode || t.languageCode === track.languageCode),
        );
      } catch {
        return false;
      }
      if (!asr) return false;
      let opt = asr;
      if (tlang) {
        // Drive only to a translation in the player's own translationLanguages list.
        // When tlang isn't in it (invalid/stale target, or the list isn't loaded yet),
        // return false so the caller retries.
        let tl;
        try {
          const tls = player.getOption('captions', 'translationLanguages');
          tl = Array.isArray(tls) ? tls.find((l) => l.languageCode === tlang) : null;
        } catch {
          return false;
        }
        if (!tl) return false;
        opt = { ...asr, translationLanguage: tl };
      }
      try {
        player.setOption('captions', 'track', opt);
      } catch {
        return false;
      }
      return true;
    }

    function waitForVideo(isActive) {
      return new Promise((resolve, reject) => {
        let n = 0;
        const id = setInterval(() => {
          if (!isActive()) {
            clearInterval(id);
            reject(new Error('aborted'));
            return;
          }
          const v = getVideo();
          if (v) {
            clearInterval(id);
            resolve(v);
          } else if (++n > 80) {
            clearInterval(id);
            reject(new Error('Video element not found'));
          }
        }, 250);
      });
    }

    function waitForPlayerResponse(timeoutMs, isActive) {
      const limit = typeof timeoutMs === 'number' ? timeoutMs : 12000;
      return new Promise((resolve) => {
        let start = Date.now();
        const id = setInterval(() => {
          const pr = getPlayerResponse();
          const tracks = captionTracklist(pr)?.captionTracks;
          if ((tracks && tracks.length) || !isActive()) {
            clearInterval(id);
            resolve(pr);
            return;
          }
          // 廣告中不計時（前貼廣告可長於 limit，且廣告期間播放器的 response 未必屬於
          // 主影片）：計時照走會把「有字幕的影片」誤判成 idle，且 init 不重試。
          if (isAdShowing()) {
            start = Date.now();
            return;
          }
          if (Date.now() - start > limit) {
            clearInterval(id);
            resolve(pr);
          }
        }, 200);
      });
    }

    return {
      currentVideoId,
      isWatchPage,
      getPlayerResponse,
      captionTracklist,
      getVideo,
      getPlayerEl,
      isAdShowing,
      pickAutoCaptionTrack,
      currentAsrSelection,
      selectAsrVariant,
      translationLanguages,
      waitForVideo,
      waitForPlayerResponse,
    };
  });
})();
