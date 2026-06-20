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
      waitForVideo,
      waitForPlayerResponse,
    };
  });
})();
