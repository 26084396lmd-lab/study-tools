/* ============================================================================
 *  v130.test.js —— v1.3.0 「一键启动 / 一键停止」+ 空选项字母不前移
 *
 *  用户原话（m05409）：「现在遇到视频时还是自动播放，我想的是点一下启动，
 *  全部进行看视频或者做题，停止的时候全部停止，这是一键启动停止按钮」
 *
 *  A. 没按启动 -> 视频不许自己播，面板说「点「▶ 一键启动」才开始」
 *  B. 按一下启动 -> 真的开播，按钮变「■ 全部停止」，总开关落到 sessionStorage
 *  C. 再按一下 -> 全部停下，按钮变回「▶ 一键启动」，写暂停标记（重载也不复活）
 *  D. core.normOptions 保留空占位（纯图选项不会让后面的字母前移）
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', '学习小助手.user.js');

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
      return { width: 300, height: 24, left: 10, top: 10, right: 310, bottom: 34 };
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 一个「视频任务点」页：页面里一个 <video>，外层有个任务点方框 */
function videoPage() {
  const HTML = `<!doctype html><html><body>
    <div class="ans-attach-ct"><iframe></iframe></div>
    <video></video>
    <form action="/mooc-ans/work/addStudentWorkNew" method="post"></form>
  </body></html>`;
  const env = parseHTML(HTML);
  const doc = env.document, win = env.window;
  patchEnv(win);
  sandboxEvent(win);
  def(win, 'location', { href: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' });

  const media = doc.querySelector('video');
  let plays = 0;
  media.play = function () { plays++; return Promise.resolve(); };
  media.pause = function () { };
  let dur = 600;
  def(media, 'duration', { get: function () { return dur; }, configurable: true });
  def(media, 'currentTime', { get: function () { return 0; }, set: function () { }, configurable: true });
  def(media, 'ended', { get: function () { return false; }, configurable: true });
  def(media, 'paused', { get: function () { return false; }, configurable: true });
  def(media, 'readyState', { get: function () { return 4; }, configurable: true });

  const tbox = doc.querySelector('.ans-attach-ct');
  def(win, 'frameElement', { parentElement: tbox });

  const g = globalThis;
  def(g, 'window', win); def(g, 'document', doc);
  def(g, 'location', win.location); def(g, 'unsafeWindow', win);
  def(g, '__ftkRoot', win);
  def(g, 'navigator', { userAgent: 'node-test' });
  def(win, 'self', win); def(win, 'top', win);
  def(g, 'self', win); def(g, 'top', win);

  const store = {};                       /* 默认什么都没启动 */
  const sess = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  def(win, 'sessionStorage', sess);
  def(g, 'sessionStorage', sess);
  def(win, 'localStorage', sess);
  def(g, 'localStorage', sess);

  /* 关键：别让上一个测试留下的设置混进来 */
  def(g, 'GM_getValue', function (k, d) { return d; });
  def(g, 'GM_setValue', function () { });
  delete g.GM_xmlhttpRequest;
  def(g, 'fetch', function () { return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }); });

  return { doc, win, media, tbox, store, g, plays: () => plays };
}

function loadAll() {
  const FILES = ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js',
    'pipeline.js', 'video.js', 'main.js'];
  FILES.forEach(function (name) {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, name), 'utf8'), { filename: name });
  });
}

