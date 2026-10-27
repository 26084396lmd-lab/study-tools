/* ============================================================================
 *  result.test.js —— 已批改的结果页不能再答一遍 + 交完要自己往下翻
 *
 *  用户实测（截图）：交完卷之后页面变成结果页，但结果页上 `.TiMu` 还在，
 *  于是脚本把它当成新的答题页又做了一遍，然后卡在那儿不动。
 *  这一份就盯着这个场景：
 *    A. chaoxing.js 能不能认出结果页（判据不能只看 .TiMu）
 *    B. 结果页上点「开始答题」也不会去动任何选项
 *    C. 流水线模式下，结果页要自己点「下一节」继续往下走
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

/* ---------------- 两种页面（除了「批改痕迹」和「有没有控件」完全一样） ---- */
const QUIZ_BODY = (graded) => `
  <form action="/mooc-ans/work/addStudentWorkNew" method="post">
    <input type="hidden" name="answerwqbid" value="Q1,">
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle"><span>1【单选题】机械波的形成需要什么？</span></div>
        <ul>
          <li>${graded ? '' : '<input type="radio" name="answerQ1" value="A">'}A 介质</li>
          <li>${graded ? '' : '<input type="radio" name="answerQ1" value="B">'}B 真空</li>
        </ul>
        ${graded ? '<div class="myAnswer">我的答案：A</div>' : ''}
      </div>
    </div>
  </form>
  <a id="prevNextFocusNext">下一节</a>
  <a id="prevNextFocusPrev">上一节</a>
  ${graded ? '<div class="score">25.0 分</div>' : ''}`;

function build(graded, withFail) {
  const html = '<!doctype html><html><body>' +
    (withFail ? '<div class="tip">\u26a0 未达到及格线，请重做</div>' : '') +
    QUIZ_BODY(graded) + '</body></html>';
  const { document, window } = parseHTML(html);
  patchEnv(window);
  sandboxEvent(window);
  if (!window.self) def(window, 'self', window);
  return { document, window };
}
function loadCX(win, doc) {
  def(globalThis, '__ftkRoot', win);
  def(globalThis, 'window', win);
  def(globalThis, 'document', doc);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8'), { filename: 'chaoxing.js' });
  return win.FreeTikuChaoxing;
}

/* ------------------------------------------------------------------ A */
rawLog('\n=== A. 认不认得出「已批改的结果页」 ===');
{
  const fresh = build(false, false);
  const CXf = loadCX(fresh.window, fresh.document);
  ok('新答题页：返回 null（还要作答）', CXf.resultState() === null,
     String(CXf.resultState()));
  ok('新答题页：确实检测到可填控件', CXf.hasAnswerInputs() === true);
}
{
  const done = build(true, false);
  const CXd = loadCX(done.window, done.document);
  ok('结果页：`.TiMu` 还在，但必须认出「done」（这就是上次重做的根因）',
     CXd.resultState() === 'done', String(CXd.resultState()));
  ok('结果页：没有可填控件了', CXd.hasAnswerInputs() === false);
}
{
  const bad = build(true, true);
  const CXb = loadCX(bad.window, bad.document);
  ok('结果页 + 「未达到及格线」→ fail', CXb.resultState() === 'fail', String(CXb.resultState()));
}
{
  const blank = parseHTML('<!doctype html><html><body><p>普通页面</p></body></html>');
  patchEnv(blank.window);
  const CXx = loadCX(blank.window, blank.document);
  ok('普通页面 → null', CXx.resultState() === null, String(CXx.resultState()));
}

/* --------------------------------------------------- A2 「下一节」按钮 */
rawLog('\n=== A2. 找得到页面上的「下一节」吗 ===');
{
  const d = build(true, false);
  const CX = loadCX(d.window, d.document);
  const nb = CX.findNextPageBtn();
  ok('按 id 找到 #prevNextFocusNext', !!nb && nb.id === 'prevNextFocusNext',
     nb ? nb.id : 'null');
}
{
  const env2 = parseHTML('<!doctype html><html><body><div class="btns">' +
    '<a href="javascript:;">上一节</a><a href="javascript:;" id="n2">下一节</a></div></body></html>');
  patchEnv(env2.window);
  const CX2 = loadCX(env2.window, env2.document);
  const nb2 = CX2.findNextPageBtn();
  ok('没有固定 id 时按文字找到「下一节」', !!nb2 && nb2.id === 'n2', nb2 ? nb2.id : 'null');
}
{
  const env3 = parseHTML('<!doctype html><html><body><p>没有任何按钮</p></body></html>');
  patchEnv(env3.window);
  const CX3 = loadCX(env3.window, env3.document);
  ok('没有就返回 null（不能瞎点）', CX3.findNextPageBtn() === null);
}

