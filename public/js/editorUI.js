/**
 * StatusDrop — polished in-app editor UI (presentation layer).
 *
 * Phone-framed full-screen editor that drives the tested recipe model in
 * editor.js (EditorInstance) + editorAudio.js (audio helpers): a centered 9:16
 * curved preview, draggable/resizable emoji stickers and styled text, a compact
 * toolbar (Trim / Text / Music / Sticker) with Discard / Save, small slide-in
 * trays (tap a tool to open, tap again to close — they never cover the page),
 * an in-frame trim bar with Play / Cancel / Save, and a library music picker.
 *
 * Exposes window.StatusDropEditorUI.open(files) / .reset() and maintains
 * window.StatusDropEditorController { getInstances, getRecipesByKey, destroy }.
 * No video pixels are decoded or re-encoded in the browser (Req 2.1).
 */
(function () {
  'use strict';

  function E() { return window.StatusDropEditor; }
  function A() { return window.StatusDropEditorAudio; }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  // Build a labelled button with a leading Bootstrap Icon (icon-only if no label).
  function btnWith(cls, iconClass, label) {
    var b = el('button', cls);
    if (iconClass) b.appendChild(el('i', 'bi ' + iconClass));
    if (label != null) b.appendChild(el('span', 'sdui-btn-lbl', label));
    return b;
  }

  // ---- sticker rendering helpers (webp images + .tgs Lottie animations) ----
  var tgsCache = {};
  function isTgs(url) { return /\.tgs(\?|$)/i.test(url || ''); }
  // Resolve once pako (gunzip) + lottie-web are available (injected in styles).
  function ensureLibs() {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function check() {
        if (window.pako && window.lottie) return resolve(true);
        if (Date.now() - t0 > 8000) return resolve(false);
        setTimeout(check, 80);
      })();
    });
  }
  // Fetch a .tgs (gzipped Lottie JSON), inflate with pako, parse, and cache.
  function loadTgs(url) {
    if (tgsCache[url]) return Promise.resolve(tgsCache[url]);
    return fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
      var bytes = new Uint8Array(buf), json;
      if (window.pako && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        json = window.pako.inflate(bytes, { to: 'string' });
      } else {
        json = new TextDecoder().decode(bytes); // already-plain JSON fallback
      }
      var data = JSON.parse(json);
      tgsCache[url] = data;
      return data;
    });
  }
  function renderLottieInto(container, url, opts) {
    ensureLibs().then(function (ok) {
      if (!ok || !window.lottie) return;
      loadTgs(url).then(function (data) {
        try {
          container._lottie = window.lottie.loadAnimation({
            container: container, renderer: 'svg',
            loop: !opts || opts.loop !== false, autoplay: !opts || opts.autoplay !== false,
            animationData: data
          });
        } catch (_) {}
      }).catch(function () {});
    });
  }
  // Destroy any Lottie animations inside a node before it is cleared (no leaks).
  function destroyLottiesIn(node) {
    if (!node || !node.querySelectorAll) return;
    Array.prototype.forEach.call(node.querySelectorAll('*'), function (x) {
      if (x._lottie) { try { x._lottie.destroy(); } catch (_) {} x._lottie = null; }
    });
  }

  var STICKERS = [
    { ref: 'emoji_smile', g: '\uD83D\uDE00' }, { ref: 'emoji_heart', g: '\u2764\uFE0F' },
    { ref: 'emoji_fire', g: '\uD83D\uDD25' }, { ref: 'emoji_star', g: '\u2B50' },
    { ref: 'emoji_party', g: '\uD83C\uDF89' }, { ref: 'emoji_cool', g: '\uD83D\uDE0E' },
    { ref: 'emoji_cry', g: '\uD83D\uDE2D' }, { ref: 'emoji_love', g: '\uD83D\uDE0D' },
    { ref: 'emoji_100', g: '\uD83D\uDCAF' }, { ref: 'emoji_clap', g: '\uD83D\uDC4F' },
    { ref: 'emoji_rocket', g: '\uD83D\uDE80' }, { ref: 'emoji_sparkle', g: '\u2728' },
    { ref: 'emoji_thumbsup', g: '\uD83D\uDC4D' }, { ref: 'emoji_pray', g: '\uD83D\uDE4F' },
    { ref: 'emoji_flower', g: '\uD83C\uDF38' }, { ref: 'emoji_crown', g: '\uD83D\uDC51' }
  ];
  var STICKER_GLYPH = STICKERS.reduce(function (m, s) { m[s.ref] = s.g; return m; }, {});
  var TEXT_COLORS = ['#FFFFFF', '#000000', '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#5856D6', '#FF2D55'];
  var BOX_COLORS = ['#000000', '#FFFFFF', '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#5856D6', '#FF2D55'];
  // Text fonts (served from /vendor/fonts via @fontsource). `dir` = package name,
  // `name` = the @font-face family, `weight` = preview render weight.
  var FONTS = [
    { name: 'Roboto', dir: 'roboto', weight: 600 },
    { name: 'Caveat', dir: 'caveat', weight: 400 },
    { name: 'Fira Code', dir: 'fira-code', weight: 500 },
    { name: 'Bebas Neue', dir: 'bebas-neue', weight: 400 },
    { name: 'OpenDyslexic', dir: 'opendyslexic', weight: 600 },
    { name: 'Great Vibes', dir: 'great-vibes', weight: 400 },
    { name: 'Cormorant Garamond', dir: 'cormorant-garamond', weight: 600 }
  ];
  var FONT_WEIGHT = FONTS.reduce(function (m, f) { m[f.name] = f.weight; return m; }, {});
  var CANVAS_H = 1920;
  var STICKER_BASE_FRAC = 0.12;
  // Animated .tgs stickers are temporarily disabled: lottie-web's canvas renderer
  // (used server-side) mishandles track mattes (white-circle artifact) and is
  // heavy in the mobile preview. Flip to true once a matte-correct engine
  // (rlottie/ThorVG) is wired in (stage B). Static webp stickers are unaffected.
  var ANIMATED_STICKERS = false;

  var ui = null;

  function open(files) {
    if (!E() || typeof E().EditorInstance !== 'function') {
      alert('The editor failed to load. Your videos will be compressed without edits.');
      return;
    }
    teardown();
    injectStyles();
    var Editor = E();
    var instances = [], videos = [], objectUrls = [];

    var modal = el('div', 'sdui-modal');
    var shell = el('div', 'sdui-shell');

    var top = el('div', 'sdui-top');
    var tabs = el('div', 'sdui-tabs');
    var x = el('button', 'sdui-x'); x.title = 'Close (keeps edits)';
    x.appendChild(el('i', 'bi bi-x-lg'));
    x.addEventListener('click', save);
    top.appendChild(tabs);
    // Local-only "Test render" button: renders the real output via the dev
    // harness (POST /api/dev-render). Hidden on the production site.
    if (isDevHost()) {
      var testBtn = el('button', 'sdui-x sdui-testbtn'); testBtn.title = 'Test render (local)';
      testBtn.appendChild(el('i', 'bi bi-film'));
      testBtn.addEventListener('click', testRender);
      top.appendChild(testBtn);
    }
    top.appendChild(x);

    var stage = el('div', 'sdui-stage');
    var frame = el('div', 'sdui-frame');
    var layer = el('div', 'sdui-layer');
    var playBtn = el('button', 'sdui-play');
    playBtn.appendChild(el('i', 'bi bi-play-fill'));
    var trimBar = el('div', 'sdui-trim');
    var musicAudio = el('audio'); musicAudio.preload = 'auto'; musicAudio.style.display = 'none';
    frame.appendChild(layer); frame.appendChild(playBtn); frame.appendChild(trimBar); frame.appendChild(musicAudio);

    var dock = el('div', 'sdui-dock');
    var discard = el('button', 'sdui-act discard'); discard.title = 'Discard edits';
    discard.appendChild(el('i', 'bi bi-x-lg'));
    discard.addEventListener('click', discardAll);
    var pill = el('div', 'sdui-pill');
    [
      { id: 'trim', ic: 'bi-scissors', label: 'Trim' },
      { id: 'text', ic: 'bi-fonts', label: 'Text' },
      { id: 'music', ic: 'bi-music-note-beamed', label: 'Music' },
      { id: 'sticker', ic: 'bi-emoji-smile', label: 'Sticker' }
    ].forEach(function (t) {
      var b = el('button', 'sdui-tool'); b.dataset.tool = t.id;
      b.appendChild(el('i', 'ic bi ' + t.ic));
      b.appendChild(el('span', null, t.label));
      b.addEventListener('click', function () { toggleTool(t.id); });
      pill.appendChild(b);
    });
    var saveBtn = el('button', 'sdui-act save'); saveBtn.title = 'Save';
    saveBtn.appendChild(el('i', 'bi bi-check-lg'));
    saveBtn.addEventListener('click', save);
    dock.appendChild(discard); dock.appendChild(pill); dock.appendChild(saveBtn);

    var tray = el('div', 'sdui-tray');

    stage.appendChild(frame); stage.appendChild(dock); stage.appendChild(tray);
    shell.appendChild(top); shell.appendChild(stage);
    modal.appendChild(shell);
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    var srcFiles = (files || []).slice(0, Editor.MAX_VIDEOS || 3);
    srcFiles.forEach(function (file, i) {
      var inst = new Editor.EditorInstance(i, { uploadKey: null });
      var v = el('video');
      v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.preload = 'auto';
      // Original audio plays by default (Req 7.1); reflect the recipe mute/volume.
      var Aud = A();
      v.muted = Aud ? Aud.isMuted(inst) : false;
      v.volume = Aud ? Math.max(0, Math.min(1, Aud.getOriginalVolume(inst) / 100)) : 1;
      v.style.display = i === 0 ? 'block' : 'none';
      try { var url = URL.createObjectURL(file); objectUrls.push(url); v.src = url; } catch (e) {}
      v.addEventListener('loadedmetadata', function () {
        inst.sourceDuration = isFinite(v.duration) ? v.duration : 0;
        if (ui && i === ui.active) renderOverlays();
      });
      v.addEventListener('ended', function () { if (ui) { ui.playBtn.style.display = ''; pauseMusic(); freezeStickers(false); } });
      inst.previewEl = v;
      frame.insertBefore(v, layer);
      instances.push(inst); videos.push(v);

      var tab = el('button', 'sdui-tab' + (i === 0 ? ' active' : ''), 'Video ' + (i + 1));
      tab.addEventListener('click', function () { switchTo(i); });
      tabs.appendChild(tab);
    });
    if (tabs.children.length <= 1) tabs.style.visibility = 'hidden';

    playBtn.addEventListener('click', togglePlay);
    layer.addEventListener('pointerdown', function (e) { if (e.target === layer) deselect(); });
    // Tap anywhere on the video (empty preview area) to toggle play/pause.
    layer.addEventListener('click', function (e) { if (e.target === layer) togglePlay(); });

    ui = {
      instances: instances, videos: videos, objectUrls: objectUrls, active: 0, files: srcFiles,
      modal: modal, shell: shell, frame: frame, layer: layer, tray: tray, tabs: tabs,
      playBtn: playBtn, trimBar: trimBar, dock: dock, musicAudio: musicAudio, musicUrls: {}, trackDuration: {}, wavePeaks: {},
      selectedId: null, openTool: null, trim: null, trimPrev: null
    };
    bindController(instances);
    renderOverlays();

    // Tap the dark backdrop (outside the frame) or press Esc to finish a tool.
    stage.addEventListener('pointerdown', function (e) { if (ui && ui.openTool && e.target === stage) closeTray(); });
    ui.onKey = function (e) { if (e.key === 'Escape') { if (ui.openTool) closeTray(); else save(); } };
    document.addEventListener('keydown', ui.onKey);
  }

  function bindController(instances) {
    window.StatusDropEditorController = {
      getInstances: function () { return instances.slice(); },
      getInstance: function (i) { return instances[i] || null; },
      getRecipesByKey: function () {
        var map = {};
        instances.forEach(function (inst) {
          var r = inst.getRecipe();
          if (r && inst.uploadKey) map[inst.uploadKey] = r;
        });
        return map;
      },
      destroy: teardown
    };
  }

  function teardown() {
    if (!ui) return;
    stopTrimPlayback();
    destroyLottiesIn(ui.layer); destroyLottiesIn(ui.tray);
    if (ui.musicAudio) { try { ui.musicAudio.pause(); } catch (e) {} }
    if (ui.onKey) document.removeEventListener('keydown', ui.onKey);
    (ui.videos || []).forEach(function (v) { try { v.pause(); } catch (e) {} });
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      (ui.objectUrls || []).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    }
    if (ui.modal && ui.modal.parentNode) ui.modal.parentNode.removeChild(ui.modal);
    document.body.style.overflow = '';
    ui = null;
  }

  function save() {
    var instances = ui ? ui.instances : [];
    teardown();
    bindController(instances);
  }

  function discardAll() {
    if (!ui) return;
    if (!window.confirm('Discard all edits for these videos?')) return;
    ui.instances.forEach(function (inst) { if (typeof inst.reset === 'function') inst.reset(); });
    teardown();
    window.StatusDropEditorController = {
      getInstances: function () { return []; },
      getRecipesByKey: function () { return {}; },
      destroy: function () {}
    };
  }

  function activeInst() { return ui.instances[ui.active]; }

  function switchTo(i) {
    if (!ui || i === ui.active) return;
    closeTray();
    pauseMusic();
    ui.videos.forEach(function (v, idx) {
      v.style.display = idx === i ? 'block' : 'none';
      if (idx !== i) { try { v.pause(); } catch (e) {} }
    });
    Array.prototype.forEach.call(ui.tabs.children, function (t, idx) { t.classList.toggle('active', idx === i); });
    ui.active = i; ui.selectedId = null;
    ui.playBtn.style.display = '';
    applyOriginalAudio(); applyMusicAudio();
    destroyLottiesIn(ui.layer); ui.layer.innerHTML = ''; ui._ovEls = {};
    renderOverlays();
  }

  function togglePlay() {
    var v = ui.videos[ui.active]; if (!v) return;
    // While trimming, delegate so the trim FAB play/pause icon stays in sync.
    if (ui.openTool === 'trim' && ui.trim) { toggleTrimPlay(); return; }
    if (v.paused) {
      applyOriginalAudio();
      playVideo(v); ui.playBtn.style.display = 'none';
      startMusic(); freezeStickers(true);
    } else { v.pause(); ui.playBtn.style.display = ''; pauseMusic(); freezeStickers(false); }
  }

  // Start playback robustly across browsers: some mobile browsers reject an
  // unmuted play() even on a tap; fall back to a muted play so the preview at
  // least runs (the recipe's intended mute/volume is unchanged).
  function playVideo(v) {
    try {
      var p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { try { v.muted = true; var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {}); } catch (_) {} });
      }
    } catch (_) {}
  }

  // ---- preview audio (original video track + selected music) --------------
  // Reflect the recipe's mute/volume onto the active <video> so the original
  // audio is actually audible (default unmuted, Req 7.1).
  function applyOriginalAudio() {
    if (!ui) return;
    var Aud = A(); var inst = activeInst(); var v = ui.videos[ui.active];
    if (!v || !Aud) return;
    v.muted = Aud.isMuted(inst);
    v.volume = Math.max(0, Math.min(1, Aud.getOriginalVolume(inst) / 100));
  }
  // Point the hidden <audio> at the selected library track and mirror its
  // volume / loop settings. The track URL comes from GET /api/library; if no
  // audio file is hosted at that URL the element simply stays silent.
  function applyMusicAudio() {
    if (!ui || !ui.musicAudio) return;
    var Aud = A(); var inst = activeInst();
    var m = Aud ? Aud.getMusic(inst) : null;
    var a = ui.musicAudio;
    if (!m) { try { a.pause(); } catch (_) {} if (a.getAttribute('src')) { a.removeAttribute('src'); try { a.load(); } catch (_) {} } return; }
    var url = ui.musicUrls[m.assetRef];
    if (url && a.getAttribute('src') !== url) { a.src = url; }
    a.volume = Math.max(0, Math.min(1, (m.volume != null ? m.volume : 80) / 100));
    a.loop = (m.loopMode !== 'once');
  }
  function startMusic() {
    if (!ui || !ui.musicAudio) return;
    var Aud = A(); var inst = activeInst(); var m = Aud ? Aud.getMusic(inst) : null;
    applyMusicAudio();
    if (!m || !ui.musicAudio.getAttribute('src')) return;
    try { ui.musicAudio.currentTime = m.audioStart || 0; } catch (_) {}
    ui.musicAudio.play().catch(function () {});
  }
  function pauseMusic() { if (ui && ui.musicAudio) { try { ui.musicAudio.pause(); } catch (_) {} } }

  // Pause/resume Lottie sticker animations. While the video plays we freeze them
  // so the decoder gets the CPU (smooth playback on phones); they animate again
  // when the video is paused. The final rendered video animates them fully.
  function freezeStickers(freeze) {
    if (!ui || !ui._ovEls) return;
    Object.keys(ui._ovEls).forEach(function (id) {
      var e = ui._ovEls[id];
      if (e && e._lottie) { try { freeze ? e._lottie.pause() : e._lottie.play(); } catch (_) {} }
    });
  }

  // ---- local "Test render" (dev harness only) -----------------------------
  function isDevHost() {
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1'
      || /^192\.168\./.test(h) || /^10\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }
  function testRender() {
    if (!ui) return;
    var inst = activeInst();
    var file = ui.files && ui.files[ui.active];
    if (!file) { alert('No source video to render.'); return; }
    var recipe = (typeof inst.getRecipe === 'function') ? inst.getRecipe() : null;
    try { if (ui.videos[ui.active]) ui.videos[ui.active].pause(); } catch (_) {}
    pauseMusic();
    showRenderOverlay('rendering');
    var fd = new FormData();
    fd.append('video', file, file.name || 'video.mp4');
    fd.append('recipe', recipe ? JSON.stringify(recipe) : 'null');
    fetch('/api/dev-render', { method: 'POST', body: fd })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
        var notes = r.headers.get('X-Render-Notes') || '';
        return r.blob().then(function (b) { return { blob: b, notes: notes }; });
      })
      .then(function (res) { showRenderOverlay('result', res.blob, res.notes); })
      .catch(function (e) { showRenderOverlay('error', null, e.message); });
  }
  function closeRenderOverlay() {
    var o = document.getElementById('sdui-render');
    if (o) { var v = o.querySelector('video'); if (v && v.src) { try { URL.revokeObjectURL(v.src); } catch (_) {} } if (o.parentNode) o.parentNode.removeChild(o); }
  }
  function showRenderOverlay(state, blob, notes) {
    closeRenderOverlay();
    var o = el('div', 'sdui-render'); o.id = 'sdui-render';
    var card = el('div', 'sdui-render-card');
    var head = el('div', 'sdui-tray-head');
    head.appendChild(el('span', null, 'Test render'));
    var c = el('button', 'sdui-trayclose'); c.appendChild(el('i', 'bi bi-x-lg')); c.addEventListener('click', closeRenderOverlay);
    head.appendChild(c); card.appendChild(head);

    if (state === 'rendering') {
      card.appendChild(el('div', 'sdui-hint', 'Rendering the real output on the local server\u2026 this can take a few seconds (animated stickers take longer).'));
      var sp = el('div', 'sdui-spin'); card.appendChild(sp);
    } else if (state === 'result') {
      var url = URL.createObjectURL(blob);
      var vid = el('video', 'sdui-render-vid'); vid.src = url; vid.controls = true; vid.playsInline = true; vid.setAttribute('playsinline', ''); vid.autoplay = true;
      card.appendChild(vid);
      var dl = el('a', 'sdui-btn'); dl.href = url; dl.download = 'edited.mp4';
      dl.appendChild(el('i', 'bi bi-download')); dl.appendChild(el('span', 'sdui-btn-lbl', 'Download'));
      var row = el('div', 'sdui-row'); row.appendChild(dl); card.appendChild(row);
      if (notes) card.appendChild(el('div', 'sdui-hint', 'Note: ' + notes));
    } else {
      card.appendChild(el('div', 'sdui-err', 'Render failed: ' + (notes || 'unknown error')));
      card.appendChild(el('div', 'sdui-hint', 'Make sure you opened this via the dev server (node dev-server.js), not the production site.'));
    }
    o.appendChild(card);
    o.addEventListener('pointerdown', function (e) { if (e.target === o) closeRenderOverlay(); });
    (ui ? ui.modal : document.body).appendChild(o);
  }

  // ---- overlay rendering --------------------------------------------------
  function frameDims() { var r = ui.layer.getBoundingClientRect(); return { w: r.width, h: r.height }; }
  function cssEsc(s) { return String(s).replace(/"/g, '\\"'); }

  function recomputeDirty(inst) {
    var a = inst.audio || {};
    var clean = !inst._trim
      && (!inst.textOverlays || inst.textOverlays.length === 0)
      && (!inst.stickers || inst.stickers.length === 0)
      && a.originalMuted === false && (a.originalVolume === 100 || a.originalVolume == null) && !a.music;
    if (clean) inst._dirty = false;
  }

  function renderOverlays() {
    if (!ui) return;
    removeSelBar();
    var inst = activeInst();
    var dims = frameDims();
    var layer = ui.layer;
    ui._ovEls = ui._ovEls || {};

    // Build the desired set (id -> descriptor), preserving recipe order.
    var desired = {}, order = [];
    (inst.textOverlays || []).forEach(function (o) { desired[o.id] = { kind: 'text', o: o }; order.push(o.id); });
    (inst.stickers || []).forEach(function (s) { desired[s.id] = { kind: 'sticker', s: s }; order.push(s.id); });

    // Remove elements that are gone (destroying their Lottie if any).
    Object.keys(ui._ovEls).forEach(function (id) {
      if (!desired[id]) { removeOvEl(ui._ovEls[id]); delete ui._ovEls[id]; }
    });

    // Create new / update existing — reusing elements so Lottie isn't rebuilt.
    order.forEach(function (id) {
      var d = desired[id];
      var ex = ui._ovEls[id];
      if (d.kind === 'text') {
        if (!ex || ex.dataset.kind !== 'text') { if (ex) removeOvEl(ex); ex = buildTextEl(d.o, dims); ui._ovEls[id] = ex; }
        else applyTextStyles(ex, d.o, dims);
      } else {
        // Reuse only when the same asset; a different assetRef needs a rebuild.
        if (!ex || ex.dataset.kind !== 'sticker' || ex._assetRef !== (d.s.assetRef || '')) {
          if (ex) removeOvEl(ex); ex = buildStickerEl(d.s, dims); ui._ovEls[id] = ex;
        } else applyStickerTransform(ex, d.s, dims);
      }
    });

    // Order the DOM to match the recipe (appendChild moves existing nodes).
    order.forEach(function (id) { var e = ui._ovEls[id]; if (e) layer.appendChild(e); });

    // Selection highlight.
    Object.keys(ui._ovEls).forEach(function (id) { ui._ovEls[id].classList.toggle('sel', id === ui.selectedId); });
    if (ui.selectedId) {
      if (ui._ovEls[ui.selectedId]) showSelBar(ui.selectedId);
      else ui.selectedId = null;
    }
  }

  function removeOvEl(elx) {
    if (!elx) return;
    if (elx._lottie) { try { elx._lottie.destroy(); } catch (_) {} elx._lottie = null; }
    if (elx.parentNode) elx.parentNode.removeChild(elx);
  }

  function position(n, pos, rotation) {
    n.style.left = ((pos && pos.x != null ? pos.x : 0.5) * 100) + '%';
    n.style.top = ((pos && pos.y != null ? pos.y : 0.5) * 100) + '%';
    n.style.transform = 'translate(-50%,-50%) rotate(' + (rotation || 0) + 'deg)';
  }

  function buildTextEl(o, dims) {
    var n = el('div', 'sdui-ov sdui-ov-text');
    n.dataset.id = o.id; n.dataset.kind = 'text';
    applyTextStyles(n, o, dims);
    attachDrag(n, o.id);
    return n;
  }

  function applyTextStyles(n, o, dims) {
    n.textContent = o.text;
    n.style.color = o.textColor || '#fff';
    var hasBg = o.bgColor && o.bgColor !== '#00000000';
    var shape = o.boxShape || (hasBg ? 'rounded' : 'none');
    if (shape === 'none') {
      n.style.background = 'transparent'; n.style.padding = '0'; n.style.borderRadius = '0';
    } else {
      n.style.background = hasBg ? o.bgColor : 'rgba(0,0,0,0.55)';
      n.style.padding = '4px 12px';
      n.style.borderRadius = shape === 'square' ? '2px' : '14px';
    }
    n.style.fontFamily = o.font ? ("'" + o.font + "', Inter, sans-serif") : 'Inter, sans-serif';
    n.style.fontWeight = o.font && FONT_WEIGHT[o.font] ? FONT_WEIGHT[o.font] : 700;
    n.style.fontSize = Math.max(8, (o.fontSize / CANVAS_H) * dims.h) + 'px';
    position(n, o.pos, o.rotation);
  }

  function applyStickerTransform(n, s, dims) {
    var size = dims.h * STICKER_BASE_FRAC * 1.7 * (s.scale || 1);
    n.style.width = size + 'px'; n.style.height = size + 'px';
    position(n, s.pos, s.rotation);
  }

  function buildStickerEl(s, dims) {
    var n = el('div', 'sdui-ov sdui-ov-sticker');
    n.dataset.id = s.id; n.dataset.kind = 'sticker';
    var ref = s.assetRef || '';
    n._assetRef = ref;
    if (isTgs(ref)) {
      renderLottieInto(n, ref, { loop: true, autoplay: true });
    } else {
      var img = el('img', 'sdui-sticker-img'); img.src = ref; img.alt = 'sticker'; img.draggable = false;
      n.appendChild(img);
    }
    applyStickerTransform(n, s, dims);
    attachDrag(n, s.id);
    return n;
  }

  function attachDrag(n, id) {
    var dragging = false;
    n.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      select(id);
      dragging = true; n.style.cursor = 'grabbing';
      try { n.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    n.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var inst = activeInst();
      var rel = inst.pointerToRelative(e.clientX, e.clientY, ui.layer.getBoundingClientRect());
      inst.applyDragToRelative(id, rel);
      n.style.left = (rel.x * 100) + '%';
      n.style.top = (rel.y * 100) + '%';
    });
    function end() { dragging = false; n.style.cursor = 'grab'; }
    n.addEventListener('pointerup', end);
    n.addEventListener('pointercancel', end);
  }

  function select(id) {
    ui.selectedId = id;
    Array.prototype.forEach.call(ui.layer.children, function (c) { c.classList.toggle('sel', c.dataset.id === id); });
    showSelBar(id);
  }
  function deselect() {
    ui.selectedId = null; removeSelBar();
    Array.prototype.forEach.call(ui.layer.children, function (c) { c.classList.remove('sel'); });
  }
  function removeSelBar() { var b = document.getElementById('sdui-selbar'); if (b && b.parentNode) b.parentNode.removeChild(b); }

  function showSelBar(id) {
    removeSelBar();
    var inst = activeInst();
    var found = typeof inst._findEntry === 'function' ? inst._findEntry(id) : null;
    var bar = el('div', 'sdui-selbar'); bar.id = 'sdui-selbar';
    function mk(iconClass, cls, fn) {
      var b = el('button', cls || null);
      b.appendChild(el('i', 'bi ' + iconClass));
      b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
      bar.appendChild(b);
    }
    mk('bi-dash-lg', null, function () { inst.applyPinch(id, 0.85, 0); renderOverlays(); });
    mk('bi-plus-lg', null, function () { inst.applyPinch(id, 1.18, 0); renderOverlays(); });
    mk('bi-arrow-counterclockwise', null, function () { inst.applyPinch(id, 1, -15); renderOverlays(); });
    mk('bi-arrow-clockwise', null, function () { inst.applyPinch(id, 1, 15); renderOverlays(); });
    if (found && found.kind === 'text') mk('bi-pencil', null, function () { toggleTool('text', id); });
    mk('bi-trash', 'del', function () { inst.removeEntry(id); ui.selectedId = null; recomputeDirty(inst); renderOverlays(); });
    // Place the toolbar in-flow just below the video frame so it never covers it.
    if (ui.dock && ui.dock.parentNode) ui.dock.parentNode.insertBefore(bar, ui.dock);
    else ui.frame.appendChild(bar);
  }

  // ---- trays (toggle open/close) ------------------------------------------
  // While a tool is open, collapse the toolbar to show ONLY that tool (the
  // others disappear); the tool's tray carries its own Cancel/Save to return.
  // While a tool is open the whole toolbar disappears (the user is "inside" the
  // tool); each tray brings itself back, and Trim closes on a backdrop tap/Esc.
  function collapseMenu(tool) {
    if (ui.dock) ui.dock.classList.add('hidden-dock');
  }
  function expandMenu() {
    if (ui.dock) ui.dock.classList.remove('hidden-dock');
    Array.prototype.forEach.call(ui.modal.querySelectorAll('.sdui-tool'), function (b) {
      b.classList.remove('active'); b.classList.remove('hidden');
    });
  }

  function toggleTool(tool, arg) {
    if (!ui) return;
    if (ui.openTool === tool && !arg) { closeTray(); return; }
    ui.openTool = tool;
    collapseMenu(tool);
    var tray = ui.tray; tray.innerHTML = '';
    if (tool === 'trim') { openTrim(); }
    else {
      hideTrimBar();
      var head = el('div', 'sdui-tray-head');
      head.appendChild(el('span', null, { text: 'Text', music: 'Music', sticker: 'Stickers' }[tool] || tool));
      var c = el('button', 'sdui-trayclose'); c.appendChild(el('i', 'bi bi-x-lg')); c.addEventListener('click', closeTray); head.appendChild(c);
      tray.appendChild(head);
      if (tool === 'text') buildTextSheet(tray, arg);
      else if (tool === 'sticker') buildStickerSheet(tray);
      else if (tool === 'music') buildMusicSheet(tray);
    }
    tray.classList.add('open');
  }

  function closeTray() {
    if (!ui) return;
    ui.openTool = null;
    destroyLottiesIn(ui.tray);
    ui.tray.classList.remove('open'); ui.tray.innerHTML = '';
    hideTrimBar();
    expandMenu();
  }

  function buildTextSheet(tray, editId) {
    var inst = activeInst();
    var editing = editId && typeof inst._findEntry === 'function' ? inst._findEntry(editId) : null;
    var cur = editing && editing.kind === 'text' ? editing.entry : null;

    function isValidText(t) { return typeof t === 'string' && t.length >= 1 && t.length <= 200; }
    function boxColorOf(c) { return (c || '#000000').slice(0, 7); }

    // Live working state. An existing overlay is edited in place (with a snapshot
    // so Cancel reverts); a new overlay is created on the first valid keystroke
    // for live on-screen preview and removed on Cancel.
    var liveId = cur ? cur.id : null;
    var createdHere = false;
    var selColor = cur ? cur.textColor : '#FFFFFF';
    var selFont = cur && cur.font ? cur.font : 'Roboto';
    var hadBg = cur && cur.bgColor && cur.bgColor !== '#00000000';
    var boxShape = cur ? (cur.boxShape || (hadBg ? 'rounded' : 'none')) : 'none';
    var selBg = hadBg ? boxColorOf(cur.bgColor) : '#000000';
    var snapshot = cur ? {
      text: cur.text, textColor: cur.textColor, bgColor: cur.bgColor, fontSize: cur.fontSize,
      font: cur.font, pos: { x: cur.pos.x, y: cur.pos.y }, rotation: cur.rotation, boxShape: cur.boxShape
    } : null;

    var input = el('textarea', 'sdui-input'); input.rows = 2; input.maxLength = 200;
    input.placeholder = 'Your text\u2026'; input.value = cur ? cur.text : '';
    tray.appendChild(input);

    // Text color swatches.
    var sw = el('div', 'sdui-swatches');
    TEXT_COLORS.forEach(function (col) {
      var s = el('button', 'sdui-sw' + (col === selColor ? ' sel' : '')); s.style.background = col;
      s.addEventListener('click', function () {
        selColor = col;
        Array.prototype.forEach.call(sw.children, function (q) { q.classList.remove('sel'); });
        s.classList.add('sel'); applyLive();
      });
      sw.appendChild(s);
    });
    var rc = el('div', 'sdui-row'); rc.appendChild(el('label', null, 'Color')); rc.appendChild(sw); tray.appendChild(rc);

    // Font picker — each chip is rendered in its own typeface.
    var fonts = el('div', 'sdui-fonts');
    FONTS.forEach(function (f) {
      var b = el('button', 'sdui-font' + (f.name === selFont ? ' sel' : ''), f.name);
      b.style.fontFamily = "'" + f.name + "', Inter, sans-serif";
      b.addEventListener('click', function () {
        selFont = f.name;
        Array.prototype.forEach.call(fonts.children, function (q) { q.classList.remove('sel'); });
        b.classList.add('sel'); applyLive();
      });
      fonts.appendChild(b);
    });
    var rf = el('div', 'sdui-row'); rf.appendChild(el('label', null, 'Font')); rf.appendChild(fonts); tray.appendChild(rf);

    // Background box style: None / Rounded / Square.
    var boxSeg = el('div', 'sdui-seg');
    [['none', 'None', 'bi-type'], ['rounded', 'Rounded', 'bi-app'], ['square', 'Square', 'bi-square']].forEach(function (p) {
      var b = el('button', boxShape === p[0] ? 'sel' : '');
      b.appendChild(el('i', 'bi ' + p[2])); b.appendChild(el('span', 'sdui-btn-lbl', p[1]));
      b.addEventListener('click', function () {
        boxShape = p[0];
        Array.prototype.forEach.call(boxSeg.children, function (q) { q.classList.remove('sel'); });
        b.classList.add('sel'); updateBoxColorRow(); applyLive();
      });
      boxSeg.appendChild(b);
    });
    var rbx = el('div', 'sdui-row'); rbx.appendChild(el('label', null, 'Box')); rbx.appendChild(boxSeg); tray.appendChild(rbx);

    // Box color swatches (hidden when box = none).
    var bsw = el('div', 'sdui-swatches');
    BOX_COLORS.forEach(function (col) {
      var s = el('button', 'sdui-sw' + (col === selBg ? ' sel' : '')); s.style.background = col;
      s.addEventListener('click', function () {
        selBg = col;
        Array.prototype.forEach.call(bsw.children, function (q) { q.classList.remove('sel'); });
        s.classList.add('sel'); applyLive();
      });
      bsw.appendChild(s);
    });
    var rbc = el('div', 'sdui-row'); rbc.appendChild(el('label', null, 'Box color')); rbc.appendChild(bsw); tray.appendChild(rbc);
    function updateBoxColorRow() { rbc.style.display = boxShape === 'none' ? 'none' : 'flex'; }
    updateBoxColorRow();

    // Size slider.
    var size = el('input', 'sdui-range'); size.type = 'range'; size.min = '8'; size.max = '200'; size.value = cur ? cur.fontSize : 64;
    size.addEventListener('input', applyLive);
    var rs = el('div', 'sdui-row'); rs.appendChild(el('label', null, 'Size')); rs.appendChild(size); tray.appendChild(rs);

    var err = el('div', 'sdui-err');
    input.addEventListener('input', applyLive);

    function curBg() { return boxShape === 'none' ? '#00000000' : selBg; }

    function applyLive() {
      var text = input.value;
      var changes = { text: text, textColor: selColor, font: selFont, fontSize: Number(size.value), bgColor: curBg() };
      if (liveId) {
        inst.updateTextOverlay(liveId, changes); // empty text is rejected; prior preview kept
      } else if (isValidText(text)) {
        changes.pos = { x: 0.5, y: 0.45 };
        var r2 = inst.addTextOverlay(changes);
        if (r2.ok) { liveId = r2.overlay.id; createdHere = true; ui.selectedId = liveId; err.textContent = ''; }
        else if (r2.error === 'max_overlays') { err.textContent = 'Maximum 20 text overlays.'; return; }
      }
      var f = liveId && inst._findEntry ? inst._findEntry(liveId) : null;
      if (f && f.entry) f.entry.boxShape = boxShape;
      renderOverlays();
    }

    var btn = btnWith('sdui-btn', 'bi-check-lg', cur ? 'Update' : 'Save');
    btn.addEventListener('click', function () {
      if (!isValidText(input.value)) { err.textContent = 'Text must be 1\u2013200 characters.'; return; }
      applyLive(); ui.selectedId = liveId; closeTray();
    });
    var cancel = btnWith('sdui-btn ghost', 'bi-x-lg', 'Cancel');
    cancel.addEventListener('click', function () {
      if (createdHere && liveId) { inst.removeEntry(liveId); ui.selectedId = null; }
      else if (snapshot && liveId) {
        inst.updateTextOverlay(liveId, {
          text: snapshot.text, textColor: snapshot.textColor, bgColor: snapshot.bgColor,
          fontSize: snapshot.fontSize, font: snapshot.font, pos: snapshot.pos, rotation: snapshot.rotation
        });
        var f = inst._findEntry(liveId); if (f && f.entry) f.entry.boxShape = snapshot.boxShape;
      }
      recomputeDirty(inst); renderOverlays(); closeTray();
    });
    var rb = el('div', 'sdui-row'); rb.appendChild(btn); rb.appendChild(cancel); tray.appendChild(rb);
    tray.appendChild(err);

    if (cur) renderOverlays();
    setTimeout(function () { try { input.focus(); } catch (_) {} }, 30);
  }

  function buildStickerSheet(tray) {
    var inst = activeInst();
    var current = 'normal';

    // Animated tab only when enabled (stage B); otherwise static stickers only.
    var TABS = [['normal', 'Stickers', 'bi-sticky']];
    if (ANIMATED_STICKERS) TABS.push(['animated', 'Animated', 'bi-stars']);

    var tabs = el('div', 'sdui-stkr-tabs');
    if (TABS.length > 1) {
      TABS.forEach(function (p) {
        var b = el('button', 'sdui-stkr-tab' + (p[0] === current ? ' sel' : '')); b.dataset.t = p[0];
        b.appendChild(el('i', 'bi ' + p[2])); b.appendChild(el('span', 'sdui-btn-lbl', p[1]));
        b.addEventListener('click', function () { setTab(p[0]); });
        tabs.appendChild(b);
      });
      tray.appendChild(tabs);
    }

    var gridWrap = el('div', 'sdui-stkr-gridwrap'); tray.appendChild(gridWrap);
    tray.appendChild(el('div', 'sdui-hint', 'Tap to add \u00b7 drag to move \u00b7 select to resize/rotate/delete.'));
    var sCancel = btnWith('sdui-btn ghost', 'bi-x-lg', 'Cancel'); sCancel.addEventListener('click', closeTray);
    var scr = el('div', 'sdui-row'); scr.appendChild(sCancel); tray.appendChild(scr);

    function setTab(t) {
      current = t;
      Array.prototype.forEach.call(tabs.children, function (b) { b.classList.toggle('sel', b.dataset.t === t); });
      renderGrid();
    }
    function addStickerByUrl(url) {
      var r = inst.addSticker({ assetRef: url, pos: { x: 0.5, y: 0.5 }, scale: 1, rotation: 0 });
      if (!r.ok) return;
      ui.selectedId = r.sticker.id; renderOverlays(); closeTray();
    }
    function renderGrid() {
      destroyLottiesIn(gridWrap);
      gridWrap.innerHTML = '';
      var list = (ui.stickerManifest && ui.stickerManifest[current]) || [];
      if (!list.length) { gridWrap.appendChild(el('div', 'sdui-hint', 'No stickers in this pack.')); return; }
      var grid = el('div', 'sdui-stkr-grid');
      list.forEach(function (url) {
        var b = el('button', 'sdui-stkr-cell');
        if (isTgs(url)) {
          var holder = el('div', 'sdui-stkr-lottie'); b.appendChild(holder);
          renderLottieInto(holder, url, { loop: true, autoplay: true });
        } else {
          var img = el('img', 'sdui-stkr-thumb'); img.loading = 'lazy'; img.src = url; img.alt = 'sticker'; img.draggable = false;
          b.appendChild(img);
        }
        b.addEventListener('click', function () { addStickerByUrl(url); });
        grid.appendChild(b);
      });
      gridWrap.appendChild(grid);
    }

    if (ui.stickerManifest) { renderGrid(); }
    else {
      gridWrap.appendChild(el('div', 'sdui-hint', 'Loading stickers\u2026'));
      fetch('/stickers/manifest.json').then(function (r) { return r.json(); }).then(function (m) {
        ui.stickerManifest = m; renderGrid();
      }).catch(function () { gridWrap.innerHTML = ''; gridWrap.appendChild(el('div', 'sdui-hint', 'Could not load stickers.')); });
    }
  }

  function buildMusicSheet(tray) {
    var inst = activeInst(); var Audio = A();
    if (!Audio) { tray.appendChild(el('div', 'sdui-hint', 'Audio module unavailable.')); return; }

    var muteRow = el('div', 'sdui-row');
    var mute = el('input'); mute.type = 'checkbox'; mute.checked = Audio.isMuted(inst);
    mute.addEventListener('change', function () { Audio.setMuted(inst, mute.checked); applyOriginalAudio(); });
    var ml = el('label'); ml.appendChild(mute); ml.appendChild(document.createTextNode(' Mute original'));
    muteRow.appendChild(ml);
    var ov = el('input', 'sdui-range'); ov.type = 'range'; ov.min = '0'; ov.max = '100'; ov.value = Audio.getOriginalVolume(inst);
    ov.title = 'Original volume';
    ov.addEventListener('input', function () { Audio.setOriginalVolume(inst, Number(ov.value)); applyOriginalAudio(); });
    muteRow.appendChild(ov);
    tray.appendChild(muteRow);

    // ---- Upload your own audio --------------------------------------------
    var upRow = el('div', 'sdui-row');
    var upBtn = btnWith('sdui-btn', 'bi-upload', 'Upload audio');
    var fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'audio/*'; fileInput.style.display = 'none';
    upBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (f) handleAudioUpload(f);
      fileInput.value = '';
    });
    upRow.appendChild(upBtn); upRow.appendChild(fileInput);
    tray.appendChild(upRow);
    var upHint = el('div', 'sdui-hint', ''); tray.appendChild(upHint);

    var ctrl = el('div'); tray.appendChild(ctrl);

    function renderMusicControls() {
      ctrl.innerHTML = '';
      var m = Audio.getMusic(inst); if (!m) return;

      // Waveform clip picker — drag the window to choose the best part.
      var dur = ui.trackDuration[m.assetRef] || 0;
      if (dur > 0) {
        ctrl.appendChild(el('div', 'sdui-hint', 'Pick your clip \u00b7 drag the highlighted window'));
        var waveWrap = el('div', 'sdui-wavewrap'); ctrl.appendChild(waveWrap);
        renderWaveformPicker(waveWrap, ui.wavePeaks[m.assetRef], dur);
      }

      var mvRow = el('div', 'sdui-row'); mvRow.appendChild(el('label', null, 'Music vol'));
      var mv = el('input', 'sdui-range'); mv.type = 'range'; mv.min = '0'; mv.max = '100'; mv.value = m.volume;
      mv.addEventListener('input', function () { Audio.setMusicVolume(inst, Number(mv.value)); applyMusicAudio(); });
      mvRow.appendChild(mv); ctrl.appendChild(mvRow);
      var seg = el('div', 'sdui-seg');
      [['loop', 'Loop', 'bi-arrow-repeat'], ['once', 'Play once', 'bi-1-circle']].forEach(function (p) {
        var b = el('button', m.loopMode === p[0] ? 'sel' : '');
        b.appendChild(el('i', 'bi ' + p[2]));
        b.appendChild(el('span', 'sdui-btn-lbl', p[1]));
        b.addEventListener('click', function () { Audio.setLoopMode(inst, p[0]); applyMusicAudio(); renderMusicControls(); });
        seg.appendChild(b);
      });
      var segRow = el('div', 'sdui-row'); segRow.appendChild(el('label', null, 'Shorter')); segRow.appendChild(seg); ctrl.appendChild(segRow);
      var rm = btnWith('sdui-btn ghost', 'bi-trash', 'Remove music');
      rm.addEventListener('click', function () { Audio.removeMusicTrack(inst); pauseMusic(); applyMusicAudio(); recomputeDirty(inst); renderMusicControls(); });
      var rr = el('div', 'sdui-row'); rr.appendChild(rm); ctrl.appendChild(rr);
    }

    // Draggable Waveform_Window over a bar strip (Req 9.x). Dragging records the
    // audioStart through the tested Audio.setAudioStart clamp/quantize path.
    function renderWaveformPicker(container, peaks, duration) {
      container.innerHTML = '';
      peaks = (peaks && peaks.length) ? peaks : synthPeaks(64);
      var strip = el('div', 'sdui-wave');
      peaks.forEach(function (p) { var bar = el('div', 'sdui-wave-bar'); bar.style.height = (Math.max(6, p * 100)) + '%'; strip.appendChild(bar); });
      var win = el('div', 'sdui-wave-win'); strip.appendChild(win);
      container.appendChild(strip);

      var clip = inst.sourceDuration || (Audio.CLIP_DURATION_LIMIT || 29);
      var winLen = Audio.defaultWaveformWindow(clip, duration).length || Math.min(clip, duration);

      function layout() {
        var startPct = duration > 0 ? Math.max(0, Math.min(100, (Audio.getAudioStart(inst) / duration) * 100)) : 0;
        var widthPct = duration > 0 ? Math.max(6, Math.min(100, (winLen / duration) * 100)) : 100;
        win.style.left = startPct + '%'; win.style.width = widthPct + '%';
      }
      layout();

      var dragging = false;
      function setFromClientX(cx) {
        var r = strip.getBoundingClientRect();
        var frac = r.width > 0 ? (cx - r.left) / r.width : 0;
        var widthFrac = duration > 0 ? (winLen / duration) : 1;
        var offset = (frac - widthFrac / 2) * duration; // center window under the pointer
        var res = Audio.setAudioStart(inst, offset, duration, winLen);
        layout();
        if (ui.musicAudio && !ui.musicAudio.paused && res && res.ok) {
          try { ui.musicAudio.currentTime = res.audioStart || 0; } catch (_) {}
        }
      }
      win.addEventListener('pointerdown', function (e) { dragging = true; try { win.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); e.stopPropagation(); });
      win.addEventListener('pointermove', function (e) { if (dragging) setFromClientX(e.clientX); });
      function end() { dragging = false; }
      win.addEventListener('pointerup', end); win.addEventListener('pointercancel', end);
      strip.addEventListener('pointerdown', function (e) { if (e.target !== win) setFromClientX(e.clientX); });
    }

    function synthPeaks(n) { var a = []; for (var i = 0; i < n; i++) { a.push(0.28 + 0.6 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23))); } return a; }

    // Decode an uploaded audio file (ArrayBuffer) to its duration + bar peaks.
    function decodeAudio(buf) {
      return new Promise(function (resolve, reject) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { reject(new Error('no_audiocontext')); return; }
        var ctx = new AC();
        ctx.decodeAudioData(buf.slice(0), function (audioBuf) {
          var peaks = computePeaks(audioBuf, 80);
          var dur = audioBuf.duration;
          try { ctx.close(); } catch (_) {}
          resolve({ duration: dur, peaks: peaks });
        }, function (err) { try { ctx.close(); } catch (_) {} reject(err || new Error('decode_failed')); });
      });
    }
    function computePeaks(audioBuf, n) {
      var ch = audioBuf.getChannelData(0);
      var block = Math.floor(ch.length / n) || 1;
      var peaks = [], i, j;
      for (i = 0; i < n; i++) {
        var start = i * block, endIdx = Math.min(ch.length, start + block), max = 0;
        for (j = start; j < endIdx; j++) { var a = Math.abs(ch[j]); if (a > max) max = a; }
        peaks.push(max);
      }
      var mx = Math.max.apply(null, peaks) || 1;
      return peaks.map(function (p) { return Math.max(0.06, p / mx); });
    }

    function handleAudioUpload(file) {
      var maxBytes = 20 * 1024 * 1024;
      if (file.size > maxBytes) { upHint.textContent = 'Audio is too large (max 20 MB).'; return; }
      upHint.textContent = 'Reading audio\u2026';
      var reader = new FileReader();
      reader.onerror = function () { upHint.textContent = 'Could not read that file.'; };
      reader.onload = function () {
        decodeAudio(reader.result).then(function (res) {
          if (res.duration > 600) { upHint.textContent = 'Audio is too long (max 10 minutes).'; return; }
          var url; try { url = URL.createObjectURL(file); ui.objectUrls.push(url); } catch (_) { url = null; }
          var localId = 'upl_' + Date.now();
          if (url) ui.musicUrls[localId] = url;
          ui.wavePeaks[localId] = res.peaks;
          ui.trackDuration[localId] = res.duration;
          var clip = inst.sourceDuration || (Audio.CLIP_DURATION_LIMIT || 29);
          Audio.removeMusicTrack(inst);
          Audio.selectMusicTrack(inst, { assetRef: localId, source: Audio.MUSIC_SOURCES.UPLOAD, trackDuration: res.duration, volume: Audio.DEFAULT_MUSIC_VOLUME }, clip);
          applyMusicAudio();
          var av = ui.videos[ui.active]; if (av && !av.paused) startMusic();
          renderMusicControls();
          upHint.textContent = 'Added \u201c' + (file.name || 'audio') + '\u201d. Drag the window to pick your clip.';
          serverUpload(file, localId, url);
        }).catch(function () { upHint.textContent = 'Could not read that audio file (unsupported format?).'; });
      };
      reader.readAsArrayBuffer(file);
    }

    // Best-effort background upload so the recipe references the server asset
    // (so the rendered video can include the audio). Preview already works from
    // the local object URL regardless of whether this succeeds.
    function serverUpload(file, localId, url) {
      if (!Audio.performMusicUpload || !Audio.normalizeUploadDeps) return;
      var deps;
      try { deps = Audio.normalizeUploadDeps({}); } catch (_) { return; }
      Audio.performMusicUpload(file, deps).then(function (asset) {
        var m = inst.audio && inst.audio.music;
        if (m && m.assetRef === localId && asset && asset.assetId) {
          m.assetRef = asset.assetId;
          if (asset.key) m.key = asset.key;
          if (url) ui.musicUrls[asset.assetId] = url;
          ui.trackDuration[asset.assetId] = ui.trackDuration[localId];
          if (ui.wavePeaks[localId]) ui.wavePeaks[asset.assetId] = ui.wavePeaks[localId];
          if (typeof inst.markDirty === 'function') inst.markDirty();
        }
        upHint.textContent = 'Uploaded \u2713 ready to use.';
      }).catch(function () {
        upHint.textContent = 'Saved for preview \u00b7 server upload unavailable here.';
      });
    }

    var done = btnWith('sdui-btn', 'bi-check-lg', 'Done'); done.addEventListener('click', closeTray);
    var dr = el('div', 'sdui-row'); dr.appendChild(done); tray.appendChild(dr);

    renderMusicControls();
  }

  // ---- dynamic trim -------------------------------------------------------
  function openTrim() {
    var inst = activeInst(); var dur = inst.sourceDuration || 0; var tray = ui.tray;
    if (dur <= 0) { tray.appendChild(el('div', 'sdui-hint', 'Preview still loading\u2026')); return; }
    var cur = inst.getTrim();
    ui.trimPrev = cur ? { start: cur.start, end: cur.end } : null;
    var t = cur || { start: 0, end: dur };
    ui.trim = { start: t.start, end: t.end, dur: dur };

    // Minimal floating trim bar (no card) with the Play / Cancel / Save controls.
    tray.classList.add('bare');
    var wrap = el('div', 'sdui-trimwrap');
    buildTrimTrack(wrap);
    tray.appendChild(wrap);

    var times = el('div', 'sdui-trim-times'); times.id = 'sdui-trim-times';
    times.textContent = fmtTime(t.start) + ' \u2013 ' + fmtTime(t.end);
    tray.appendChild(times);

    // Floating glassmorphism action bar — icon-only, no labels, no borders.
    var bar = el('div', 'sdui-fab');

    function fabBtn(cls, iconClass, label, fn) {
      var b = el('button', 'sdui-fab-btn ' + cls);
      b.setAttribute('aria-label', label);
      b.appendChild(el('i', 'sdui-fab-ic bi ' + iconClass));
      b.appendChild(el('span', 'sdui-fab-lbl', label));
      b.addEventListener('click', fn);
      return b;
    }

    var cancelBtn = fabBtn('cancel', 'bi-x-lg', 'Cancel', function () {
      var i2 = activeInst();
      i2._trim = ui.trimPrev ? { start: ui.trimPrev.start, end: ui.trimPrev.end } : null;
      recomputeDirty(i2); closeTray();
    });

    var playBtnFab = fabBtn('play', 'bi-play-fill', 'Play', toggleTrimPlay);
    ui._playAct = {
      btn: playBtnFab,
      ic: playBtnFab.querySelector('.sdui-fab-ic'),
      label: playBtnFab.querySelector('.sdui-fab-lbl')
    };

    var saveBtn = fabBtn('save', 'bi-check-lg', 'Save', function () {
      activeInst().attemptTrim(ui.trim.start, ui.trim.end); closeTray();
    });

    bar.appendChild(cancelBtn);
    bar.appendChild(playBtnFab);
    bar.appendChild(saveBtn);
    tray.appendChild(bar);

    if (ui.playBtn) ui.playBtn.style.display = 'none';
    var v = ui.videos[ui.active];
    updatePlayhead(v ? v.currentTime : ui.trim.start);
    setPlayLabel(false);
  }

  function buildTrimTrack(container) {
    var track = el('div', 'sdui-trim-track');
    var maskL = el('div', 'sdui-trim-mask');
    var maskR = el('div', 'sdui-trim-mask');
    var sel = el('div', 'sdui-trim-sel');
    var lh = el('div', 'sdui-trim-h l'); var rh = el('div', 'sdui-trim-h r');
    track.appendChild(maskL); track.appendChild(maskR); track.appendChild(sel);
    track.appendChild(lh); track.appendChild(rh);
    container.appendChild(track);
    ui._trimEls = { track: track, sel: sel, lh: lh, rh: rh, maskL: maskL, maskR: maskR };
    layoutTrim();
    attachTrimHandle(lh, 'start'); attachTrimHandle(rh, 'end');
  }

  function layoutTrim() {
    if (!ui || !ui._trimEls || !ui.trim) return;
    var d = ui.trim.dur || 1;
    var sp = Math.max(0, Math.min(1, ui.trim.start / d)) * 100;
    var ep = Math.max(0, Math.min(1, ui.trim.end / d)) * 100;
    var e = ui._trimEls;
    e.sel.style.left = sp + '%'; e.sel.style.width = (ep - sp) + '%';
    e.lh.style.left = sp + '%'; e.rh.style.left = ep + '%';
    if (e.maskL) e.maskL.style.width = sp + '%';
    if (e.maskR) { e.maskR.style.left = ep + '%'; e.maskR.style.width = (100 - ep) + '%'; }
    var tt = document.getElementById('sdui-trim-times');
    if (tt) tt.textContent = fmtTime(ui.trim.start) + ' \u2013 ' + fmtTime(ui.trim.end);
  }
  function updatePlayhead(time) {
    // Playhead bar removed; no-op kept so existing callers don't throw.
  }
  function attachTrimHandle(h, which) {
    var dragging = false, pendingSeek = null, rafId = 0;
    function flushSeek() {
      rafId = 0;
      if (pendingSeek == null) return;
      var v = ui.videos[ui.active];
      if (v) { try { v.currentTime = pendingSeek; } catch (_) {} }
      pendingSeek = null;
    }
    h.addEventListener('pointerdown', function (e) {
      dragging = true; h.classList.add('grab');
      try { h.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault(); e.stopPropagation();
    });
    h.addEventListener('pointermove', function (e) {
      if (!dragging || !ui.trim) return;
      var r = ui._trimEls.track.getBoundingClientRect();
      var frac = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
      frac = Math.max(0, Math.min(1, frac));
      var time = frac * ui.trim.dur;
      if (which === 'start') {
        ui.trim.start = Math.max(0, Math.min(time, ui.trim.end - 0.1));
        pendingSeek = ui.trim.start;
      } else {
        ui.trim.end = Math.min(ui.trim.dur, Math.max(time, ui.trim.start + 0.1));
        pendingSeek = ui.trim.end;
      }
      layoutTrim(); // move the handle 1:1 with the finger (no CSS lag)
      activeInst().attemptTrim(ui.trim.start, ui.trim.end);
      // Coalesce video seeks to one per frame so the decoder doesn't stutter.
      if (!rafId) rafId = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(flushSeek);
    });
    function end() {
      dragging = false; h.classList.remove('grab');
      if (rafId && window.cancelAnimationFrame) { window.cancelAnimationFrame(rafId); }
      rafId = 0; flushSeek(); // final precise seek
    }
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  }
  // Playhead drag removed — handles now seek the video directly.
  function attachPlayheadDrag() {}

  function setPlayLabel(playing) {
    if (!ui || !ui._playAct) return;
    if (ui._playAct.ic) ui._playAct.ic.className = 'sdui-fab-ic bi ' + (playing ? 'bi-pause-fill' : 'bi-play-fill');
    if (ui._playAct.label) ui._playAct.label.textContent = playing ? 'Pause' : 'Play';
    if (ui._playAct.btn) ui._playAct.btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (ui._playAct.btn) ui._playAct.btn.classList.toggle('playing', playing);
  }

  // Play toggles play/pause; resumes from the current position (only snaps to
  // the trim start when the playhead is outside the trimmed region).
  function toggleTrimPlay() {
    var v = ui.videos[ui.active]; if (!v || !ui.trim) return;
    if (!v.paused) { v.pause(); pauseMusic(); freezeStickers(false); setPlayLabel(false); return; }
    if (v.currentTime < ui.trim.start || v.currentTime >= ui.trim.end - 0.02) {
      try { v.currentTime = ui.trim.start; } catch (_) {}
    }
    ensureTrimWatch(v);
    applyOriginalAudio();
    playVideo(v);
    startMusic();
    freezeStickers(true);
    setPlayLabel(true);
  }

  function ensureTrimWatch(v) {
    if (ui._trimWatch) return;
    ui._trimWatch = function () {
      if (!ui || !ui.trim) return;
      if (v.currentTime >= ui.trim.end) { v.pause(); pauseMusic(); freezeStickers(false); setPlayLabel(false); }
    };
    v.addEventListener('timeupdate', ui._trimWatch);
  }

  function hideTrimBar() {
    if (!ui) return;
    ui._trimEls = null; ui._playAct = null;
    if (ui.tray) ui.tray.classList.remove('bare');
    if (ui.playBtn) ui.playBtn.style.display = '';
    stopTrimPlayback();
  }
  function stopTrimPlayback() {
    if (!ui) return;
    var v = ui.videos[ui.active];
    if (v && ui._trimWatch) v.removeEventListener('timeupdate', ui._trimWatch);
    ui._trimWatch = null;
  }

  function fmtTime(s) { s = Math.max(0, Math.floor(Number(s) || 0)); var m = Math.floor(s / 60); var ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; }

  function injectStyles() {
    if (document.getElementById('sdui-styles')) return;
    // Load Bootstrap Icons (served from /vendor/bootstrap-icons) once.
    if (!document.getElementById('sdui-bi-css')) {
      var lnk = document.createElement('link');
      lnk.id = 'sdui-bi-css';
      lnk.rel = 'stylesheet';
      lnk.href = '/vendor/bootstrap-icons/bootstrap-icons.css';
      document.head.appendChild(lnk);
    }
    // Load editor text fonts (served from /vendor/fonts) once each.
    FONTS.forEach(function (f) {
      var id = 'sdui-font-' + f.dir;
      if (document.getElementById(id)) return;
      var fl = document.createElement('link');
      fl.id = id; fl.rel = 'stylesheet';
      fl.href = '/vendor/fonts/' + f.dir + '/latin.css';
      document.head.appendChild(fl);
    });
    // Load pako (gunzip .tgs) + lottie-web (render animated stickers) once.
    [['sdui-pako', '/vendor/pako/pako_inflate.min.js'], ['sdui-lottie', '/vendor/lottie/lottie.min.js']].forEach(function (p) {
      if (document.getElementById(p[0])) return;
      var sc = document.createElement('script');
      sc.id = p[0]; sc.src = p[1]; sc.async = false;
      document.head.appendChild(sc);
    });
    // Design tokens via CSS variables (design-system-scaffold dark theme).
    var tokenBlock = ':root{--sdui-bg:#0a0a0a;--sdui-surface:#171717;--sdui-surface2:#1c1c1f;--sdui-surface3:#262626;--sdui-border:rgba(255,255,255,0.08);--sdui-border-hi:rgba(255,255,255,0.14);--sdui-fg:#fafafa;--sdui-muted:#a3a3a3;--sdui-muted2:rgba(255,255,255,0.4);--sdui-r:0.625rem;--sdui-rl:1rem;--sdui-rx:1.25rem;--sdui-pill:50px;--sdui-sh-sm:0 2px 8px rgba(0,0,0,0.35);--sdui-sh-md:0 8px 24px rgba(0,0,0,0.5);--sdui-sh-lg:0 20px 60px rgba(0,0,0,0.65);--sdui-blur:blur(20px);--sdui-fast:150ms cubic-bezier(0.4,0,0.2,1);--sdui-spring:320ms cubic-bezier(0.22,1,0.36,1);}';
    var css = [
      tokenBlock,
      '.sdui-modal{position:fixed;inset:0;z-index:99999;background:var(--sdui-bg);display:flex;justify-content:center;color:var(--sdui-fg);font-family:Inter,ui-sans-serif,system-ui,sans-serif;-webkit-tap-highlight-color:transparent;font-size:14px;line-height:1.5}',
      '.sdui-shell{width:100%;max-width:440px;height:100%;display:flex;flex-direction:column}',
      '.sdui-top{display:flex;align-items:center;gap:8px;padding:12px 16px 8px;flex:0 0 auto}',
      '.sdui-tabs{display:flex;gap:5px;overflow-x:auto;flex:1;justify-content:center;scrollbar-width:none}',
      '.sdui-tabs::-webkit-scrollbar{display:none}',
      '.sdui-tab{background:var(--sdui-surface3);border:1px solid var(--sdui-border);color:var(--sdui-muted);padding:5px 14px;border-radius:var(--sdui-pill);font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background var(--sdui-fast),color var(--sdui-fast)}',
      '.sdui-tab.active{background:var(--sdui-fg);color:var(--sdui-bg);font-weight:600;border-color:transparent}',
      '.sdui-tab:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-x{background:var(--sdui-surface3);border:1px solid var(--sdui-border);color:var(--sdui-muted);width:32px;height:32px;border-radius:50%;font-size:15px;cursor:pointer;flex:0 0 auto;display:flex;align-items:center;justify-content:center;transition:background var(--sdui-fast),color var(--sdui-fast)}',
      '.sdui-x:hover{background:var(--sdui-surface2);color:var(--sdui-fg)}',
      '.sdui-x:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-stage{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:14px;overflow-y:auto;padding:0 12px 20px;scrollbar-width:none}',
      '.sdui-stage::-webkit-scrollbar{display:none}',
      '.sdui-frame{position:relative;height:56vh;aspect-ratio:9/16;max-width:92vw;background:#000;border-radius:24px;overflow:hidden;box-shadow:var(--sdui-sh-lg);flex:0 0 auto;border:1px solid var(--sdui-border)}',
      '.sdui-frame video{width:100%;height:100%;object-fit:cover;background:#000;display:block}',
      '.sdui-layer{position:absolute;inset:0;overflow:hidden}',
      '.sdui-ov{position:absolute;cursor:grab;touch-action:none;user-select:none;will-change:left,top,transform}',
      '.sdui-ov.sel{outline:none}',
      '.sdui-ov-text{padding:4px 10px;border-radius:8px;font-weight:700;line-height:1.15;white-space:pre-wrap;text-align:center}',
      '.sdui-ov-sticker{line-height:0}',
      '.sdui-sticker-img{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;-webkit-user-select:none;user-select:none}',
      '.sdui-ov-sticker svg{width:100%!important;height:100%!important}',
      '.sdui-stkr-tabs{display:flex;gap:6px;margin-bottom:10px}',
      '.sdui-stkr-tab{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--sdui-surface3);border:1px solid var(--sdui-border);color:var(--sdui-muted);border-radius:var(--sdui-pill);padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;transition:background var(--sdui-fast),color var(--sdui-fast)}',
      '.sdui-stkr-tab .bi{font-size:14px;line-height:1}',
      '.sdui-stkr-tab.sel{background:rgba(99,102,241,0.18);border-color:rgba(99,102,241,0.5);color:var(--sdui-fg)}',
      '.sdui-stkr-tab:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-stkr-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}',
      '@media(max-width:480px){.sdui-stkr-grid{grid-template-columns:repeat(4,1fr)}}',
      '.sdui-stkr-cell{aspect-ratio:1/1;background:var(--sdui-surface3);border:1px solid var(--sdui-border);border-radius:var(--sdui-r);padding:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;transition:background var(--sdui-fast),transform var(--sdui-fast)}',
      '.sdui-stkr-cell:hover{background:var(--sdui-surface2)}',
      '.sdui-stkr-cell:active{transform:scale(0.9)}',
      '.sdui-stkr-thumb{width:100%;height:100%;object-fit:contain;display:block;pointer-events:none}',
      '.sdui-stkr-lottie{width:100%;height:100%}',
      '.sdui-testbtn{color:#86efac}',
      '.sdui-render{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.7);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:16px;animation:sduiRise var(--sdui-fast)}',
      '.sdui-render-card{width:100%;max-width:420px;background:var(--sdui-surface);border:1px solid var(--sdui-border-hi);border-radius:var(--sdui-rx);padding:14px 16px;box-shadow:var(--sdui-sh-lg);max-height:90vh;overflow-y:auto;scrollbar-width:none}',
      '.sdui-render-card::-webkit-scrollbar{display:none}',
      '.sdui-render-vid{width:100%;border-radius:var(--sdui-rl);background:#000;display:block;margin:4px 0 10px;max-height:62vh}',
      '.sdui-spin{width:34px;height:34px;border-radius:50%;border:3px solid var(--sdui-surface3);border-top-color:var(--sdui-fg);margin:16px auto;animation:sduiSpin 0.8s linear infinite}',
      '@keyframes sduiSpin{to{transform:rotate(360deg)}}',
      '.sdui-play{position:absolute;right:12px;top:12px;width:46px;height:46px;border-radius:50%;background:rgba(99,102,241,0.92);border:1.5px solid rgba(255,255,255,0.25);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:var(--sdui-blur);backdrop-filter:var(--sdui-blur);transition:transform var(--sdui-fast),background var(--sdui-fast);box-shadow:var(--sdui-sh-md);z-index:6}',
      '.sdui-play:hover{background:rgba(241, 99, 170, 1)}',
      '.sdui-play:active{transform:scale(0.9)}',
      '.sdui-play:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-selbar{align-self:center;display:flex;gap:5px;background:rgba(10,10,10,0.82);border:1px solid var(--sdui-border-hi);-webkit-backdrop-filter:var(--sdui-blur);backdrop-filter:var(--sdui-blur);padding:6px;border-radius:var(--sdui-pill);z-index:8;flex:0 0 auto;animation:sduiRise var(--sdui-spring)}',
      '.sdui-selbar button{background:var(--sdui-surface3);border:none;color:var(--sdui-fg);width:34px;height:34px;border-radius:50%;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background var(--sdui-fast),transform var(--sdui-fast)}',
      '.sdui-selbar button:active{transform:scale(0.88)}',
      '.sdui-selbar button.del{background:rgba(239,68,68,0.2);color:#fca5a5}',
      '.sdui-selbar button:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:1px}',
      '.sdui-trim{position:absolute;left:14px;right:14px;bottom:14px;display:none;z-index:7}',
      '.sdui-trim.open{display:block}',
      '.sdui-trim-track{position:relative;width:100%;height:60px;background:rgba(10,10,10,0.5);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1.5px solid rgba(255,255,255,0.2);border-radius:16px;box-shadow:var(--sdui-sh-md);touch-action:none}',
      '.sdui-trim-mask{position:absolute;top:0;bottom:0;background:rgba(0,0,0,0.45);z-index:0;border-radius:14px}',
      '.sdui-trim-sel{position:absolute;top:0;bottom:0;border:2px solid rgba(255,255,255,0.9);border-radius:14px;box-sizing:border-box;background:rgba(255,255,255,0.05);z-index:1}',
      '.sdui-trim-h{position:absolute;top:0;bottom:0;width:56px;margin-left:-28px;background:transparent;cursor:ew-resize;touch-action:none;z-index:4}',
      '.sdui-trim-h::before{content:"";position:absolute;top:6px;bottom:6px;left:50%;width:10px;transform:translateX(-50%);background:#fff;border-radius:7px;box-shadow:0 2px 12px rgba(0,0,0,0.55);transition:width .12s ease,background .12s ease}',
      '.sdui-trim-h::after{content:"";position:absolute;top:50%;left:50%;width:3px;height:34%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.28);border-radius:2px}',
      '.sdui-trim-h.grab::before{width:14px;background:#eaf2ff}',
      '.sdui-trim-play{display:none}',
      '.sdui-dock{display:flex;align-items:center;justify-content:center;gap:10px;flex:0 0 auto;animation:sduiRise var(--sdui-spring)}',
      '.sdui-dock.hidden-dock{display:none}',
      '.sdui-pill{display:flex;gap:3px;background:rgba(10,10,10,0.82);-webkit-backdrop-filter:var(--sdui-blur);backdrop-filter:var(--sdui-blur);border-radius:var(--sdui-pill);padding:6px 8px;border:1px solid var(--sdui-border-hi);box-shadow:var(--sdui-sh-sm),inset 0 0.5px 0 rgba(255,255,255,0.1)}',
      '.sdui-tool{display:flex;flex-direction:column;align-items:center;gap:3px;background:transparent;border:none;color:var(--sdui-muted);padding:8px 13px;border-radius:22px;cursor:pointer;font-size:10px;font-weight:500;min-width:52px;letter-spacing:0.01em;transition:background var(--sdui-fast),color var(--sdui-fast);-webkit-tap-highlight-color:transparent}',
      '.sdui-tool .ic{font-size:18px;line-height:1}',
      '.sdui-tool:hover{color:var(--sdui-fg)}',
      '.sdui-tool.active{background:rgba(99,102,241,0.22);color:var(--sdui-fg)}',
      '.sdui-tool.hidden{display:none}',
      '.sdui-tool:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px;border-radius:22px}',
      '.sdui-act{border:none;border-radius:50%;width:46px;height:46px;font-size:18px;cursor:pointer;color:var(--sdui-fg);display:flex;align-items:center;justify-content:center;transition:transform var(--sdui-fast),filter var(--sdui-fast);box-shadow:var(--sdui-sh-sm)}',
      '.sdui-act:active{transform:scale(0.9)}',
      '.sdui-act:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-act.discard{background:rgba(255, 4, 4, 0.97);border:1.5px solid rgba(239,68,68,0.3);color:#fca5a5}',
      '.sdui-act.save{background:rgba(0, 255, 94, 0.84);border:1.5px solid rgba(34,197,94,0.3);color:#86efac}',
      '.sdui-dock.tool-open .sdui-act{display:none}',
      '.sdui-tray{display:none;width:100%;max-width:416px;background:var(--sdui-surface);border:1px solid var(--sdui-border-hi);border-radius:var(--sdui-rx);padding:14px 16px;max-height:32vh;overflow-y:auto;flex:0 0 auto;box-shadow:var(--sdui-sh-md);animation:sduiRise var(--sdui-spring);scrollbar-width:none;-ms-overflow-style:none}',
      '.sdui-tray::-webkit-scrollbar{display:none}',
      '.sdui-tray.open{display:block}',
      '.sdui-tray-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;letter-spacing:0.01em;margin-bottom:10px;color:var(--sdui-fg)}',
      '.sdui-trimwrap{padding:16px 24px 0;animation:sduiRise var(--sdui-spring)}',
      '@keyframes sduiRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
      '.sdui-tray.bare{background:transparent;border:none;box-shadow:none;padding:0;max-height:none;overflow:visible}',
      '.sdui-dock.hidden-dock{display:none}',
      '.sdui-trayclose{background:var(--sdui-surface3);border:1px solid var(--sdui-border);color:var(--sdui-muted);width:26px;height:26px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;transition:background var(--sdui-fast),color var(--sdui-fast)}',
      '.sdui-trayclose:hover{background:var(--sdui-surface2);color:var(--sdui-fg)}',
      '.sdui-row{display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap}',
      '.sdui-row label{font-size:12px;color:var(--sdui-muted);min-width:64px;font-weight:500}',
      '.sdui-input{width:100%;box-sizing:border-box;background:var(--sdui-surface3);border:1px solid var(--sdui-border-hi);color:var(--sdui-fg);border-radius:var(--sdui-rl);padding:9px 12px;font-size:14px;font-family:inherit;outline:none;transition:border-color var(--sdui-fast)}',
      '.sdui-input:focus{border-color:rgba(255,255,255,0.35)}',
      '.sdui-btn{background:var(--sdui-fg);border:none;color:var(--sdui-bg);border-radius:var(--sdui-r);padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity var(--sdui-fast),transform var(--sdui-fast);letter-spacing:0.01em;display:inline-flex;align-items:center;justify-content:center;gap:6px}',
      '.sdui-btn .bi{font-size:14px;line-height:1}',
      '.sdui-btn:active{transform:scale(0.97);opacity:0.85}',
      '.sdui-btn.ghost{background:var(--sdui-surface3);color:var(--sdui-muted);border:1px solid var(--sdui-border)}',
      '.sdui-btn:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-swatches{display:flex;gap:7px;flex-wrap:wrap}',
      '.sdui-fonts{display:flex;gap:6px;flex:1;min-width:0;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}',
      '.sdui-fonts::-webkit-scrollbar{display:none}',
      '.sdui-font{flex:0 0 auto;background:var(--sdui-surface3);border:1px solid var(--sdui-border);color:var(--sdui-fg);border-radius:var(--sdui-r);padding:6px 13px;font-size:16px;line-height:1.1;cursor:pointer;white-space:nowrap;transition:background var(--sdui-fast),border-color var(--sdui-fast)}',
      '.sdui-font.sel{background:rgba(99,102,241,0.18);border-color:rgba(99,102,241,0.5)}',
      '.sdui-font:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-sw{width:26px;height:26px;border-radius:50%;border:2px solid transparent;cursor:pointer;transition:transform var(--sdui-fast),border-color var(--sdui-fast)}',
      '.sdui-sw.sel{border-color:rgba(255,255,255,0.85);transform:scale(1.15)}',
      '.sdui-sw:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px;border-radius:50%}',
      '.sdui-emoji-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:5px}',
      '@media(max-width:480px){.sdui-emoji-grid{grid-template-columns:repeat(6,1fr)}}',
      '.sdui-emoji{font-size:24px;background:var(--sdui-surface3);border:none;border-radius:var(--sdui-r);padding:7px 0;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background var(--sdui-fast),transform var(--sdui-fast)}',
      '.sdui-emoji:active{transform:scale(0.88)}',
      '.sdui-emoji:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-tracks{display:flex;flex-direction:column;gap:4px;margin:6px 0}',
      '.sdui-wavewrap{margin:6px 0 8px}',
      '.sdui-wave{position:relative;display:flex;align-items:center;gap:2px;height:52px;background:rgba(255,255,255,0.04);border:1px solid var(--sdui-border);border-radius:12px;padding:0 8px;overflow:hidden;touch-action:none;cursor:pointer}',
      '.sdui-wave-bar{flex:1;min-width:2px;background:rgba(255,255,255,0.32);border-radius:2px}',
      '.sdui-wave-win{position:absolute;top:0;bottom:0;background:rgba(99,102,241,0.22);border:2px solid rgba(99,102,241,0.95);border-radius:12px;cursor:grab;box-sizing:border-box;touch-action:none;box-shadow:0 2px 10px rgba(0,0,0,0.35)}',
      '.sdui-wave-win:active{cursor:grabbing}',
      '.sdui-track{display:flex;justify-content:space-between;align-items:center;gap:8px;background:var(--sdui-surface3);border:1px solid var(--sdui-border);border-radius:var(--sdui-r);padding:10px 12px;cursor:pointer;font-size:13px;text-align:left;width:100%;color:var(--sdui-fg);transition:background var(--sdui-fast),border-color var(--sdui-fast)}',
      '.sdui-track:hover{background:var(--sdui-surface2);border-color:var(--sdui-border-hi)}',
      '.sdui-track-title{display:inline-flex;align-items:center;gap:8px}',
      '.sdui-track-title .bi{font-size:14px;color:var(--sdui-muted);line-height:1}',
      '.sdui-track.sel{background:rgba(99,102,241,0.15);border-color:rgba(99,102,241,0.4)}',
      '.sdui-track-dur{color:var(--sdui-muted);font-size:12px;font-variant-numeric:tabular-nums}',
      '.sdui-range{flex:1;min-width:110px;accent-color:var(--sdui-fg)}',
      '.sdui-err{color:#fca5a5;font-size:12px;margin-top:4px;min-height:14px;font-weight:500}',
      '.sdui-hint{color:var(--sdui-muted);font-size:12px;margin-top:6px;line-height:1.5}',
      '.sdui-seg{display:flex;background:var(--sdui-surface3);border-radius:var(--sdui-r);overflow:hidden;flex:1;min-width:150px}',
      '.sdui-seg button{flex:1;background:transparent;border:none;color:var(--sdui-muted);padding:7px 10px;font-size:12px;font-weight:500;cursor:pointer;transition:background var(--sdui-fast),color var(--sdui-fast);display:inline-flex;align-items:center;justify-content:center;gap:5px}',
      '.sdui-seg button .bi{font-size:13px;line-height:1}',
      '.sdui-seg button.sel{background:rgba(255,255,255,0.12);color:var(--sdui-fg)}',
      '.sdui-seg button:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:-2px}',
      '.sdui-trim-times{text-align:center;color:var(--sdui-muted2);font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:0.05em;margin:12px 0 14px}',
      '.sdui-fab{display:flex;align-items:center;justify-content:center;gap:16px;background:rgba(10,10,10,0.80);-webkit-backdrop-filter:var(--sdui-blur);backdrop-filter:var(--sdui-blur);border-radius:var(--sdui-pill);padding:10px 26px;margin:0 auto;box-shadow:var(--sdui-sh-md),inset 0 0.5px 0 rgba(255,255,255,0.1);border:1px solid var(--sdui-border-hi);width:fit-content;animation:sduiRise var(--sdui-spring)}',
      '.sdui-fab-btn{width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-size:18px;color:var(--sdui-fg);background:rgba(255,255,255,0.10);transition:transform var(--sdui-fast),background var(--sdui-fast);-webkit-tap-highlight-color:transparent;box-shadow:inset 0 0.5px 0 rgba(255,255,255,0.15)}',
      '.sdui-fab-ic{font-size:18px;line-height:1;display:block}',
      '.sdui-fab-lbl{font-size:10px;font-weight:500;letter-spacing:0.02em;color:rgba(255,255,255,0.7);line-height:1}',
      '.sdui-fab-btn:active{transform:scale(0.88);background:rgba(255,255,255,0.18)}',
      '.sdui-fab-btn:focus-visible{outline:2px solid var(--sdui-fg);outline-offset:2px}',
      '.sdui-fab-btn.cancel{background:rgba(255, 0, 0, 1)}',
      '.sdui-fab-btn.save{background:rgba(0, 255, 94, 0.85)}'
    ].join('\n');
    var st = el('style'); st.id = 'sdui-styles'; st.textContent = css;
    document.head.appendChild(st);
  }

  window.StatusDropEditorUI = { open: open, reset: teardown, close: save };
})();