(async function () {
  const origLog = console.log, origErr = console.error;
  const lines = [];
  console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); };
  console.error = function () { lines.push('[err] ' + Array.prototype.join.call(arguments, ' ')); };
  const text = (doc) => (doc && doc.body && doc.body.textContent) || '';
  const logText = () => lines.join('\n');

  try {
    /* ---------------------------------------------------------------- A */
    rawLog('\n=== A. 没按启动 -> 视频不许自己播 ===');
    const p = videoPage();
    loadAll();
    await wait(900);
    ok('徽标挂出来了', !!p.doc.getElementById('ftk-badge'));
    ok('面板挂出来了', !!p.doc.getElementById('ftk-panel'));
    ok('没按启动 -> 一次都没调 play()', p.plays() === 0, 'play() 被调 ' + p.plays() + ' 次');
    ok('日志告诉用户「点「▶ 一键启动」才开始」', /一键启动/.test(text(p.doc)), text(p.doc).slice(0, 160));
    ok('状态条是「待命」', /待命/.test(text(p.doc)));
    ok('按钮默认是「▶ 一键启动」',
      /\u25b6 一键启动/.test(p.doc.getElementById('ftk-run').textContent || ''),
      p.doc.getElementById('ftk-run').textContent);
    ok('总开关一开始是关的', !p.store.ftk_run_v1);

    /* ---------------------------------------------------------------- B */
    rawLog('\n=== B. 按一下启动 -> 开播 + 按钮变「全部停止」 ===');
    p.doc.getElementById('ftk-run').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
    await wait(900);
    ok('按了启动就开始播了', p.plays() > 0, 'play() 被调 ' + p.plays() + ' 次');
    ok('总开关落到 sessionStorage（重载也记得）', p.store.ftk_run_v1 === '1');
    ok('顺手清掉了老的「暂停」标记', !p.store.ftk_paused);
    ok('按钮变成「■ 全部停止」',
      /全部停止/.test(p.doc.getElementById('ftk-run').textContent || ''),
      p.doc.getElementById('ftk-run').textContent);
    ok('日志说了开始自动播放', /开始自动播放/.test(text(p.doc) + logText()), lines.slice(-4).join(' | '));

    /* ---------------------------------------------------------------- C */
    rawLog('\n=== C. 再按一下 -> 全部停下 ===');
    p.doc.getElementById('ftk-run').dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true }));
    await wait(400);
    ok('总开关关掉了', !p.store.ftk_run_v1, JSON.stringify(p.store));
    ok('写下了暂停标记（iframe 重载也不会自己跑起来）', p.store.ftk_paused === '1');
    ok('按钮变回「▶ 一键启动」',
      /\u25b6 一键启动/.test(p.doc.getElementById('ftk-run').textContent || ''),
      p.doc.getElementById('ftk-run').textContent);
    ok('日志说「已全部停止」', /已全部停止/.test(text(p.doc) + logText()), lines.slice(-4).join(' | '));

    /* ---------------------------------------------------------------- D */
    rawLog('\n=== D. 空选项（纯图选项）不把后面的字母挤前移 ===');
    const C = globalThis.FreeTikuCore || (globalThis.__ftkRoot && globalThis.__ftkRoot.FreeTikuCore);
    ok('core 模块拿得到', !!C);
    if (C) {
      const n = C.normOptions(['变比相等', '', '短路阻抗报幺值相等']);
      ok('数组分支保留空占位（长度 3）', n.length === 3, JSON.stringify(n));
      const r = C.buildResponse({
        plat: 'test', question: '下面哪一项正确', type: 0,
        options: ['', '', '短路阻抗报幺值相等'], candidates: []
      });
      ok('buildResponse 不抛异常', !!r && typeof r === 'object');
    }

    /* ---------------------------------------------------------------- E */
    rawLog('\n=== E. 任务点标签别点错一个（视频夹在中间）===');
    const PL = globalThis.FreeTikuPipeline || (globalThis.__ftkRoot && globalThis.__ftkRoot.FreeTikuPipeline);
    ok('pipeline 模块拿得到', !!PL);
    if (PL && PL.pickNext) {
      const mk = (label) => {
        const el = p.doc.createElement('div');
        el.innerHTML = '<a href="#">' + label + '</a>';
        return el;
      };
      const tabA = mk('t-a'), tabB = mk('t-b');

      /* 情况 1：视频夹在两个章节测验中间 —— tabs 只有 2 个，points 有 3 个 */
      const s1 = {
        url: 'https://mooc1.chaoxing.com/mycourse/studentstudy', modernMode: false, chapters: [], cur: '',
        points: [
          { type: 'video', finish: true, url: 'v1', box: mk('v1'), text: '视频1' },
          { type: 'work', finish: false, url: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=11', box: mk('w1'), text: '章节测验1' },
          { type: 'video', finish: false, url: 'v2', box: mk('v2'), text: '视频2' },
          { type: 'work', finish: false, url: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=22', box: mk('w2'), text: '章节测验2' }
        ],
        tabs: [{ el: tabA, text: '章节测验1' }, { el: tabB, text: '章节测验2' }]
      };
      const r1 = PL.pickNext(s1, { allowChapter: false });
      ok('第一个测验点的是第 1 个标签', r1 && r1.what === 'task' && r1.click === tabA,
        JSON.stringify({ what: r1 && r1.what, isA: r1 && r1.click === tabA }));

      s1.points[1].finish = true;              /* 第 1 个做完了 -> 该轮到第 2 个 */
      const r2 = PL.pickNext(s1, { allowChapter: false });
      ok('做完第一个就该点第 2 个标签（不是第 3 个、也不是空）',
        r2 && r2.what === 'task' && r2.click === tabB,
        JSON.stringify({ what: r2 && r2.what, isB: r2 && r2.click === tabB }));

      /* 情况 2：视频在前、测验在后 —— tabs 只有 1 个，下标必须从 0 数起 */
      const tabC = mk('t-c');
      const s2 = {
        url: 'https://mooc1.chaoxing.com/mycourse/studentstudy', modernMode: false, chapters: [], cur: '',
        points: [
          { type: 'video', finish: true, url: 'v9', box: mk('v9'), text: '视频' },
          { type: 'work', finish: false, url: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=33', box: mk('w3'), text: '章节测验' }
        ],
        tabs: [{ el: tabC, text: '章节测验' }]
      };
      const r3 = PL.pickNext(s2, { allowChapter: false });
      ok('视频在前时，唯一的那个标签也能对上', r3 && r3.what === 'task' && r3.click === tabC,
        JSON.stringify({ what: r3 && r3.what, isC: r3 && r3.click === tabC }));
    }

    /* ---------------------------------------------------------------- E */
    rawLog('\n=== E. 构建产物 ===');
    const dist = fs.readFileSync(DIST, 'utf8');
    ok('dist 版本号是 1.3.x', /@version\s+1\.3\.[0-9]+/.test(dist));
    ok('dist 里有 startVideo', /function startVideo/.test(dist));
    ok('dist 里有 WHALE（DeepSeek 那头的鲸鱼）', /WHALE/.test(dist));
    ok('命中率分母排除了「已填过跳过」的题', /questions\.length - skipped/.test(dist));
  } catch (e) {
    fail++;
    rawLog('  \u2717 抛异常：' + ((e && e.stack) || e));
  }

  console.log = origLog; console.error = origErr;
  rawLog('\n================  v130.test.js  ' + pass + ' 通过 / ' + fail + ' 失败  ================');
  process.exit(fail ? 1 : 0);
})();