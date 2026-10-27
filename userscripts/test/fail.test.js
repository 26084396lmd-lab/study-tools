/* ============================================================================
 *  fail.test.js —— 不及格之后的行为（v1.1.6）
 *
 *  用户实测：一道题答案是「四倍」，题库（百度）给了「四分之一」，于是 2 题里错 1 题
 *  -> 50% -> 不及格 -> 自动点「重做」-> 缓存里还是那个错答案 -> 又不及格 -> 无限循环，
 *  而且「停止」按了也没用（stopFlag 只存在内存里，重做会重新加载 iframe，标志就没了）。
 *
 *  这一份盯着修完之后的五个行为：
 *    A. 第一次不及格 -> 点一次「重做」，并且先把答错的缓存清掉（/forget）
 *    B. 同一份测验再不及格 -> 不点了，"先记下来跳过"，别再原地打转
 *    C. 暂停中 -> 不自动重做
 *    D. 暂停中 -> 流水线也不许自动开答
 *    E. 页面上根本没有「重做」按钮 -> 记下来往下走
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');

let pass = 0, fail = 0;
const rawLog = console.log.bind(console);
function ok(name, cond, extra) {
  if (cond) { pass++; rawLog('  \u2713 ' + name); }
  else { fail++; rawLog('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}
function def(obj, name, value) {
  try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
  catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
}
function patchEnv(win) {
  try {
    const proto = win.Element && win.Element.prototype;
    if (proto) proto.getBoundingClientRect = function () {
      return { width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34 };
    };
  } catch (e) { /* ... */ }
  try { win.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; }; }
  catch (e) { /* ... */ }
}
function sandboxEvent(win) {
  class E {
    constructor(type, opt) {
      opt = opt || {};
      this.type = type; this.bubbles = !!opt.bubbles; this.cancelable = !!opt.cancelable;
      this.eventPhase = 0; this._path = []; this.target = null; this.currentTarget = null;
      this.NONE = 0; this.CAPTURING_PHASE = 1; this.AT_TARGET = 2; this.BUBBLING_PHASE = 3;
    }
    stopPropagation() { } stopImmediatePropagation() { } preventDefault() { }
  }
  win.Event = win.MouseEvent = E;
  def(globalThis, 'Event', E);
  def(globalThis, 'MouseEvent', E);
}

/* 已批改的答题页（2 题，1 对 1 错 -> 不及格），可选带「重做」按钮 */
function failPage(withRework) {
  return `<!doctype html><html><body>
  <div class="tip">\u26a0 未达到及格线，请重做</div>
  <form action="/mooc-ans/work/addStudentWorkNew" method="post">
    <input type="hidden" name="answerwqbid" value="Q1,Q2,">
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle"><span>1【判断题】简谐振动的动能和势能变化频率与位移相同。</span></div>
        <ul><li>A 对</li><li>B 错</li></ul>
        <div class="myAnswer">我的答案：B</div>
      </div>
    </div>
    <div class="singleQuesId" data="Q2">
      <div class="TiMu" data="0">
        <div class="Zy_TItle"><span>2【单选题】振幅增加为原来的两倍，总能量变为原来的</span></div>
        <ul><li>A 二分之一</li><li>B 两倍</li><li>C 四倍</li><li>D 四分之一</li></ul>
        <div class="myAnswer">我的答案：D</div>
      </div>
    </div>
  </form>
  <div class="score">50.0 分</div>
  ${withRework ? '<a href="javascript:;" id="rework1">重做</a>' : ''}
  <a id="prevNextFocusNext">下一节</a>
</body></html>`;
}
/* 还没答的题目页（用来验证「暂停时不许自动开答」） */
function freshPage() {
  return `<!doctype html><html><body>
  <form action="/mooc-ans/work/addStudentWorkNew" method="post">
    <input type="hidden" name="answerwqbid" value="Q1,">
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle"><span>1【单选题】机械波的形成需要什么？</span></div>
        <ul><li><input type="radio" name="answerQ1" value="A">A 介质</li>
            <li><input type="radio" name="answerQ1" value="B">B 真空</li></ul>
      </div>
    </div>
  </form>
</body></html>`;
}

/* ⚠ 每一段测试都要把自己排的定时器收干净。
   main.js 会 setInterval(rebootstrap, 3000)，而模块是反复 runInThisContext 加载的，
   上一段留下的定时器/MutationObserver 会在下一段里跑，读的却是「当前」全局 document
   —— 面板会被别的段的 boot() 抢去重建，日志凭空消失。这就是本文件第一次跑时
   B/E 两段结果诡异的原因。 */
