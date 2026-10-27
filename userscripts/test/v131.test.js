/* ============================================================================
 *  v131.test.js —— 点「一键启动」必须真的动起来（v1.3.1）
 *
 *  用户实测（截图）：面板显示「已全部停止」，点启动之后视频还是 3:58 停着不动。
 *
 *  两个真实成因：
 *    A. 面板永远建在最外层课程页（XF().home()），而视频/题目在子框架里。
 *       onStart 只在本层 `VK.detect(document)`，查不到就当「这一页没活」，
 *       接着 `dispatch('run')` 把「开始」派给了视频那一层的**答题函数** ——
 *       答题函数只认题目，于是报一句「没解析到题目」就完事，视频一动不动。
 *       现在改成广播：每层都调一次 `start()`，媒体优先，谁认领谁干活。
 *    B. 按钮靠**按钮上的字**判断这次是启动还是停止。状态和文字一旦对不上，
 *       点「启动」实际执行的是停止 —— 也是「点了没反应」。
 *       现在只认内部真实状态 isOn。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', '\u5b66\u4e60\u901a\u514d\u8d39\u9898\u5e93\u52a9\u624b.user.js');

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

class Ev {
  constructor(t, o) {
    o = o || {};
    this.type = t; this.bubbles = !!o.bubbles; this.cancelable = !!o.cancelable;
    this.eventPhase = 0; this._path = []; this.target = null; this.currentTarget = null;
    this.clientX = o.clientX || 0; this.clientY = o.clientY || 0; this.button = 0;
    this.NONE = 0; this.CAPTURING_PHASE = 1; this.AT_TARGET = 2; this.BUBBLING_PHASE = 3;
  }
  stopPropagation() { } stopImmediatePropagation() { } preventDefault() { }
}

function makeStorage(init) {
  const m = Object.create(null);
  if (init) for (const k in init) m[k] = String(init[k]);
  return {
    getItem: function (k) { return m[k] === undefined ? null : m[k]; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    clear: function () { for (const k in m) delete m[k]; },
    _raw: m
  };
}

function makeDoc(html) {
  const env = parseHTML(html);
  const document = env.document, window = env.window;
  try {
    const proto = window.Element && window.Element.prototype;
    if (proto) proto.getBoundingClientRect = function () {
      return { width: 340, height: 400, left: 10, top: 10, right: 350, bottom: 410 };
    };
  } catch (e) { /* ... */ }
  window.Event = Ev; window.MouseEvent = Ev;
  def(window, 'innerWidth', 1200);
  def(window, 'innerHeight', 800);
  const frame = {
    document: document,
    location: { href: 'https://mooc1.chaoxing.com/mycourse/studentstudy' },
    localStorage: makeStorage(), sessionStorage: makeStorage(),
    addEventListener: function () { }, removeEventListener: function () { },
    Event: Ev, MouseEvent: Ev, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: function () { return { display: 'block', visibility: 'visible' }; }
  };
  frame.self = frame; frame.top = frame; frame.window = frame;
  try { Object.defineProperty(document, 'defaultView', { value: window, configurable: true }); } catch (e) { }
  def(window, 'localStorage', frame.localStorage);
  return { document: document, window: window, frame: frame };
}

/* ---------------------------------------------------------------- A. 按钮 */
rawLog('\n=== A. 按钮只认真实状态，不认按钮上的字 ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  def(globalThis, '__ftkRoot', f.frame);
  def(globalThis, 'window', f.window);
  def(globalThis, 'document', f.document);
  def(globalThis, 'location', f.frame.location);
  def(globalThis, 'Event', Ev);
  def(globalThis, 'MouseEvent', Ev);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8'), { filename: 'panel.js' });
  const Panel = f.frame.FreeTikuPanel;
  ok('panel 模块加载了', !!Panel);

  let starts = 0, stops = 0;
  const P = Panel.create({
    doc: f.document, settings: {},
    onSettings: function () { },
    onStart: function () { starts++; }, onStop: function () { stops++; },
    onSubmit: function () { }, onClear: function () { }, onDiag: function () { },
    onRework: function () { }, onReset: function () { }
  });
  const btn = f.document.getElementById('ftk-run');
  const click = function () { btn.dispatchEvent(new Ev('click', { bubbles: true })); };
  ok('按钮建出来了', !!btn);
  ok('默认字幕是「一键启动」', String(btn.textContent).indexOf('\u4e00\u952e\u542f\u52a8') >= 0, btn.textContent);

  click();
  ok('第一次点 = 启动', starts === 1 && stops === 0, 'starts=' + starts + ' stops=' + stops);

  P.running(true);
  ok('running(true) 之后字幕变成「全部停止」', String(btn.textContent).indexOf('\u505c\u6b62') >= 0, btn.textContent);
  click();
  ok('运行中再点 = 停止', stops === 1 && starts === 1, 'starts=' + starts + ' stops=' + stops);

  P.running(false);
  ok('running(false) 之后字幕回到「一键启动」', String(btn.textContent).indexOf('\u542f\u52a8') >= 0, btn.textContent);

  /* 关键回归：字幕被外部改乱成「停止」，但真实状态是停着的 —— 必须按启动处理 */
  btn.textContent = '\u25a0 \u5168\u90e8\u505c\u6b62';
  click();
  ok('字幕与状态不一致时，按真实状态执行启动（旧版会误判成停止）',
    starts === 2 && stops === 1, 'starts=' + starts + ' stops=' + stops);
  P.running(true);
  btn.textContent = '\u25b6 \u4e00\u952e\u542f\u52a8';
  click();
  ok('反过来也一样：字幕写着启动，但状态在跑 -> 执行停止',
    stops === 2, 'stops=' + stops);
}

