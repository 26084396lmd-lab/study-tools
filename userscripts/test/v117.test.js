/* ============================================================================
 *  v117.test.js —— v1.1.7 的回归测试
 *
 *  起因（用户 m03907 / m03909）：
 *    「又卡住了，开始答题和停止还是用不了」
 *    配图里是《机械波》的章节测验：两道带公式的单选题，选项在 DOM 里只剩
 *    "A"/"B"/"C"/"D"，题干里的公式整个消失 —— 题库和 AI 都答不出来。
 *
 *  这一版改了四处，这里一处一处盯着：
 *    A. chaoxing.js 的 txt()：公式是 <img>，以前只看 innerText 会被静悄悄吃掉；
 *       现在自己遍历节点，把 alt / title / URL 里的 latex 捡回来，
 *       装饰小图标不误伤，真公式图留「［式］」占位。
 *    B. xframe.js 的命令槽：面板按钮除了直接跨框架调函数，还有一条纯 DOM 数据的兜底通道。
 *    C. panel.js：「停止」不再是开局就 disabled 的死键；两个按钮都永远可点。
 *    D. main.js：run() 用 try/finally 兜住按钮状态 —— 中间抛异常也必须回到空闲，
 *       否则「开始答题」会被永久禁用（就是「点了没反应」的死因之一）。
 *
 *  ⚠ 沿用 ui.test.js 的两个坑：
 *     linkedom 的 window 是 Proxy、未知属性落到 globalThis，所以每个「框架」
 *     用自己的普通对象当 root；xframe.js 的函数缩进是 5 空格（read 会多显示一个）。
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

class SandboxEvent {
  constructor(type, opt) {
    opt = opt || {};
    this.type = type; this.bubbles = !!opt.bubbles; this.cancelable = !!opt.cancelable;
    this.eventPhase = 0; this._path = []; this.target = null; this.currentTarget = null;
    this.NONE = 0; this.CAPTURING_PHASE = 1; this.AT_TARGET = 2; this.BUBBLING_PHASE = 3;
  }
  stopPropagation() { } stopImmediatePropagation() { } preventDefault() { }
}

let timers = [];
function grabTimers() {
  timers = [];
  def(globalThis, 'setTimeout', function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; });
  def(globalThis, 'clearTimeout', function () { });
  def(globalThis, 'setInterval', function (fn, ms) { timers.push({ fn: fn, ms: ms, iv: true }); return timers.length; });
  def(globalThis, 'clearInterval', function () { });
}
function runNamed(name) {
  let hit = 0;
  for (let i = 0; i < timers.length; i++) {
    const t = timers[i];
    if (t && t.fn && t.fn.name === name && !t.iv) { try { t.fn(); } catch (e) { /* ... */ } hit++; }
  }
  return hit;
}

function makeStorage() {
  const m = Object.create(null);
  return {
    getItem: function (k) { return m[k] === undefined ? null : m[k]; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    clear: function () { for (const k in m) delete m[k]; }
  };
}

function makeFrame(html, topFrame, href) {
  const env = parseHTML(html);
  const document = env.document, window = env.window;
  try {
    const proto = window.Element && window.Element.prototype;
    if (proto) proto.getBoundingClientRect = function () {
      return { width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34 };
    };
  } catch (e) { /* ... */ }
  try { window.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; }; }
  catch (e) { /* ... */ }
  window.Event = window.MouseEvent = SandboxEvent;
  def(window, 'innerWidth', 1200);
  def(window, 'innerHeight', 800);

  const frame = {
    document: document,
    history: { pushState: function () { }, replaceState: function () { } },
    addEventListener: function () { }, removeEventListener: function () { },
    getComputedStyle: window.getComputedStyle,
    Event: SandboxEvent, MouseEvent: SandboxEvent,
    location: { href: href || 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=999' },
    innerWidth: 1200, innerHeight: 800,
    localStorage: makeStorage(),
    sessionStorage: makeStorage()
  };
  frame.self = frame;
  frame.top = topFrame || frame;
  frame.window = frame;
  return { document: document, window: window, frame: frame, env: env };
}

const ALL_FILES = ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js',
  'pipeline.js', 'video.js', 'main.js'];

