'use strict';

const DEFAULTS = { dualTrack: false, maxLineChars: 48 };

function clampChars(n) {
  n = Math.round(Number(n));
  if (!Number.isFinite(n)) return DEFAULTS.maxLineChars;
  return Math.min(200, Math.max(10, n));
}

const dualEl = document.getElementById('dualTrack');
const maxEl = document.getElementById('maxLineChars');

chrome.storage.local.get(DEFAULTS, (s) => {
  dualEl.checked = !!s.dualTrack;
  maxEl.value = clampChars(s.maxLineChars);
});

dualEl.addEventListener('change', () => {
  chrome.storage.local.set({ dualTrack: dualEl.checked });
});

maxEl.addEventListener('change', () => {
  const v = clampChars(maxEl.value);
  maxEl.value = v;
  chrome.storage.local.set({ maxLineChars: v });
});
