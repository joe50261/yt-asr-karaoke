'use strict';

const dualEl = document.getElementById('dualTrack');
const styleEl = document.getElementById('captionStyle');
const transTopEl = document.getElementById('translationOnTop');

chrome.storage.local.get({ dualTrack: false, captionStyle: 'default', translationOnTop: false }, (s) => {
  dualEl.checked = !!s.dualTrack;
  styleEl.value = s.captionStyle || 'default';
  transTopEl.checked = !!s.translationOnTop;
});

dualEl.addEventListener('change', () => {
  chrome.storage.local.set({ dualTrack: dualEl.checked });
});

styleEl.addEventListener('change', () => {
  chrome.storage.local.set({ captionStyle: styleEl.value });
});

transTopEl.addEventListener('change', () => {
  chrome.storage.local.set({ translationOnTop: transTopEl.checked });
});