function prepEnv(f, settingsObj) {
  def(globalThis, '__ftkRoot', f.frame);
  def(globalThis, 'window', f.window);
  def(globalThis, 'document', f.document);
  def(globalThis, 'location', f.frame.location);
  def(globalThis, 'unsafeWindow', f.window);
  def(globalThis, 'Event', SandboxEvent);
  def(globalThis, 'MouseEvent', SandboxEvent);
  def(globalThis, 'self', f.frame);
  def(globalThis, 'top', f.frame.top);
  def(globalThis, 'fetch', function () { return Promise.reject(new Error('测试里不发网络请求')); });
  delete globalThis.GM_xmlhttpRequest;
  def(globalThis, 'GM_setValue', function () { });
  def(globalThis, 'GM_getValue', function (k, d) { return settingsObj === undefined ? d : settingsObj; });
}
function loadSome(f, names, settingsObj) {
  prepEnv(f, settingsObj);
  names.forEach(function (name) {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, name), 'utf8'), { filename: name });
  });
}
function load(f, settingsObj) { loadSome(f, ALL_FILES, settingsObj); }

const logText = (f) => {
  const el = f.document.getElementById('ftk-log');
  return el ? el.textContent : '';
};

/* ================================================================== A */
rawLog('\n=== A. 公式是 <img>：txt() 不能再把题干和选项吃掉 ===');

const FORMULA_HTML = `<!doctype html><html><body>
  <div class="singleQuesId" data="Q1">
    <div class="TiMu" data="0">
      <div class="Zy_TItle"><span>1【单选题】已知x=-1m处质点的振动方程为<img class="tex" src="/math/latex?latex=y%3DA%5Ccos(%5Comega%20t%2B%5Cvarphi)">，则此波的波动方程为（）。</span></div>
      <ul>
        <li><input type="radio" name="answerQ1" value="A">A <img alt="y=A\\cos[\\omega(t+\\frac{x}{u})+\\varphi]"></li>
        <li><input type="radio" name="answerQ1" value="B">B <img class="tex" src="/math/latex?latex=y%3DA%5Ccos(%5Comega%20t%20-%20kx)"></li>
        <li><input type="radio" name="answerQ1" value="C">C <img src="/static/icon_play_small.png"></li>
        <li><input type="radio" name="answerQ1" value="D">D 波的周期为<img width="28" height="20" src="/math/2pi.svg"></li>
      </ul>
    </div>
  </div>
  <div class="singleQuesId" data="Q2">
    <div class="TiMu" data="3">
      <div class="Zy_TItle"><span>2【判断题】在波动中，波函数描述了介质中任意一点的位移状态。</span></div>
      <ul><li>对</li><li>错</li></ul>
    </div>
  </div>
</body></html>`;

{
  const f = makeFrame(FORMULA_HTML, null);
  grabTimers();
  loadSome(f, ['chaoxing.js']);
  const CX = f.frame.FreeTikuChaoxing;
  ok('chaoxing.js 挂到了本框架上', !!CX);
  const qs = CX.extractQuestions();
  ok('解析出 2 题', qs.length === 2, '实际 ' + qs.length);

  const q1 = qs[0] || { stem: '', options: [] };
  const optText = (i) => String((q1.options[i] || {}).text || '');

  ok('题干里的公式从 URL 的 latex 参数捡回来了',
    /A\\?cos/.test(q1.stem) && /\\omega/.test(q1.stem), '题目：' + q1.stem.slice(0, 80));
  ok('选项 A 用了图片的 alt', optText(0).indexOf('\\frac{x}{u}') >= 0, '选项A：' + optText(0));
  ok('选项 B 用了 URL 里的 latex', /kx/.test(optText(1)), '选项B：' + optText(1));
  ok('选项 C 的花哨小图标没被当成公式（不放占位）',
    optText(2).indexOf('［式］') < 0, '选项C：' + optText(2));
  ok('选项 D 的大图留了「［式］」占位（不再静悄悄消失）',
    optText(3).indexOf('［式］') >= 0, '选项D：' + optText(3));
  ok('选项前缀还是被 cleanOption 去掉了', optText(0).indexOf('A ') !== 0, '选项A：' + optText(0));
  ok('判断题照旧解析正常', String((qs[1] || {}).stem || '').indexOf('波函数') >= 0);
}

