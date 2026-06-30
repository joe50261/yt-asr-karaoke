// UNIT (Jest) — settings hub + in-page panel + yt runtime assert, via mock-injected deps
// (DI 的核心方法論：注入 mock 隔離測模組行為)。real DOM geometry/lifecycle → e2e-a。
const { makeSandbox, makeDom, load } = require('../_helpers');

const PANEL_ID = 'yt-karaoke-panel';
const PANEL_BTN_ID = 'yt-karaoke-panel-btn';

describe('yk-settings.apply — the one write path (mutate current + relay to bridge)', () => {
  function setup() {
    const s = makeSandbox();
    const posted = [];
    s.window.postMessage = (msg) => posted.push(msg);
    load(s, ['yk-di.js', 'yk-settings.js']);
    return { settings: s.window.__YK__.resolve('settings'), posted };
  }

  test('mutates current in place AND posts __ykSettingsSet with the coerced value', () => {
    const { settings, posted } = setup();
    posted.length = 0;
    settings.apply({ dualTrack: true });
    expect(settings.current.dualTrack).toBe(true); // live this frame, no round-trip
    const sets = posted.filter((m) => m.__ykSettingsSet);
    expect(sets).toHaveLength(1);
    expect(sets[0].settings).toEqual({ dualTrack: true });
  });

  test('coerces like the bridge push (captionStyle "" → default, autoDualLang undefined → "")', () => {
    const { settings } = setup();
    settings.apply({ captionStyle: '' });
    expect(settings.current.captionStyle).toBe('default');
    settings.apply({ autoDualLang: undefined });
    expect(settings.current.autoDualLang).toBe('');
  });

  test('ignores unknown keys (a UI bug cannot smuggle arbitrary keys into storage)', () => {
    const { settings, posted } = setup();
    posted.length = 0;
    settings.apply({ bogus: 1, dualTrack: true });
    const sets = posted.filter((m) => m.__ykSettingsSet);
    expect(sets[0].settings).toEqual({ dualTrack: true }); // bogus dropped
    expect(settings.current.bogus).toBeUndefined();
  });
});