/* 关键回归：面板刚重建、按钮还没同步，但主流程总开关在跑。
   这时用户点「启动」，必须按「停止」处理，不能又启动一遍。 */
rawLog('\n=== A2. 面板状态滞后时，点启动也要能停 ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  def(globalThis, '__ftkRoot', f.frame);
  def(globalThis, 'window', f.window);
  def(globalThis, 'document', f.document);
  def(globalThis, 'location', f.frame.location);
  def(globalThis, 'Event', Ev);
  def(globalThis, 'MouseEvent', Ev);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8'), { filename: 'panel.js' });
  const Panel = f.frame.FreeTikuPanel;
  let starts = 0, stops = 0;
  const P = Panel.create({
    doc: f.document, settings: {},
    isRunning: function () { return true; },
    onSettings: function () { },
    onStart: function () { starts++; }, onStop: function () { stops++; },
    onSubmit: function () { }, onClear: function () { }, onDiag: function () { },
    onRework: function () { }, onReset: function () { }
  });
  const btn = f.document.getElementById('ftk-run');
  btn.dispatchEvent(new Ev('click', { bubbles: true }));
  ok('面板显示启动、但总开关在跑 -> 执行停止', starts === 0 && stops === 1,
    'starts=' + starts + ' stops=' + stops);
  ok('停止后按钮立刻回到启动，不等回调慢慢收尾',
    String(btn.textContent).indexOf('\u4e00\u952e\u542f\u52a8') >= 0, btn.textContent);
  P.running(false);
}

/* ------------------------------------------------------- B. 广播给每一层 */
rawLog('\n=== B. ctlEach：每一层都通知到（视频层不能只被派答题）===');
{
  const HTML = '<!doctype html><html><head></head><body></body></html>';
  const XF_SRC = fs.readFileSync(path.join(SRC, 'xframe.js'), 'utf8');
  const mk = function (top) {
    const env = parseHTML(HTML);
    const fr = {
      document: env.document,
      location: { href: 'https://mooc1.chaoxing.com/x' },
      addEventListener: function () { }, removeEventListener: function () { },
      history: { pushState: function () { }, replaceState: function () { } }
    };
    fr.self = fr; fr.top = top || fr;
    return fr;
  };
  const apiOf = function (fr) {
    def(globalThis, '__ftkRoot', fr);
    vm.runInThisContext(XF_SRC, { filename: 'xframe.js' });
    return fr.FreeTikuX;
  };
  const top = mk(null), sub1 = mk(null), sub2 = mk(null);
  sub1.top = top; sub2.top = top;
  const xTop = apiOf(top), x1 = apiOf(sub1), x2 = apiOf(sub2);

  const sub3 = mk(top);                     /* 第三层：没有 start 方法（模拟别的脚本） */
  const x3 = apiOf(sub3);
  let v1 = 0, v2 = 0, q = 0;
  xTop.ctlRegister({ start: function () { return false; } });          /* 顶层：没活 */
  x1.ctlRegister({ start: function () { v1++; return true; } });       /* 视频层 */
  x2.ctlRegister({ start: function () { v2++; q++; return true; } });  /* 题目层 */
  x3.ctlRegister({ hasWork: function () { return false; } });          /* 只报状态，不认领 */

  /* 顶层自己也算一个：它返回 false，不该被算进「认领数」 */
  const n = xTop.ctlEach ? xTop.ctlEach('start') : -1;
  ok('ctlEach 存在（旧版没有）', typeof xTop.ctlEach === 'function');
  ok('两层都收到了广播', v1 === 1 && v2 === 1, 'v1=' + v1 + ' v2=' + v2);
  ok('只数真正认领的层（顶层返回 false 不计）', n === 2, 'n=' + n);

  /* 没有 start 方法的框架不能把整个广播搞崩 */
  let threw = false;
  try { xTop.ctlEach('start'); } catch (e) { threw = true; }
  ok('有框架没实现 start 也不抛异常', !threw);
  ok('第二遍广播又各收到一次', v1 === 2 && v2 === 2, 'v1=' + v1 + ' v2=' + v2);
}

/* --------------------------------------------------------------- C. 源码 */
rawLog('\n=== C. 构建产物：启动走的是「媒体优先 + 广播」===');
{
  const dist = fs.readFileSync(DIST, 'utf8');
  ok('版本号是 1.3.12', /@version\s+1\.3\.12/.test(dist));
  ok('有 startHere（媒体优先的启动入口）', /function startHere\(\)/.test(dist));
  ok('有活也先广播（不再本层提前 return）',
    /ctlEach\('start'\)/.test(dist));
  /* 广播必须排在「本层兜底」之前，否则隐藏音频又会把视频层挡掉 */
  const iBroadcast = dist.indexOf("ctlEach('start')");
  const iLocalFallback = dist.indexOf('if (startHere()) return;');
  ok('ctlEach(start) 在 startHere 兜底之前',
    iBroadcast >= 0 && iLocalFallback > iBroadcast, 'broadcast=' + iBroadcast + ' local=' + iLocalFallback);
  ok('ctlEach 在 xframe 里实现了', /function ctlEach\(cmd, arg\)/.test(dist));
  ok('按钮同时看面板状态和真实总开关', /var active = isOn/.test(dist) && /opts\.isRunning/.test(dist));
  /* 媒体优先：startHere 里 VK.detect 必须出现在 localWork 之前 */
  const i = dist.indexOf('function startHere()');
  const seg = dist.slice(i, i + 1200);
  ok('startHere 里先查媒体、再查题目',
    seg.indexOf('VK.detect') >= 0 && seg.indexOf('VK.detect') < seg.indexOf('localWork()'));
}

rawLog('\n================  v131.test.js  ' + pass + ' 通过 / ' + fail + ' 失败  ================');
process.exit(fail ? 1 : 0);