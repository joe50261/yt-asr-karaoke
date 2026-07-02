/**
 * yk-yt — stateless adapter over YouTube's player + DOM. Everything that reads the
 * page/player lives here so the rest of the code never touches YT internals directly.
 * No module state: lifecycle-dependent inputs (trackLang, the abort flag) are passed
 * in as arguments — `isActive` MUST be a function/getter (not a boolean snapshot),
 * or a wait would never abort after teardown.
 */
(function () {
  'use strict';
  window.__YK__.register('yt', [], () => {
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

    function getPlayerResponse() {
      return (
        window.ytInitialPlayerResponse ||
        document.querySelector('#movie_player')?.getPlayerResponse?.() ||
        null
      );
    }

    function getVideo() {
      return (
        document.querySelector('#movie_player video') ||
        document.querySelector('video.html5-main-video')
      );
    }

    function getPlayerEl() {
      return (
        document.querySelector('#movie_player') || document.querySelector('.html5-video-player')
      );
    }

    // True while YouTube is playing an ad: the player gains the `ad-showing`
    // class and the active <video> element is the ad, not the watch video.
    function isAdShowing() {
      const player =
        document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
      return !!player && player.classList.contains('ad-showing');
    }

    // Identify the auto-generated (ASR) caption track for THIS video using only
    // video-intrinsic data (kind === 'asr'), never the user's caption/UI settings.
    // We NEVER guess: if there is no ASR track, or multiple ASR tracks that cannot
    // be disambiguated down to exactly one, return null (not found).
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
    // settings menu (yk-panel) reads it live to build its Auto-translate menu, so the menu
    // can never offer a code the player won't actually fetch. [] when the captions API
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
    // PLAYER fetch the body (its request carries the pot token) — we never fetch; the
    // capture hook grabs whatever the player fetched. This is a SINGLE step with no
    // timing: the engine sequences original-then-translation, gating each call on the
    // previous body actually being captured (see engine.maybeAutoDrive), so there is
    // no guessed delay. Returns false when the player's caption API or the asr track
    // isn't available yet (caller retries next tick); true once setOption succeeded.
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
        // Runtime assert: only drive to a translation YouTube actually offers, using the
        // player's REAL translationLanguage object (never a fabricated one). Refuse —
        // return false so the caller retries / stands down — when tlang isn't a real
        // option (invalid/stale target, or the list isn't loaded yet), so a bogus code
        // can never force a fetch for a language that doesn't exist.
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

    // Force the player to RE-FETCH the asr variant `tlang` even though its body is already
    // cached: turn captions OFF, then re-select. Re-selecting the SAME variant WITHOUT the
    // off step is a no-op on YouTube's side (the player serves its cached body) — verified;
    // the OFF→ON pair reliably issues a fresh timedtext XHR. This fresh fetch is what lets
    // yk-native's transform (re)apply or be removed: native ON/OFF, single→dual upgrade, and
    // settings-change re-cook all ride on it. The re-select is scheduled after a small gap so
    // the OFF registers first. Used only by yk-native's edge machine; we never fetch here.
    //
    // The delayed ON step is guarded, because a bare setTimeout would mis-fire in three ways:
    //  - SPA navigation during the gap → it would select the OLD video's variant on the NEW
    //    video's player. Guard: snapshot the video id and bail if it changed.
    //  - the user (or the player) picks a track during the gap → re-selecting would override
    //    them. Guard: bail if a track with a languageCode is already displayed (our own OFF
    //    step leaves an empty selection, so "non-empty" means someone else chose).
    //  - selectAsrVariant transiently fails (tracklist mid-ad / player mid-swap) → captions
    //    would be left OFF forever with no caller able to retry (the edge machine sees a null
    //    selection and waits). Guard: bounded retries, same bail conditions each attempt.
    const REFETCH_ON_GAP_MS = 120; // verified OFF→ON gap that reliably re-issues the XHR
    const REFETCH_RETRY_MS = 240;
    const REFETCH_MAX_TRIES = 25; // ~6s of retries, then give up (user can re-pick manually)
    function refetchCaption(track, tlang) {
      const player = getPlayerEl();
      if (!player?.setOption) return false;
      try {
        player.setOption('captions', 'track', {});
      } catch {
        return false;
      }
      const vid = currentVideoId();
      let tries = 0;
      const reselect = () => {
        if (currentVideoId() !== vid) return; // navigated away: never touch the new video
        let cur = null;
        try {
          cur = getPlayerEl()?.getOption?.('captions', 'track') || null;
        } catch {
          /* player mid-swap: fall through and let selectAsrVariant retry */
        }
        if (cur && cur.languageCode) return; // someone already picked a track: stand down
        if (!selectAsrVariant(track, tlang || '') && ++tries < REFETCH_MAX_TRIES) {
          setTimeout(reselect, REFETCH_RETRY_MS);
        }
      };
      setTimeout(reselect, REFETCH_ON_GAP_MS);
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
        const start = Date.now();
        const id = setInterval(() => {
          const pr = getPlayerResponse();
          const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if ((tracks && tracks.length) || Date.now() - start > limit || !isActive()) {
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
      getVideo,
      getPlayerEl,
      isAdShowing,
      pickAutoCaptionTrack,
      currentAsrSelection,
      selectAsrVariant,
      refetchCaption,
      translationLanguages,
      waitForVideo,
      waitForPlayerResponse,
    };
  });
})();