describe('yk-panel — in-page settings menu (mock-injected settings + yt)', () => {
  function setup(opts = {}) {
    const s = makeSandbox();
    const dom = makeDom();
    s.document = dom.document;
    const player = dom.el('div');
    s.document.querySelector = (sel) =>
      sel === '#movie_player' || sel === '.html5-video-player' ? player : null;
    load(s, ['yk-di.js', 'yk-config.js']);
    const di = s.window.__YK__;
    const applied = [];
    const current = Object.assign(
      { dualTrack: false, captionStyle: 'default', translationOnTop: false, autoDualLang: '' },
      opts.current,
    );
    di.register('settings', [], () => ({
      current,
      apply: (p) => { applied.push(p); Object.assign(current, p); },
    }));
    let tls = opts.tls || [
      { code: 'zh-Hant', name: '中文（繁體）' },
      { code: 'ja', name: '日文' },
    ];
    di.register('yt', [], () => ({
      getPlayerEl: () => player,
      translationLanguages: () => tls,
    }));
    load(s, ['yk-panel.js']);
    return {
      s, dom, player, applied, current,
      panel: di.resolve('panel'),
      setTls: (v) => { tls = v; },
      $: (id) => s.document.getElementById(id),
    };
  }

  test('ensureButton mounts exactly one ⚙ gear on the player; idempotent', () => {
    const { panel, player, $ } = setup();
    panel.ensureButton();
    panel.ensureButton();
    const gear = $(PANEL_BTN_ID);
    expect(gear).toBeTruthy();
    expect(gear.textContent).toBe('⚙');
    expect(player.children.filter((c) => c.id === PANEL_BTN_ID)).toHaveLength(1);
  });

  test('clicking the gear opens the panel and builds the four controls', () => {
    const { panel, $ } = setup();
    panel.ensureButton();
    $(PANEL_BTN_ID).dispatch('click');
    const card = $(PANEL_ID);
    expect(card.dataset.open).toBe('true');
    expect(card.querySelector('#yk-set-style')).toBeTruthy();
    expect(card.querySelector('#yk-set-dual')).toBeTruthy();
    expect(card.querySelector('#yk-set-autolang')).toBeTruthy();
    expect(card.querySelector('#yk-set-transtop')).toBeTruthy();
    // clicking again closes
    $(PANEL_BTN_ID).dispatch('click');
    expect(card.dataset.open).toBe('false');
  });

  test('each control writes ONLY its own key via settings.apply (keys stay orthogonal)', () => {
    const { panel, applied, $ } = setup();
    panel.ensureButton();
    panel.setOpen(true);
    const style = $('yk-set-style');
    style.value = 'advanced';
    style.dispatch('change');
    expect(applied.at(-1)).toEqual({ captionStyle: 'advanced' });

    const dual = $('yk-set-dual');
    dual.checked = true;
    dual.dispatch('change');
    expect(applied.at(-1)).toEqual({ dualTrack: true });

    // autoDualLang must NOT touch dualTrack (auto-DRIVE vs dual DISPLAY are orthogonal)
    const lang = $('yk-set-autolang');
    lang.value = 'ja';
    lang.dispatch('change');
    expect(applied.at(-1)).toEqual({ autoDualLang: 'ja' });

    const top = $('yk-set-transtop');
    top.checked = true;
    top.dispatch('change');
    expect(applied.at(-1)).toEqual({ translationOnTop: true });
  });

  test('on open, the Auto-translate menu is built from yt.translationLanguages() (關閉 + langs)', () => {
    const { panel, $ } = setup();
    panel.ensureButton();
    panel.setOpen(true);
    const lang = $('yk-set-autolang');
    const opts = lang.querySelectorAll('option').map((o) => [o.value, o.textContent]);
    expect(opts).toEqual([['', '關閉'], ['zh-Hant', '中文（繁體）'], ['ja', '日文']]);
  });

  test('on open, controls reflect settings.current; a saved target no longer offered falls back to 關閉', () => {
    const { panel, $ } = setup({
      current: { dualTrack: true, captionStyle: 'yt', translationOnTop: true, autoDualLang: 'fr' },
      tls: [{ code: 'zh-Hant', name: '中文（繁體）' }], // fr not offered
    });
    panel.ensureButton();
    panel.setOpen(true);
    expect($('yk-set-style').value).toBe('yt');
    expect($('yk-set-dual').checked).toBe(true);
    expect($('yk-set-transtop').checked).toBe(true);
    expect($('yk-set-autolang').value).toBe(''); // stale fr → 關閉, never silently selected
  });

  test('language list is read live on each open (empty before captions, fills once available)', () => {
    const { panel, setTls, $ } = setup({ tls: [] });
    panel.ensureButton();
    panel.setOpen(true);
    expect($('yk-set-autolang').querySelectorAll('option').map((o) => o.value)).toEqual(['']);
    panel.setOpen(false);
    setTls([{ code: 'de', name: '德文' }]);
    panel.setOpen(true);
    expect($('yk-set-autolang').querySelectorAll('option').map((o) => o.value)).toEqual(['', 'de']);
  });

  test('remove() tears down both the gear and the card', () => {
    const { panel, $ } = setup();
    panel.ensureButton();
    panel.setOpen(true);
    expect($(PANEL_BTN_ID)).toBeTruthy();
    expect($(PANEL_ID)).toBeTruthy();
    panel.remove();
    expect($(PANEL_BTN_ID)).toBeNull();
    expect($(PANEL_ID)).toBeNull();
  });
});

describe('yk-yt — runtime assert (mock player DOM)', () => {
  function ytWith(tls) {
    const s = makeSandbox();
    let lastSet = null;
    const player = {
      getOption: (_m, k) => (k === 'tracklist' ? [{ kind: 'asr', languageCode: 'en' }] : k === 'translationLanguages' ? tls : null),
      setOption: (_m, _k, v) => { lastSet = v; },
    };
    s.document.querySelector = (sel) => (sel === '#movie_player' || sel === '.html5-video-player' ? player : null);
    load(s, ['yk-di.js', 'yk-yt.js']);
    return { yt: s.window.__YK__.resolve('yt'), get lastSet() { return lastSet; } };
  }

  test('translationLanguages normalizes to {code,name}', () => {
    const { yt } = ytWith([{ languageCode: 'zh-Hant', languageName: '中文（繁體）' }]);
    expect(yt.translationLanguages()).toEqual([{ code: 'zh-Hant', name: '中文（繁體）' }]);
  });

  test('selectAsrVariant drives a VALID tlang with the player real tl object', () => {
    const ctx = ytWith([{ languageCode: 'zh-Hant', languageName: '中文（繁體）' }]);
    expect(ctx.yt.selectAsrVariant({ languageCode: 'en' }, 'zh-Hant')).toBe(true);
    expect(ctx.lastSet.translationLanguage.languageCode).toBe('zh-Hant');
  });

  test('selectAsrVariant REFUSES a tlang the player does not offer (no fabrication)', () => {
    const ctx = ytWith([{ languageCode: 'zh-Hant', languageName: '中文（繁體）' }]);
    expect(ctx.yt.selectAsrVariant({ languageCode: 'en' }, 'xx-bogus')).toBe(false);
    expect(ctx.lastSet).toBeNull();
  });
});