/* ------------------------------------------------- B/C 整体跑一遍 main.js */
function runMain(html, opts) {
  return new Promise(function (resolve) {
    const { document, window } = parseHTML(html);
    patchEnv(window);
    sandboxEvent(window);
    /* ⚠ linkedom 的 window 是 Proxy，未知属性会落到 globalThis 上，
       所以 `window.self` 可能是上一段测试留下的别的对象 —— 必须强制覆盖。 */
    def(window, 'self', window);
    def(window, 'top', window);          /* 把本框架当顶层跑：徽标/面板由它建（v1.1.4 单例） */
    def(window, 'location', { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=1' });

    const g = globalThis;
    def(g, 'window', window);
    def(g, 'document', document);
    def(g, 'location', window.location);
    def(g, 'unsafeWindow', window);
    def(g, '__ftkRoot', window);
    def(g, 'navigator', { userAgent: 'node-test' });

    /* v1.3.0 起「自动答/自动翻」必须用户点过「一键启动」才会发生，
       所以这里预先把运行标记种进 sessionStorage（等于用户已经按了启动）。 */
    const store = { ftk_run_v1: '1' };
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
    delete g.GM_xmlhttpRequest;                        // 让 transport 走下面的假 fetch
    def(g, 'fetch', function () {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"code":-1}') });
    });

    const clicked = [];
    const markAll = function () {
      const all = document.querySelectorAll('a,button,input,li');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (el.id === 'prevNextFocusNext' || /下一节/.test(el.textContent || '')) {
          el.click = function () { clicked.push(el.id || 'bytext'); };
        }
      }
    };
    markAll();

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

    setTimeout(function () {
      console.log = rawLog; console.error = rawLog;
      const text = (document.body && document.body.textContent) || '';
      resolve({ document, window, text, lines, clicked, store });
    }, 4500);
  });
}

(async function () {
  rawLog('\n=== B. 结果页上绝不能重做（非流水线）===');
  {
    const r = await runMain('<!doctype html><html><body>' + QUIZ_BODY(true) + '</body></html>', {});
    ok('面板出来了', !!r.document.getElementById('ftk-panel') || !!r.document.getElementById('ftk-badge'));
    ok('日志说「已经批改过了」', /已经批改过/.test(r.text),
       r.lines.filter(function (l) { return /批改/.test(l); }).join(' | '));
    ok('日志说「不再重复作答」', /不再重复作答/.test(r.text),
       r.lines.filter(function (l) { return /重复|作答/.test(l); }).join(' | '));
    ok('没有去点任何选项（两个 radio 都不存在，这里查 li 上的 class）',
       !/已选/.test(r.text));
    ok('没有点「下一节」（非流水线模式不该乱翻页）',
       r.clicked.length === 0, JSON.stringify(r.clicked));
  }

  rawLog('\n=== C. 流水线模式下，结果页要自己点「下一节」继续 ===');
  {
    const r = await runMain('<!doctype html><html><body>' + QUIZ_BODY(true) + '</body></html>',
      { settings: { pipe: true, minHit: 80, baidu: true, icodef: true, ai: false } });
    ok('日志说「切下一个」或「交完了」',
       /切下一个|交完了|下一节/.test(r.text),
       r.lines.filter(function (l) { return /下一节|交完|切下/.test(l); }).join(' | '));
    ok('真的点了「下一节」', r.clicked.length > 0, JSON.stringify(r.clicked));
    ok('记下了「这一页已经点过下一节」（防止原地打转）',
       String(r.store.ftk_pipe_tried || '').indexOf('nextbtn:') >= 0,
       String(r.store.ftk_pipe_tried || ''));
  }

  rawLog('\n' + '='.repeat(58));
  rawLog(`  通过 ${pass} 项，失败 ${fail} 项`);
  rawLog('='.repeat(58));
  process.exit(fail ? 1 : 0);
})();