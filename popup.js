'use strict';

const dualEl = document.getElementById('dualTrack');
const styleEl = document.getElementById('captionStyle');

chrome.storage.local.get({ dualTrack: false, captionStyle: 'default' }, (s) => {
  dualEl.checked = !!s.dualTrack;
  styleEl.value = s.captionStyle || 'default';
});

dualEl.addEventListener('change', () => {
  chrome.storage.local.set({ dualTrack: dualEl.checked });
});

styleEl.addEventListener('change', () => {
  chrome.storage.local.set({ captionStyle: styleEl.value });
});
