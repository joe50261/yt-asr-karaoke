'use strict';

const dualEl = document.getElementById('dualTrack');

chrome.storage.local.get({ dualTrack: false }, (s) => {
  dualEl.checked = !!s.dualTrack;
});

dualEl.addEventListener('change', () => {
  chrome.storage.local.set({ dualTrack: dualEl.checked });
});