/* ================================================================== B */
rawLog('\n=== B. xframe 命令槽：按钮的兜底通道（纯 DOM 数据） ===');
{
  const topF = makeFrame('<html><body><div id="mainid"></div></body></html>', null, 'https://mooc2-ans.chaoxing.com/mycourse/studentstudy?chapterId=1');
  const subF = makeFrame('<html><body><div class="TiMu" data="0"></div></body></html>', topF.frame,
    'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=999');
  grabTimers();
  load(topF, { pipe: false });
  load(subF, { pipe: false });

  const XT = topF.frame.FreeTikuX, XS = subF.frame.FreeTikuX;
  ok('两层拿到的是各自的 xframe 实例', !!XT && !!XS && XT.ID !== XS.ID);
  ok('两层指向同一张登记表', XT.regNode() === XS.regNode());

  ok('顶层发命令', XT.cmdSend('run') === true);
  ok('发命令的那一层自己收不到', XT.cmdRecv() === null);
  const got = XS.cmdRecv();
  ok('子框架收得到', !!got && got.cmd === 'run', '收到：' + (got && got.cmd));
  XS.cmdTake();
  ok('领走之后别人就收不到了', XT.cmdRecv() === null && XS.cmdRecv() === null);

  XT.cmdSend('stop', { why: '用户点的' });
  const got2 = XS.cmdRecv();
  ok('同一条槽可以反复用（换命令、带参数）', !!got2 && got2.cmd === 'stop' && got2.arg && got2.arg.why === '用户点的');
  ok('命令序号是递增的（轮询靠它去重）', got2.n > got.n, got.n + ' -> ' + got2.n);
}

/* ================================================================== C */
rawLog('\n=== C. 面板按钮：两个都永远可点 ===');
const topQ = makeFrame(FORMULA_HTML, null, 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=999');
{
  grabTimers();
  load(topQ, { pipe: false });
  runNamed('boot');
  ok('测验页 boot 之后建出了面板', topQ.document.querySelectorAll('#ftk-panel').length === 1);
  const runBtn = topQ.document.getElementById('ftk-run');
  const stopBtn = topQ.document.getElementById('ftk-stop');
  ok('「停止」不再是开局就灰着的死键', stopBtn.disabled === false);
  ok('「开始答题」也没被禁用', runBtn.disabled === false);
  ok('「停止」已经收成内部键，界面上由左边的切换键代替',
    stopBtn.style.display === 'none', stopBtn.style.display);
  ok('切换键有解释性的 title（按下去会停下什么）',
    /一键|停下|开始自动/.test(runBtn.getAttribute('title') || ''), runBtn.getAttribute('title'));
}

/* ================================================================== D */
rawLog('\n=== D. run() 里抛异常，「开始答题」也必须还能再按 ===');
(async function sectionD() {
  const runBtn = topQ.document.getElementById('ftk-run');
  const CX = topQ.frame.FreeTikuChaoxing;
  const origKind = CX.pageKind;

  /* 让 runBody 第一行就炸：如果 finally 没兜住，按钮会永远停在「正在跑」的样子 */
  CX.pageKind = function () { throw new Error('boom-pageKind'); };
  runBtn.dispatchEvent(new SandboxEvent('click', { bubbles: true }));
  ok('按下去时按钮变成红色的「停止」', runBtn.textContent.indexOf('■') >= 0,
    '现在文字=' + runBtn.textContent);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  ok('run 抛异常后按钮回到空闲（finally 兜住了）',
    runBtn.textContent.indexOf('▶') >= 0, '现在文字=' + runBtn.textContent);

  /* 修好之后再按：必须真的能重新进入答题流程 */
  CX.pageKind = origKind;
  const before = logText(topQ).split('数据源').length;
  runBtn.dispatchEvent(new SandboxEvent('click', { bubbles: true }));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  ok('异常之后还能重新开始答题（日志里又出现了一轮）',
    logText(topQ).split('数据源').length > before,
    '之前 ' + before + ' 次，现在 ' + logText(topQ).split('数据源').length + ' 次');
  ok('重新开始后按钮又显示「跑着」', /停止/.test(runBtn.textContent || ''), runBtn.textContent);

  rawLog('\n================  v117.test.js  ' + pass + ' 通过 / ' + fail + ' 失败  ================');
})();