function runMain(html, opts) {
  opts = opts || {};
  const realST = globalThis.setTimeout, realSI = globalThis.setInterval;
  const realCT = globalThis.clearTimeout, realCI = globalThis.clearInterval;
  const mine = [];
  globalThis.setTimeout = function (fn, ms) {
    const a = [].slice.call(arguments, 2);
    const id = realST.apply(null, [fn, ms].concat(a));
    mine.push(['t', id]); return id;
  };
  globalThis.setInterval = function (fn, ms) {
    const a = [].slice.call(arguments, 2);
    const id = realSI.apply(null, [fn, ms].concat(a));
    mine.push(['i', id]); return id;
  };
  return new Promise(function (resolve) {
    const { document, window } = parseHTML(html);
    patchEnv(window);
    sandboxEvent(window);
    def(window, 'self', window);
    def(window, 'top', window);
    def(window, 'location', { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=7788' });

    const g = globalThis;
    def(g, 'window', window);
    def(g, 'document', document);
    def(g, 'location', window.location);
    def(g, 'unsafeWindow', window);
    def(g, '__ftkRoot', window);
    def(g, 'navigator', { userAgent: 'node-test' });

    const store = Object.assign({}, opts.session || {});   /* 预置 sessionStorage（模拟「上次跑过」） */
    const sess = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    };
    def(window, 'sessionStorage', sess);
    def(g, 'sessionStorage', sess);
    def(window, 'localStorage', sess);
    def(g, 'localStorage', sess);

    const set = opts.settings || {};
    def(g, 'GM_getValue', (k, d) => (k === 'ftk_settings_v1' ? set : d));
    def(g, 'GM_setValue', function () { });
    delete g.GM_xmlhttpRequest;

    const posts = [];
    def(g, 'fetch', function (url, o) {
      posts.push({ url: String(url), body: (o && o.body) || '' });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}') });
    });

    const clicked = [];
    const all = document.querySelectorAll('a,button,input,li,#rework1');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      el.click = function () { clicked.push(el.id || (el.textContent || '').trim().slice(0, 6)); };
    }

    const lines = [];
    console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); };
    console.error = function () { lines.push('[err] ' + Array.prototype.join.call(arguments, ' ')); };

    try {
      ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js', 'pipeline.js', 'video.js', 'main.js']
        .forEach(function (f) {
          vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
        });
    } catch (e) {
      console.log = rawLog; console.error = rawLog;
      ok('模块加载没抛异常', false, String(e && e.message));
    }

    realST(function () {
      console.log = rawLog; console.error = rawLog;
      for (let i = 0; i < mine.length; i++) {
        try { mine[i][0] === 't' ? realCT(mine[i][1]) : realCI(mine[i][1]); } catch (e) { /* ... */ }
      }
      globalThis.setTimeout = realST;
      globalThis.setInterval = realSI;
      const lines2 = lines.slice();
      resolve({
        document, window, lines: lines2, clicked, store, posts,
        text: (document.body && document.body.textContent) || ''
      });
    }, opts.wait || 4500);
  });
}

const PIPE_ON = { pipe: true, minHit: 80, baidu: true, icodef: true, ai: false, video: true };
/* v1.3.0 起「自动答/自动翻/自动重做」必须先点过「一键启动」，A/B/E 就是按过之后的状态 */
const ARM = { ftk_run_v1: '1' };
/* 日志可能进面板、也可能只走了 console（面板被重建/顶层框架没有面板），两处都算 */
function has(r, re) { return re.test(r.text) || new RegExp(re.source).test(r.lines.join('\n')); }

