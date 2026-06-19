'use strict';

const DEFAULTS = { dualTrack: false, maxLineWords: 10 };

function clampWords(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return DEFAULTS.maxLineWords;
  return Math.min(40, Math.max(3, n));
}

const dualEl = document.getElementById('dualTrack');
const maxEl = document.getElementById('maxLineWords');

chrome.storage.local.get(DEFAULTS, (s) => {
  dualEl.checked = !!s.dualTrack;
  maxEl.value = clampWords(s.maxLineWords);
});

dualEl.addEventListener('change', () => {
  chrome.storage.local.set({ dualTrack: dualEl.checked });
});

maxEl.addEventListener('change', () => {
  const v = clampWords(maxEl.value);
  maxEl.value = v;
  chrome.storage.local.set({ maxLineWords: v });
});
