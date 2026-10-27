/* ============================================================================
 *  video.js —— 视频 / 音频任务点驱动器
 *
 *  这是本项目自己的实现。它只依赖页面里已经存在的媒体元素和任务点标记：
 *    · 任务点容器从 DOM 关系里找，不假设固定的 iframe 层级；
 *    · 是否完成以任务点标记为准，而不是以 <video> 的 ended 为准；
 *    · 播放期间把 playbackRate 固定住，最后几秒回到 1x 补齐观看时长；
 *    · 本地放完但任务点没变绿时，从头重播，次数有上限。
 *
 *  这样写是为了让播放器升级、页面换版式时，坏掉的只是选择器，而不是
 *  整个流程；测试也可以只给 DOM 和假时钟，不需要真实浏览器。
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); }
  else { root.FreeTikuVideo = factory(root); }
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot
  : (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window), function (root) {
    'use strict';

    var WATCHDOG_SEC = 5;            // 多久检查一次「还在播吗 / 任务点绿了吗」
    var NOBOX_GIVEUP_SEC = 60;       // 一直找不到任务点容器时，最多等这么久
    var PAUSE_HINT_AT = 3;           // 连续几次发现暂停后提醒一次
    var ENDED_CONFIRM_SEC = 15;      // 本地播完后，等任务点变绿的宽限时间
    var MAX_REPLAY = 2;              // 任务点没绿时最多从头重播几次
    var RESTORE_LAST_SEC = 10;       // 最后 10 秒回到 1x
    var QUIZ_HIDE_SEC = 2;           // 视频弹题的扫描间隔
    var MAX_RATE = 16;               // 倍速上限
    var HARD_CAP_SEC = 45 * 60;      // 单节任务最长盯 45 分钟

    var state = {
      running: false,
      stopped: false,
      kind: '',
      rate: 1,
      replays: 0,
      done: false,
      why: '',
      startedAt: 0,
      promise: null,
      media: null,
      timers: [],
      observer: null,
      quizLogged: false,
      resolve: null
    };

    function noop() { }

    function className(el) {
      return ' ' + String((el && el.className) || '') + ' ';
    }

    function clampRate(v) {
      v = Number(v);
      if (!v || isNaN(v) || v <= 0) return 2;
      return Math.max(0.5, Math.min(MAX_RATE, v));
    }

    function findMedia(doc, kind) {
      try { return doc.documentElement.querySelector(kind); } catch (e) { return null; }
    }

    /* 播放器把倍速菜单删空，通常表示这一节不允许改速。 */
    function rateDisabled(doc) {
      try {
        return doc.querySelectorAll('.vjs-playback-rate .vjs-menu-content .vjs-menu-item').length === 0;
      } catch (e) {
        return false;
      }
    }

    /* 任务点容器可能叫 .ans-attach-ct，也可能只是带 .ans-job-icon 的普通框。 */
    function isTaskBox(el) {
      if (!el) return false;
      var c = className(el);
      if (/ans-attach-ct|ans-job-finished|ans-attach-online|icon_Completed/.test(c)) return true;
      if (/ans-attach|ans-job|task/i.test(c) && typeof el.querySelector === 'function') {
        try { return !!el.querySelector('.ans-job-icon'); } catch (e) { }
      }
      return false;
    }

    /* 先看媒体自己的祖先，再看当前框架 iframe 的父级链。
       媒体在播放器 iframe 里、任务点在外层时，第二种关系才是有效的。 */
    function mediaTaskBox(win, media) {
      win = win || root;

      var node = media;
      for (var depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        if (isTaskBox(node)) return node;
      }

      try {
        var frame = win.frameElement;
        if (frame && frame.parentElement) {
          var cur = frame.parentElement;
          for (var up = 0; cur && up < 10; up++, cur = cur.parentElement) {
            var ownerDoc = cur.ownerDocument;
            if (ownerDoc && cur === ownerDoc.body) break;
            if (isTaskBox(cur)) return cur;
          }
        }
      } catch (e) { /* 跨域读不到 frameElement 时，只能放弃这一种关系 */ }

      return null;
    }

    /* 把 playbackRate 换成一个只读属性。页面自己的播放器仍会尝试写它，
       但写入会被忽略；unlockRate 再把这层属性删掉，交还给原生实现。 */
    function lockRate(media, rate) {
      try { delete media.playbackRate; } catch (e) { }
      try { media.playbackRate = rate; } catch (e) { }
      try {
        Object.defineProperty(media, 'playbackRate', {
          configurable: true,
          get: function () { return rate; },
          set: function () { }
        });
      } catch (e) { }
      return rate;
    }

    function unlockRate(media) {
      try { delete media.playbackRate; } catch (e) { }
    }

    function hideVideoQuiz(doc) {
      var hit = 0;
      try {
        var style = doc.getElementById('ftk-video-quiz-hide');
        if (!style) {
          style = doc.createElement('style');
          style.id = 'ftk-video-quiz-hide';
          style.textContent = '.ans-timelineobjects,.ans-timelineobjectsbg{display:none!important}';
          var host = doc.head || doc.documentElement;
          if (host) { host.appendChild(style); hit++; }
        }
        var overlay = doc.querySelector('.ans-timelineobjects');
        if (overlay && overlay.offsetParent !== null) { overlay.style.display = 'none'; hit++; }
        var backdrop = doc.querySelector('.ans-timelineobjectsbg');
        if (backdrop && backdrop.offsetParent !== null) { backdrop.style.display = 'none'; hit++; }
      } catch (e) { }
      return hit;
    }

    function detect(doc) {
      doc = doc || root.document;
      if (!doc) return null;
      var media = findMedia(doc, 'video');
      var kind = 'video';
      if (!media) {
        media = findMedia(doc, 'audio');
        kind = 'audio';
      }
      if (!media) return null;
      return { kind: kind, media: media };
    }

    /* 当前媒体所属的任务点容器。iframe 的父级链是视频模块最常见的结构；
       顶层页面则只在整页确实只有一个任务点时，才用 .ans-job-icon 兜底。 */
    function taskBox(win) {
      win = win || root;

      try {
        var frame = win.frameElement;
        if (frame && frame.parentElement) {
          var cur = frame.parentElement;
          for (var up = 0; cur && up < 10; up++, cur = cur.parentElement) {
            var ownerDoc = cur.ownerDocument;
            if (ownerDoc && cur === ownerDoc.body) break;
            if (isTaskBox(cur)) return cur;
          }
          /* 老页面可能没有 ans-* 标记，仍返回最近的父级，保留旧的完成检查。 */
          return frame.parentElement;
        }
      } catch (e) { }

      try {
        var top = win.top;
        if (top && top.document && top.document !== win.document) {
          var icons = top.document.querySelectorAll('.ans-job-icon');
          if (icons.length === 1) return icons[0].parentElement;
        }
      } catch (e2) { }

      return null;
    }

    /* 完成标记必须属于当前任务点。一个外层大框里可能还装着别的任务点，
       不能因为子孙里出现绿标就把当前媒体也判成完成。 */
    function hasOwnFinished(box) {
      try {
        var marks = box.querySelectorAll('.ans-job-finished, .icon_Completed');
        for (var i = 0; i < marks.length; i++) {
          var cur = marks[i].parentElement;
          while (cur && cur !== box) {
            if (isTaskBox(cur)) break;
            cur = cur.parentElement;
          }
          if (cur === box) return true;
        }
      } catch (e) { }
      return false;
    }

    function isFinished(box) {
      try {
        var cur = box;
        for (var up = 0; cur && up < 10; up++, cur = cur.parentElement) {
          var c = className(cur);
          if (/ans-job-finished|icon_Completed/.test(c)) return true;
          try {
            if (cur.classList && (cur.classList.contains('ans-job-finished') || cur.classList.contains('icon_Completed'))) return true;
          } catch (eClass) { }
        }
        if (box && box.querySelector && hasOwnFinished(box)) return true;
      } catch (e) { }
      return false;
    }

    /* ---------------------------------------------------------- 可见性 / 排序 */
    function shown(el) {
      try {
        if (!el) return false;
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        var cs = win && win.getComputedStyle ? win.getComputedStyle(el, null) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
        if (!el.getBoundingClientRect) return true;
        var r = el.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) return true;
        if (el.getClientRects) {
          var rects = el.getClientRects();
          for (var i = 0; rects && i < rects.length; i++) {
            var rr = rects[i];
            if (rr && rr.width > 0 && rr.height > 0) return true;
          }
        }
        return false;
      } catch (e) {
        return true;
      }
    }

    function docShown(doc) {
      try {
        var win = doc && doc.defaultView;
        var frame = win && win.frameElement;
        if (frame && !shown(frame)) return false;
        return true;
      } catch (e) {
        return false;
      }
    }

    /* 任务点可能在不同 iframe 里，坐标要逐层加上 iframe 的位置才能比较。 */
    function positionOf(el) {
      var top = 0, left = 0;
      try {
        var r = el.getBoundingClientRect();
        top = Number(r && r.top) || 0;
        left = Number(r && r.left) || 0;
      } catch (e) { }

      try {
        var doc = el.ownerDocument;
        var win = doc && doc.defaultView;
        var topWin = null;
        try { topWin = root.top; } catch (eTop) { topWin = null; }
        for (var up = 0; win && win !== topWin && up < 8; up++) {
          var frame = win.frameElement;
          if (!frame) break;
          var fr = frame.getBoundingClientRect();
          top += Number(fr && fr.top) || 0;
          left += Number(fr && fr.left) || 0;
          try { win = win.parent; } catch (eParent) { break; }
        }
      } catch (e2) { }

      return { top: top, left: left };
    }

    function taskRecord(win, media) {
      try {
        var box = mediaTaskBox(win || root, media);
        if (box) return { box: box, finished: isFinished(box) };

        var href = '';
        try { href = String((win && win.location && win.location.href) || ''); } catch (eUrl) { href = ''; }
        if (/\/ananas\/modules\/(video|audio)\//.test(href)) {
          var fallback = taskBox(win || root);
          return { box: fallback, finished: fallback ? isFinished(fallback) : false };
        }

        var node = media;
        for (var up = 0; node && up < 8; up++, node = node.parentElement) {
          var c = className(node);
          if (node.id === 'reader' || /video-js|vjs-tech/.test(c)) {
            var playerBox = taskBox(win || root);
            return playerBox ? { box: playerBox, finished: isFinished(playerBox) } : null;
          }
        }
      } catch (e) { }
      return null;
    }

    function mediaFrames() {
      try {
        var X = root.FreeTikuX;
        var list = X && X.frames ? X.frames(null, 3) : null;
        if (list && list.length) return list;
      } catch (e) { }
      return [{ win: root, doc: root.document }];
    }

    /* 同一页可能并排放多个视频。按页面坐标从上到下、从左到右排，
       只让最上面那个未完成任务点开播，避免几个播放器互相暂停。 */
    function orderedTasks() {
      var frames = mediaFrames();
      var out = [];
      var seenBox = [];
      var seenMedia = [];

      for (var fi = 0; fi < frames.length; fi++) {
        var frame = frames[fi] || {};
        var doc = frame.doc || null;
        if (!doc) {
          try { doc = frame.win && frame.win.document; } catch (eDoc) { doc = null; }
        }
        if (!doc || !doc.querySelectorAll || !docShown(doc)) continue;

        var list = null;
        try { list = doc.querySelectorAll('video, audio'); } catch (eList) { list = null; }
        if (!list) continue;

        for (var mi = 0; mi < list.length; mi++) {
          var media = list[mi];
          var win = frame.win || root;
          var task = taskRecord(win, media);
          if (!task || task.finished) continue;
          if (!shown(task.box || media)) continue;

          if (task.box) {
            if (seenBox.indexOf(task.box) >= 0) continue;
            seenBox.push(task.box);
          } else {
            if (seenMedia.indexOf(media) >= 0) continue;
            seenMedia.push(media);
          }

          var pos = positionOf(task.box || media);
          out.push({
            win: win,
            doc: doc,
            media: media,
            box: task.box,
            kind: media.tagName === 'AUDIO' ? 'audio' : 'video',
            top: pos.top,
            left: pos.left,
            frameIndex: fi,
            mediaIndex: mi
          });
        }
      }

      out.sort(function (a, b) {
        return (a.top - b.top) || (a.left - b.left) ||
          (a.frameIndex - b.frameIndex) || (a.mediaIndex - b.mediaIndex);
      });
      return out;
    }

    function firstUnfinishedTask() {
      var list = orderedTasks();
      return list.length ? list[0] : null;
    }

    function isFirstUnfinished(win, media) {
      try {
        if (!media) return false;
        var list = orderedTasks();
        if (!list.length) return true;
        var task = taskRecord(win || root, media);
        if (!task) return true;
        if (list[0].box && task.box) return list[0].box === task.box;
        return list[0].media === media;
      } catch (e) {
        return true;
      }
    }

    function stop(reason, internal) {
      /* stopped 是用户停止的总闸：pause 监听不能再 resume，playing 监听
         也不再锁倍速。定时器和观察者一起清掉，播放器完全交还给用户。 */
      state.stopped = true;
      if (state.timers) {
        state.timers.forEach(function (timer) { try { clearInterval(timer); } catch (e) { } });
        state.timers = [];
      }
      if (state.observer) {
        try { state.observer.disconnect(); } catch (e) { }
        state.observer = null;
      }
      if (state.media) {
        try { unlockRate(state.media); } catch (e) { }
        try { state.media.pause(); } catch (e) { }
      }
      state.running = false;
      if (!internal && typeof state.resolve === 'function') {
        var finish = state.resolve;
        state.resolve = null;
        try { finish(false, reason || '用户停止'); } catch (e2) { }
      }
    }

    function drive(doc, opts) {
      opts = opts || {};
      var log = opts.log || noop;
      if (state.running) return state.promise;
      doc = doc || root.document;

      /* 已经完成的任务点不要再播：有些「暂无内容」页面仍保留旧播放器，
         重新播它会让流水线一直等一个永远不会完成的任务。 */
      try {
        var preBox = taskBox(root);
        if (preBox && isFinished(preBox)) {
          log('这个任务点已经完成了，不用再播。', 'dim');
          return Promise.resolve({ done: true, why: '任务点早就完成了', replays: 0, kind: 'none' });
        }
      } catch (ePre) { }

      var found = detect(doc);
      if (!found) return Promise.resolve({ done: false, why: '没找到 video/audio 元素' });

      var media = found.media;
      var rate = clampRate(opts.rate);
      /* 音频任务点没有 video.js 的倍速菜单，不能因为查不到菜单就误判成
         平台禁速，否则音频会被错误地压回 1x。 */
      if (rate > 1 && found.kind === 'video' && rateDisabled(doc)) {
        log('学习通这一节把倍速菜单去掉了，只能按 1x 播（硬改倍速会让任务点完不成）。', 'warn');
        rate = 1;
      }

      state.running = true;
      state.stopped = false;
      state.kind = found.kind;
      state.rate = rate;
      state.done = false;
      state.why = '';
      state.replays = 0;
      state.quizLogged = false;
      state.startedAt = Date.now();
      state.media = media;
      state.timers = [];
      state.observer = null;
      state.resolve = null;

      log('发现一个' + (found.kind === 'video' ? '视频' : '音频') + '，' + rate + 'x 开始播放。'
        + (rate > 2 ? '（提太猛有可能被服务器按「观看时长不足」打回）' : ''));

      state.promise = new Promise(function (resolve) {
        var box = taskBox(root);
        var isResolved = false;
        var hasEnded = false;
        var speedRestored = false;
        var pausedChecks = 0;
        var isResuming = false;

        function finish(done, why) {
          if (isResolved) return;
          isResolved = true;
          state.done = done;
          state.why = why || '';
          state.resolve = null;
          stop('', true);
          var userStop = !done && /用户停止/.test(why || '');
          var label = state.kind === 'video' ? '视频' : '音频';
          log(done ? ('任务点已完成（' + label + '）。')
            : (userStop ? '已停止播放（用户点了停止）。'
              : (label + '没做成：' + (why || '原因不明') + '。')),
            done ? 'ok' : (userStop ? 'dim' : 'warn'));
          resolve({ done: done, why: why || '', replays: state.replays, kind: state.kind });
        }
        state.resolve = finish;

        /* 找不到任务点标记时不能无限等，否则整条流水线会卡在空页面上。 */
        var noBoxSince = Date.now();
        var noBoxTimer = setInterval(function () {
          if (state.stopped || isResolved) { clearInterval(noBoxTimer); return; }
          if (taskBox(root)) { noBoxSince = Date.now(); return; }
          if (Date.now() - noBoxSince > NOBOX_GIVEUP_SEC * 1000) {
            clearInterval(noBoxTimer);
            finish(false, '找不到任务点标记（等了 ' + NOBOX_GIVEUP_SEC + ' 秒），先往下走');
          }
        }, 3000);
        state.timers.push(noBoxTimer);

        function applyRate(r) {
          lockRate(media, r);
        }

        function playMedia() {
          try {
            media.muted = true;
            var p = media.play();
            if (p && p.catch) p.catch(function () { });
          } catch (e) { }
        }

        function resume() {
          if (state.stopped || hasEnded || isResolved || isResuming) return;
          isResuming = true;
          try { playMedia(); } finally { isResuming = false; }
        }

        function checkFinished() {
          if (state.stopped) return false;
          if (isFinished(box)) {
            try { media.pause(); } catch (e) { }
            finish(true, '任务点已完成');
            return true;
          }
          return false;
        }

        if (box) {
          try {
            state.observer = new MutationObserver(function () { checkFinished(); });
            state.observer.observe(box, { attributes: true, attributeFilter: ['class'], subtree: true });
          } catch (e) { /* 没有 MutationObserver 就靠看门狗 */ }
          if (checkFinished()) return;
        }

        function onEnded() {
          if (state.stopped) return;
          hasEnded = true;
          log('已播放到结尾，等 15 秒看任务点是否完成…');

          var waited = 0;
          var timer = setInterval(function () {
            waited += 0.5;
            if (state.stopped || isResolved) { clearInterval(timer); return; }
            if (checkFinished()) { clearInterval(timer); return; }
            if (waited < ENDED_CONFIRM_SEC) return;

            clearInterval(timer);
            if (state.replays >= MAX_REPLAY) {
              finish(false, '重播了 ' + state.replays + ' 次任务点仍未完成');
              return;
            }

            state.replays++;
            log('本地放完了但任务点没完成，第 ' + state.replays + ' 次从头重播（顺带降回 1x）。', 'warn');
            hasEnded = false;
            speedRestored = true;
            pausedChecks = 0;
            unlockRate(media);
            try { media.currentTime = 0; } catch (e) { }
            media.muted = true;
            playMedia();
          }, 500);
          state.timers.push(timer);
        }

        media.addEventListener('playing', function () {
          if (state.stopped) return;
          pausedChecks = 0;
          applyRate(speedRestored ? 1 : rate);
        });
        media.addEventListener('pause', function () {
          if (state.stopped || media.ended || isResolved) return;
          resume();
        });
        media.addEventListener('ended', onEnded);
        media.addEventListener('timeupdate', function () {
          if (state.stopped || speedRestored || isResolved) return;
          if (media.duration && media.duration - media.currentTime < RESTORE_LAST_SEC) {
            speedRestored = true;
            applyRate(1);
            log('快到结尾了，倍速降回 1x，把剩下的观看时长补齐。');
          }
        });

        var watchdog = setInterval(function () {
          if (state.stopped || isResolved) return;
          if (checkFinished()) return;
          if (Date.now() - state.startedAt > HARD_CAP_SEC * 1000) {
            finish(false, '盯了 ' + Math.round(HARD_CAP_SEC / 60) + ' 分钟还没完成');
            return;
          }
          if (media.paused && !hasEnded) {
            pausedChecks++;
            if (pausedChecks === PAUSE_HINT_AT) log('好像被暂停了，一直在重试播放…（资源加载慢？）', 'warn');
            resume();
          }
        }, WATCHDOG_SEC * 1000);
        state.timers.push(watchdog);

        var quizTimer = setInterval(function () {
          if (state.stopped || isResolved) return;
          var hit = hideVideoQuiz(doc);
          if (hit && !state.quizLogged) {
            state.quizLogged = true;
            log('视频里弹出题目了，先藏起来继续播。', 'dim');
          }
        }, QUIZ_HIDE_SEC * 1000);
        state.timers.push(quizTimer);

        applyRate(rate);
        playMedia();
      });

      return state.promise;
    }

    function status() {
      return {
        running: state.running,
        kind: state.kind,
        rate: state.rate,
        replays: state.replays,
        done: state.done,
        why: state.why
      };
    }

    function report() {
      var s = status();
      var lines = [];
      lines.push('媒体类型：' + (s.kind || '（还没开始）'));
      lines.push('倍速：' + (s.rate || 1) + 'x    重播次数：' + s.replays);
      lines.push('状态：' + (s.running ? '正在播放' : (s.done ? '已完成' : '没在跑')) + (s.why ? '（' + s.why + '）' : ''));
      var box = taskBox(root);
      lines.push('任务点容器：' + (box ? (box.className || '(无 class)') : '找不到（window.frameElement 不可用）'));
      lines.push('任务点已完成：' + (isFinished(box) ? '是' : '否'));
      return lines.join('\n');
    }

    return {
      detect: detect,
      drive: drive,
      stop: stop,
      status: status,
      report: report,
      lockRate: lockRate,
      unlockRate: unlockRate,
      rateDisabled: rateDisabled,
      hideVideoQuiz: hideVideoQuiz,
      taskBox: taskBox,
      isFinished: isFinished,
      isTaskBox: isTaskBox, mediaTaskBox: mediaTaskBox,
      orderedTasks: orderedTasks,
      firstUnfinishedTask: firstUnfinishedTask,
      isFirstUnfinished: isFirstUnfinished,
      clampRate: clampRate,
      findMedia: findMedia,
      _const: {
        WATCHDOG_SEC: WATCHDOG_SEC,
        ENDED_CONFIRM_SEC: ENDED_CONFIRM_SEC,
        MAX_REPLAY: MAX_REPLAY,
        NOBOX_GIVEUP_SEC: NOBOX_GIVEUP_SEC,
        RESTORE_LAST_SEC: RESTORE_LAST_SEC,
        MAX_RATE: MAX_RATE,
        HARD_CAP_SEC: HARD_CAP_SEC
      }
    };
  });