(async function () {
  rawLog('\n=== A. 第一次不及格 -> 点一次「重做」，并先清掉错答案缓存 ===');
  {
    const r = await runMain(failPage(true), { settings: PIPE_ON, wait: 2200, session: ARM });
    ok('点了「重做」', r.clicked.indexOf('rework1') >= 0, JSON.stringify(r.clicked));
    ok('日志说没及格', has(r, /没及格/), r.text.slice(0, 200));
    ok('日志说清掉了缓存', has(r, /清掉.*缓存|不再用旧的错答案/), r.lines.join(' | ').slice(0, 300));
    ok('确实往桥发了 /forget（不然重做还是同一批错答案）',
       r.posts.some(function (p) { return p.url.indexOf('/forget') >= 0; }),
       JSON.stringify(r.posts.map(function (p) { return p.url; })));
    ok('/forget 是「清整张缓存」（只清一道题会漏掉同页其它错题）',
       r.posts.some(function (p) { return p.url.indexOf('/forget') >= 0 && p.body === '{}'; }),
       JSON.stringify(r.posts));
    ok('记下了「这份已经重做过」', String(r.store.ftk_pipe_tried || '').indexOf('rework:w7788') >= 0,
       String(r.store.ftk_pipe_tried || ''));
    ok('重做次数 +1', String(r.store.ftk_pipe_rework || '') === '1',
       String(r.store.ftk_pipe_rework || ''));
  }

  rawLog('\n=== B. 重做过了还是不及格 -> 不能再点，记下来跳过 ===');
  {
    const r = await runMain(failPage(true), {
      settings: PIPE_ON, wait: 2200,
      session: Object.assign({ ftk_pipe_tried: '["rework:w7788"]', ftk_pipe_rework: '1' }, ARM)
    });
    ok('没有再去点「重做」（这就是原来那个死循环）',
       r.clicked.indexOf('rework1') < 0, JSON.stringify(r.clicked));
    ok('日志说「先记下来跳过」', has(r, /记下来跳过|打转/), r.lines.join(' | ').slice(0, 300));
    ok('没再发 /forget', !r.posts.some(function (p) { return p.url.indexOf('/forget') >= 0; }),
       JSON.stringify(r.posts.map(function (p) { return p.url; })));
    ok('把这份测验记进了「失败的清单」',
       String(r.store.ftk_pipe_failed || '').indexOf('7788') >= 0,
       String(r.store.ftk_pipe_failed || ''));
  }

  rawLog('\n=== C. 暂停中 -> 不自动重做 ===');
  {
    const r = await runMain(failPage(true), {
      settings: PIPE_ON, wait: 2200, session: { ftk_paused: '1' }
    });
    ok('没有点「重做」', r.clicked.indexOf('rework1') < 0, JSON.stringify(r.clicked));
    ok('日志说「已暂停」', has(r, /已暂停/), r.lines.join(' | ').slice(0, 300));
    ok('提示了手动点页面上的「重做」', has(r, /手动|点页面上/), r.lines.join(' | ').slice(0, 320));
  }

  rawLog('\n=== D. 暂停中 -> 流水线不许自动开答 ===');
  {
    const r = await runMain(freshPage(), {
      settings: PIPE_ON, wait: 3200, session: { ftk_paused: '1' }
    });
    ok('没有「自动开始答题」', !has(r, /自动开始答题/),
       r.lines.filter(function (l) { return /自动/.test(l); }).join(' | '));
    ok('日志说「已暂停。点「开始答题」才继续。」',
       has(r, /已暂停。点/) || has(r, /才继续/), r.lines.join(' | ').slice(0, 320));
    ok('状态显示「已暂停」', has(r, /已暂停/), r.text.slice(0, 200));
  }

  rawLog('\n=== E. 页面上没有「重做」按钮 -> 记下来往下走 ===');
  {
    const r = await runMain(failPage(false), { settings: PIPE_ON, wait: 2200, session: ARM });
    ok('日志说找不到「重做」', has(r, /找不到.*重做/), r.lines.join(' | ').slice(0, 320));
    ok('把这份记进了「失败的清单」',
       String(r.store.ftk_pipe_failed || '').indexOf('7788') >= 0,
       String(r.store.ftk_pipe_failed || ''));
  }

  rawLog('\n=== G. 点「停止」要真的写下暂停标志（不然重做一次它就自己又跑起来）===');
  {
    const r = await runMain(freshPage(), { settings: PIPE_ON, wait: 3200 });
    const stop = r.document.getElementById('ftk-stop');
    ok('面板上有「停止」按钮', !!stop, '没找到 #ftk-stop');
    if (stop) {
      try { stop.dispatchEvent(new r.window.MouseEvent('click', { bubbles: true })); }
      catch (e) { ok('派发 click 没抛异常', false, String(e && e.message)); }
    }
    ok('点完「停止」写下了 ftk_paused=1（上一版这个标志只存在内存里，重做一次就丢）',
       String(r.store.ftk_paused || '') === '1', String(r.store.ftk_paused || '(空)'));
  }

  rawLog('\n' + '='.repeat(58));
  rawLog('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  rawLog('='.repeat(58));
  process.exit(fail ? 1 : 0);
})();