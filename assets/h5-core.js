/* ============================================================
   拾光咖啡 H5 · 背景音乐模块
   ------------------------------------------------------------
   - 优先 Web Audio API: AudioBufferSourceNode.loop 可做到采样级无缝循环
   - 降级 <audio loop>: 不支持 Web Audio 时使用
   - 自动播放: 浏览器策略要求用户手势, 因此先尝试, 失败则挂一次性手势监听
   - 微信: 监听 WeixinJSBridgeReady
   - 跨页记忆: localStorage, 从首页切到领券页会继续播放
   - 暴露 window.H5BGM 供页面调用
   ============================================================ */
(function () {
  'use strict';

  var SRC = 'assets/bgm-cafe.mp3';
  var PREF_KEY = 'shiguang_bgm_on';
  var VOLUME = 0.42;          // 背景音乐不喧宾夺主
  var FADE_MS = 1100;

  var stage = document.getElementById('page') || document.body;
  // 页面可用 [data-bgm-slot] 指定音乐按钮停靠位置(如首页导航右上角);
  // 未指定则保持默认: 固定在舞台右下角。
  var slot = document.querySelector('[data-bgm-slot]');
  var inlineMode = !!slot;
  var btn, tip;
  var audioEl = null;         // <audio> 降级通道
  var actx = null, gainNode = null, srcNode = null, buffer = null;
  var playing = false;
  var wantOn = readPref();
  var gestureArmed = false;

  /* ---------------- 偏好记忆 ---------------- */
  function readPref() {
    try {
      var v = localStorage.getItem(PREF_KEY);
      return v === null ? true : v === '1';   // 默认希望播放
    } catch (e) { return true; }
  }
  function writePref(on) {
    try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch (e) {}
  }

  /* ---------------- 界面 ---------------- */
  var ICON_ON =
    '<svg class="h5-bgm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  var ICON_OFF =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' +
    '<path d="M2 2l20 20"/></svg>';

  function buildUI() {
    btn = document.createElement('button');
    btn.className = 'h5-bgm';
    btn.type = 'button';
    btn.setAttribute('aria-label', '背景音乐开关');
    btn.innerHTML = ICON_OFF;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggle();
    });
    if (inlineMode) {
      btn.classList.add('inline');
      slot.appendChild(btn);
    } else {
      document.body.appendChild(btn);
    }

    tip = document.createElement('div');
    tip.className = 'h5-bgm-tip';
    tip.textContent = '♪ 点击开启音乐';
    document.body.appendChild(tip);

    positionUI();
    syncStageMetrics();
    window.addEventListener('resize', onRelayout);
    window.addEventListener('orientationchange', function () {
      setTimeout(onRelayout, 260);
    });
    if (window.ResizeObserver) {
      try { new ResizeObserver(onRelayout).observe(stage); } catch (e) {}
    }
  }

  function onRelayout() {
    positionUI();
    syncStageMetrics();
  }

  /** 实测 sticky 导航高度写入 --h5-navh, 供 CSS 让首屏精确填满舞台剩余高度 */
  function syncStageMetrics() {
    if (!stage || !stage.style) return;
    var nav = stage.querySelector('.nav');
    var h = nav ? nav.getBoundingClientRect().height : 0;
    stage.style.setProperty('--h5-navh', (h > 0 ? Math.round(h) : 0) + 'px');
  }

  /** 默认固定在舞台右下角; 若页面提供了 [data-bgm-slot] 则停靠进该插槽, 位置交给 CSS */
  function positionUI() {
    if (!btn) return;

    if (inlineMode) {
      // 清掉固定定位的内联样式, 交还给 CSS 布局
      btn.style.left = ''; btn.style.top = '';
      btn.style.width = ''; btn.style.height = '';
      if (tip) {
        // 内联在右上角时, 气泡放到「导航栏正下方」并右对齐:
        // 用导航自身底边而非按钮底边, 否则会压住导航栏下沿的链接
        var br = btn.getBoundingClientRect();
        var navEl = stage.querySelector('.nav');
        var navBottom = navEl ? navEl.getBoundingClientRect().bottom : br.bottom;
        tip.style.left = Math.max(6, Math.round(br.right - tip.offsetWidth)) + 'px';
        tip.style.top = Math.round(Math.max(br.bottom, navBottom) + 6) + 'px';
      }
      return;
    }

    var r = stage.getBoundingClientRect();
    var size = 42, pad = 14, lift = 30;
    var narrow = r.width < 380;
    if (narrow) { size = 38; pad = 10; }

    var left = Math.round(r.right - pad - size);
    var top = Math.round(r.bottom - lift - size);

    btn.style.width = size + 'px';
    btn.style.height = size + 'px';
    btn.style.left = Math.max(4, left) + 'px';
    btn.style.top = Math.max(4, top) + 'px';

    if (tip) {
      tip.style.left = Math.max(4, left - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.round(top + size / 2 - 15) + 'px';
    }
  }

  function syncUI() {
    if (!btn) return;
    btn.classList.add('ready');
    btn.classList.toggle('playing', playing);
    btn.innerHTML = playing ? ICON_ON : ICON_OFF;
    if (playing) hideTip();
  }

  function showTip() {
    if (!tip || playing || !wantOn) return;
    positionUI();
    tip.classList.add('show');
    setTimeout(hideTip, 6000);
  }
  function hideTip() {
    if (tip) tip.classList.remove('show');
  }

  /* ---------------- Web Audio ---------------- */
  function ensureCtx() {
    if (actx) return actx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      actx = new AC();
      gainNode = actx.createGain();
      gainNode.gain.value = 0;
      gainNode.connect(actx.destination);
    } catch (e) {
      actx = null;
      return null;
    }
    return actx;
  }

  function loadBuffer(ctx) {
    return fetch(SRC)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (ab) {
        return new Promise(function (res, rej) {
          ctx.decodeAudioData(ab, res, rej);
        });
      });
  }

  function fadeTo(ctx, target) {
    var now = ctx.currentTime;
    var t = Math.max(0.02, FADE_MS / 1000);
    try {
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(gainNode.gain.value, now);
      gainNode.gain.linearRampToValueAtTime(target, now + t);
    } catch (e) {
      gainNode.gain.value = target;
    }
  }

  function startWebAudio() {
    var ctx = ensureCtx();
    if (!ctx) return Promise.reject(new Error('no webaudio'));

    var resume = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();

    return resume.then(function () {
      var p = buffer ? Promise.resolve(buffer) : loadBuffer(ctx).then(function (b) { buffer = b; return b; });
      return p.then(function (buf) {
        if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode = null; }
        srcNode = ctx.createBufferSource();
        srcNode.buffer = buf;
        srcNode.loop = true;                 // 采样级无缝循环
        srcNode.loopStart = 0;
        srcNode.loopEnd = buf.duration;
        srcNode.connect(gainNode);
        srcNode.start(0);
        fadeTo(ctx, VOLUME);
      });
    });
  }

  /* ---------------- <audio> 降级 ---------------- */
  function startElement() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.src = SRC;
      audioEl.loop = true;
      audioEl.preload = 'auto';
      audioEl.volume = 0;
    }
    return audioEl.play().then(function () {
      // 线性淡入
      var steps = 24, i = 0;
      var timer = setInterval(function () {
        i++;
        audioEl.volume = Math.min(VOLUME, (VOLUME * i) / steps);
        if (i >= steps) clearInterval(timer);
      }, FADE_MS / steps);
    });
  }

  /* ---------------- 播放控制 ---------------- */
  function play() {
    if (playing) return Promise.resolve();
    wantOn = true;
    writePref(true);

    return startWebAudio()
      .catch(function () { return startElement(); })
      .then(function () {
        playing = true;
        syncUI();
      })
      .catch(function () {
        // 自动播放被拦截
        showTip();
        armGesture();
      });
  }

  function pause() {
    wantOn = false;
    writePref(false);
    hideTip();

    if (actx && gainNode) {
      fadeTo(actx, 0);
      var node = srcNode;
      srcNode = null;
      setTimeout(function () {
        if (node) { try { node.stop(); } catch (e) {} }
      }, FADE_MS + 60);
    }
    if (audioEl) {
      var el = audioEl;
      var from = el.volume, steps = 20, i = 0;
      var timer = setInterval(function () {
        i++;
        el.volume = Math.max(0, from * (1 - i / steps));
        if (i >= steps) { clearInterval(timer); try { el.pause(); } catch (e) {} }
      }, FADE_MS / steps);
    }
    playing = false;
    syncUI();
  }

  function toggle() {
    if (playing) pause(); else play();
  }

  /* ---------------- 自动播放策略 ---------------- */
  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    var evts = ['touchstart', 'touchend', 'pointerdown', 'click', 'keydown'];
    function once() {
      evts.forEach(function (e) { document.removeEventListener(e, once, true); });
      gestureArmed = false;
      if (wantOn && !playing) play();
    }
    evts.forEach(function (e) { document.addEventListener(e, once, true); });
  }

  function boot() {
    buildUI();
    syncUI();

    // 微信内置浏览器: 需等 bridge 就绪才允许播放
    var isWX = /micromessenger/i.test(navigator.userAgent);
    if (isWX) {
      if (typeof window.WeixinJSBridge !== 'undefined') {
        if (wantOn) play();
      } else {
        document.addEventListener('WeixinJSBridgeReady', function () {
          if (wantOn) play(); else syncUI();
        }, false);
        // 兜底: bridge 迟迟不来时仍挂手势
        setTimeout(function () { if (!playing && wantOn) { showTip(); armGesture(); } }, 1200);
      }
    } else {
      if (wantOn) {
        play();
        // 首次尝试通常被拦截, 稍后给出提示
        setTimeout(function () { if (!playing && wantOn) showTip(); }, 700);
      } else {
        syncUI();
      }
    }

    // 页面隐藏时不打断(背景音乐应持续), 仅避免无谓调度
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && actx && actx.state === 'suspended' && playing) {
        actx.resume().catch(function () {});
      }
    });
  }

  // 对外接口
  window.H5BGM = {
    play: play,
    pause: pause,
    toggle: toggle,
    isPlaying: function () { return playing; },
    /** 供自动化测试/排查读取内部状态 */
    state: function () {
      return {
        playing: playing,
        wantOn: wantOn,
        mode: actx ? 'webaudio' : (audioEl ? 'element' : null),
        ctxState: actx ? actx.state : null,
        ctxTime: actx ? actx.currentTime : null,
        loop: srcNode ? srcNode.loop : (audioEl ? audioEl.loop : null),
        bufferDuration: buffer ? Math.round(buffer.duration * 100) / 100 : null,
        volume: gainNode ? Math.round(gainNode.gain.value * 1000) / 1000 : (audioEl ? audioEl.volume : null),
        elTime: audioEl ? Math.round(audioEl.currentTime * 100) / 100 : null
      };
    },
    src: SRC
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* ============================================================
   拾光咖啡 H5 · 翻页模块
   ------------------------------------------------------------
   架构: .h5-scroll 是唯一滚动容器, 每个 .screen 高度恒等于一屏,
        故「页数 === 屏数」, 不存在半屏或长页面。
   翻页本身由 CSS scroll-snap 原生完成(无 JS 也能用), 本模块只做增强:
     - 翻页指示器(右侧圆点, 当前页拉长高亮)
     - 第 1 屏「下滑」引导, 翻走即淡出
     - 深链接 #p3 直达第 3 屏; 翻页时同步 hash
     - 键盘 ↑↓ / PgUp PgDn(桌面预览用)
     - 手机横屏覆盖提示「请竖屏观看」
   暴露 window.H5Flip 供自动化验收读取内部状态
   ============================================================ */
(function () {
  'use strict';

  var stage = document.getElementById('page');
  if (!stage) return;
  var scroller = stage.querySelector('.h5-scroll');
  if (!scroller) return;

  var screens = Array.prototype.slice.call(scroller.querySelectorAll('.screen'));
  var N = screens.length;
  if (!N) return;

  var dotsBox = null, hint = null, current = 0, raf = 0, lockUntil = 0;

  /* ---------------- 指示器 ---------------- */
  function buildDots() {
    dotsBox = document.createElement('div');
    dotsBox.className = 'h5-dots' + (N < 2 ? ' single' : '');
    var frag = document.createDocumentFragment();
    for (var i = 0; i < N; i++) frag.appendChild(document.createElement('i'));
    dotsBox.appendChild(frag);
    stage.appendChild(dotsBox);
  }

  /* ---------------- 下滑引导(仅第 1 屏, 且必须不止一屏) ---------------- */
  function buildHint() {
    if (N < 2) return;                       // 单屏页面无处可翻, 不显示引导
    hint = document.createElement('div');
    hint.className = 'h5-hint';
    hint.innerHTML =
      '<span>下滑</span>' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6 9l6 6 6-6"/></svg>';
    screens[0].appendChild(hint);
  }

  /* ---------------- 横屏提示 ---------------- */
  function buildRotate() {
    var el = document.createElement('div');
    el.className = 'h5-rotate';
    el.innerHTML =
      '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18.5h2"/></svg>' +
      '<div>请将手机竖屏观看</div>';
    document.body.appendChild(el);
  }

  /* ---------------- 状态同步 ---------------- */
  // 每屏高度恒等于容器高度, 故当前页 = 四舍五入(已滚动 / 一屏高) —— 精确无误差
  function indexOfScroll() {
    var h = scroller.clientHeight || 1;
    var i = Math.round(scroller.scrollTop / h);
    return Math.max(0, Math.min(N - 1, i));
  }

  function paint() {
    if (dotsBox) {
      var kids = dotsBox.children;
      for (var i = 0; i < kids.length; i++) kids[i].className = (i === current ? 'on' : '');
    }
    if (hint) hint.classList.toggle('hide', current > 0);
    syncHash();
  }

  function syncHash() {
    var want = '#p' + (current + 1);
    if (location.hash === want) return;
    try { history.replaceState(null, '', want); } catch (e) { /* file:// 等场景忽略 */ }
  }

  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      var i = indexOfScroll();
      if (i !== current) { current = i; paint(); }
    });
  }

  /* ---------------- 跳页 ---------------- */
  function goTo(i, smooth) {
    i = Math.max(0, Math.min(N - 1, i));
    var top = screens[i].offsetTop;
    if (smooth === false) {
      scroller.scrollTop = top;
      current = i; paint();
    } else {
      lockUntil = Date.now() + 520;          // 平滑滚动期间忽略滚轮抢占
      scroller.scrollTo({ top: top, behavior: 'smooth' });
    }
  }

  function step(d) { goTo(current + d, true); }

  /* ---------------- 键盘(桌面) ---------------- */
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;   // 表单内不劫持
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
    else if (e.key === 'End') { e.preventDefault(); goTo(N - 1); }
  }

  /* ---------------- 滚轮: 一次手势只翻一页 ----------------
     桌面 Chrome 上 mandatory snap 遇到高频滚轮可能连翻多页,
     这里做节流: 一页翻完(或 520ms)之前忽略后续滚轮。 */
  function onWheel(e) {
    if (N < 2) return;
    if (Math.abs(e.deltaY) < 4) return;
    if (Date.now() < lockUntil) { e.preventDefault(); return; }
    e.preventDefault();
    step(e.deltaY > 0 ? 1 : -1);
  }

  /* ---------------- 内容自适应 (防止撑破 9:16) ----------------
     .screen 恒为一屏高且 overflow:hidden, 故 scrollHeight - clientHeight
     就是「内容超出这一屏多少像素」。小屏(如 320x568)上表单类页面容易超出,
     这里实测后逐级加压缩类 is-tight / is-tighter, 由各页 CSS 定义压缩力度。
     这样既保证「每屏恒为一个 9:16 页面」, 又不会真的把内容裁掉。 */
  function overflowOf(s) {
    return s.scrollHeight - s.clientHeight;
  }

  function fitScreens() {
    screens.forEach(function (s) {
      s.classList.remove('is-tight', 'is-tighter');
      if (overflowOf(s) <= 1) return;
      s.classList.add('is-tight');            // 触发强制重排, 下一行立即读到新高度
      if (overflowOf(s) <= 1) return;
      s.classList.add('is-tighter');
    });
  }

  /* ---------------- 初始化 ---------------- */
  function boot() {
    buildDots();
    buildHint();
    buildRotate();
    fitScreens();

    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', function () {
      var i = current;
      fitScreens();
      // 视口变化后屏高改变, 重新对齐到当前页(瞬时, 避免闪动)
      goTo(i, false);
    });

    // 深链接: #p3 -> 第 3 屏
    var m = /^#p(\d+)$/.exec(location.hash || '');
    if (m) {
      var want = Math.min(N - 1, Math.max(0, parseInt(m[1], 10) - 1));
      if (want > 0) goTo(want, false);
    } else {
      current = 0;
    }

    paint();
  }

  window.H5Flip = {
    count: function () { return N; },
    index: function () { return current; },
    goTo: goTo,
    next: function () { step(1); },
    prev: function () { step(-1); },
    /** 供验收脚本读取的完整状态 */
    state: function () {
      return {
        count: N,
        index: current,
        hash: location.hash,
        scrollTop: Math.round(scroller.scrollTop),
        clientH: scroller.clientHeight,
        stageH: Math.round(stage.getBoundingClientRect().height),
        dots: dotsBox ? dotsBox.children.length : 0,
        dotOn: dotsBox ? Array.prototype.findIndex.call(dotsBox.children, function (d) {
          return d.className === 'on';
        }) : -1,
        hintHidden: hint ? hint.classList.contains('hide') : null,
        screens: screens.map(function (s) {
          var r = s.getBoundingClientRect();
          return {
            h: Math.round(r.height),
            ratio: +(r.width / r.height).toFixed(4),
            overflow: s.scrollHeight - s.clientHeight,
          };
        }),
      };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
