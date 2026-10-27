/* ============================================================================
 *  v122.test.js —— 面板能不能拖（v1.2.2）
 *
 *  用户实测：「在运行的时候，我没法拖动这个小框子移动到合适的位置，
 *            像被固定了一样」
 *
 *  三个真实成因，一条一条盯死：
 *    A. 只把 `#ftk-head` 那条 28px 当手柄 —— 改成整个面板都能抓，
 *       只放过按钮/勾选框/输入框/日志。
 *    B. 鼠标移动的监听挂在 `opts.doc` 上；子框架把面板建到**外层文档**时
 *       监听和鼠标不在同一份文档里，按下去之后就一个事件都收不到。
 *       必须挂到 `box.ownerDocument`。
 *    C. 换章节是 AJAX，面板会被重建；每次重建都回到右下角 —— 位置要存。
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
class Ev extends SandboxEvent {
  constructor(t, o) {
    super(t, o); o = o || {};
    this.clientX = o.clientX || 0; this.clientY = o.clientY || 0;
    this.button = o.button === undefined ? 0 : o.button;
  }
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

/* 造一份文档 + 它自己的 window（不是 Proxy，避免各框架串味） */
function makeDoc(html, st) {
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
    location: { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork' },
    localStorage: makeStorage(st),
    sessionStorage: makeStorage(),
    addEventListener: function () { }, removeEventListener: function () { },
    Event: Ev, MouseEvent: Ev, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: function () { return { display: 'block', visibility: 'visible' }; }
  };
  frame.self = frame; frame.top = frame; frame.window = frame;
  /* 面板的拖动实现走 box.ownerDocument.defaultView，这里必须给到 window */
  try { Object.defineProperty(document, 'defaultView', { value: window, configurable: true }); } catch (e) { }
  /* 真实浏览器里 window.localStorage 就是这一个；linkedom 的 window 没有，
     要把面板会去读的那份挂上去，否则「记住位置」测不出来 */
  def(window, 'localStorage', frame.localStorage);
  return { document: document, window: window, frame: frame };
}

function loadPanel(f) {
  def(globalThis, '__ftkRoot', f.frame);
  def(globalThis, 'window', f.window);
  def(globalThis, 'document', f.document);
  def(globalThis, 'location', f.frame.location);
  def(globalThis, 'Event', Ev);
  def(globalThis, 'MouseEvent', Ev);
  def(globalThis, 'self', f.frame);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8'), { filename: 'panel.js' });
  /* panel.js 挂在 __ftkRoot（= 这个框架自己）上，不是挂在 globalThis 上 */
  return f.frame.FreeTikuPanel;
}

function makePanel(f, Panel, hostDoc) {
  return Panel.create({
    doc: hostDoc || f.document,
    settings: {},
    onSettings: function () { },
    onStart: function () { }, onStop: function () { }, onSubmit: function () { },
    onClear: function () { }, onDiag: function () { }, onRework: function () { },
    onReset: function () { }
  });
}

const DOWN = (el, x, y) => el.dispatchEvent(new Ev('mousedown', { bubbles: true, clientX: x, clientY: y }));
const MOVE = (doc, x, y) => doc.body.dispatchEvent(new Ev('mousemove', { bubbles: true, clientX: x, clientY: y }));
const UP = (doc, x, y) => doc.body.dispatchEvent(new Ev('mouseup', { bubbles: true, clientX: x, clientY: y }));

rawLog('\n=== A. 抓头部就能拖 ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  const Panel = loadPanel(f);
  const P = makePanel(f, Panel);
  const box = f.document.getElementById('ftk-panel');
  ok('面板建出来了', !!box);
  DOWN(f.document.getElementById('ftk-head'), 100, 100);
  MOVE(f.document, 150, 130);
  ok('头部按下 + 移动 -> 位置变了', box.style.left === '60px' && box.style.top === '40px',
    'left=' + box.style.left + ' top=' + box.style.top);
  ok('right/bottom 被清成 auto（否则会跟 left/top 打架）',
    box.style.right === 'auto' && box.style.bottom === 'auto',
    'right=' + box.style.right + ' bottom=' + box.style.bottom);
  UP(f.document, 150, 130);
  MOVE(f.document, 400, 400);
  ok('松手之后再动鼠标就不跟着跑了', box.style.left === '60px', 'left=' + box.style.left);
}

rawLog('\n=== B. 从面板空白处/状态条也能拖，但按钮、勾选框不能 ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  const Panel = loadPanel(f);
  makePanel(f, Panel);
  const box = f.document.getElementById('ftk-panel');
  DOWN(f.document.getElementById('ftk-status'), 100, 100);
  MOVE(f.document, 120, 100);
  ok('从状态条拖得动', box.style.left === '30px', 'left=' + box.style.left);

  const before = box.style.left;
  UP(f.document, 120, 100);
  DOWN(f.document.getElementById('ftk-run'), 100, 100);
  MOVE(f.document, 300, 100);
  ok('按在「启动」按钮上不会变成拖面板', box.style.left === before, 'left=' + box.style.left);
  UP(f.document, 300, 100);

  DOWN(f.document.getElementById('ftk-log'), 100, 100);
  MOVE(f.document, 320, 100);
  ok('按在日志区不会变成拖面板（那里要能选中文字）', box.style.left === before, 'left=' + box.style.left);
}

rawLog('\n=== C. 面板建在外层文档、脚本在子框架里 —— 鼠标在外层动，必须跟得上 ===');
{
  const top = makeDoc('<!doctype html><html><body><iframe id="child"></iframe></body></html>');
  const child = makeDoc('<!doctype html><html><body></body></html>');
  child.frame.top = top.frame;
  /* 子框架里跑 panel.js，但把面板建到外层文档（真实场景：题目框里调 ensurePanel） */
  const Panel = loadPanel(child);
  const P = makePanel(child, Panel, top.document);
  const box = top.document.getElementById('ftk-panel');
  ok('面板确实建在外层文档里', !!box);
  ok('子框架里没有第二份面板', !child.document.getElementById('ftk-panel'));
  DOWN(top.document.getElementById('ftk-head'), 200, 200);
  MOVE(top.document, 260, 250);
  ok('在外层文档里移动鼠标，面板跟得上（旧版这里一动不动）',
    box.style.left === '70px' && box.style.top === '60px',
    'left=' + box.style.left + ' top=' + box.style.top);
  UP(top.document, 260, 250);
}

rawLog('\n=== D. 位置要记住：换章节重建面板后不再弹回右下角 ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  const Panel = loadPanel(f);
  makePanel(f, Panel);
  const box = f.document.getElementById('ftk-panel');
  DOWN(f.document.getElementById('ftk-head'), 100, 100);
  MOVE(f.document, 180, 160);
  UP(f.document, 180, 160);
  ok('拖完写进了 localStorage', !!f.frame.localStorage.getItem('ftk_pos_v1'),
    String(f.frame.localStorage.getItem('ftk_pos_v1')));

  /* 模拟换章节：面板整个被拆掉重建 */
  box.parentNode.removeChild(box);
  makePanel(f, Panel);
  const box2 = f.document.getElementById('ftk-panel');
  ok('重建后回到上次的位置', box2.style.left === '90px' && box2.style.top === '70px',
    'left=' + box2.style.left + ' top=' + box2.style.top);
  ok('重建后是绝对定位，不是右下角锚定',
    box2.style.right === 'auto' && box2.style.bottom === 'auto');
}

rawLog('\n=== E. 拖到屏幕外要夹回来 ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  const Panel = loadPanel(f);
  makePanel(f, Panel);
  const box = f.document.getElementById('ftk-panel');
  DOWN(f.document.getElementById('ftk-head'), 100, 100);
  MOVE(f.document, -5000, -5000);
  ok('往左上拖不出去', parseFloat(box.style.left) >= -280 && parseFloat(box.style.top) >= 0,
    'left=' + box.style.left + ' top=' + box.style.top);
  MOVE(f.document, 9000, 9000);
  ok('往右下拖不出去（innerWidth=1200 时 left 不超过 1140）',
    parseFloat(box.style.left) <= 1140 && parseFloat(box.style.top) <= 766,
    'left=' + box.style.left + ' top=' + box.style.top);
  UP(f.document, 9000, 9000);
}

rawLog('\n=== F. 存了脏数据也不能把面板搞没 ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>',
    { ftk_pos_v1: 'not-json{{{' });
  const Panel = loadPanel(f);
  makePanel(f, Panel);
  const box = f.document.getElementById('ftk-panel');
  ok('脏 JSON 不抛异常，退回默认位置', !!box && !box.style.left, 'left=' + box.style.left);
}

/* ---------------------------------------------------------------------------
 * v1.3.4：用户说「题库窗口拖拉不动」。
 * 现场是学习通视频页：面板内容有 690px 高，笔记本 125%/150% 缩放下
 * 可视区只有 600px 左右，标题栏被 bottom:16px 顶到屏幕外 —— 抓不到标题栏，
 * 下面又全是按钮/勾选框/日志（都不当拖动手柄），看起来就是「拖不动」。
 * 这里盯三件事：面板高度受视口限制、标题栏始终在屏幕里、指针事件也能拖。
 * -------------------------------------------------------------------------*/
rawLog('\n=== G. 屏幕矮的时候，标题栏不能被顶出屏幕（v1.3.4） ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  f.window.innerHeight = 480;
  f.frame.innerHeight = 480;
  const Panel = loadPanel(f);
  makePanel(f, Panel);
  const box = f.document.getElementById('ftk-panel');
  ok('面板最大高度 = 视口高度 - 32px', box.style.maxHeight === '448px',
    'maxHeight=' + box.style.maxHeight);
  ok('标题栏上有专门的拖动抓手', !!box.querySelector('.ftk-grip'));
  ok('抓手有提示文字', /拖动/.test(String((box.querySelector('.ftk-grip') || {}).title || '')),
    String((box.querySelector('.ftk-grip') || {}).title || ''));
  const css = Array.from(f.document.querySelectorAll('style')).map(s => s.textContent).join('');
  ok('面板内容区自己能滚，不会把标题栏挤出去', /#ftk-body\{[^}]*overflow-y:auto/.test(css));
  ok('拖动时禁用浏览器默认触摸滚动', /#ftk-head\{[^}]*touch-action:none/.test(css));
}

rawLog('\n=== H. 指针事件（触摸屏 / 触控板）也能拖，并且会做指针捕获（v1.3.4） ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  const Panel = loadPanel(f);
  makePanel(f, Panel);
  const box = f.document.getElementById('ftk-panel');
  const head = f.document.getElementById('ftk-head');
  let cap = null, rel = null;
  box.setPointerCapture = function (id) { cap = id; };
  box.releasePointerCapture = function (id) { rel = id; };
  const PE = (type, target, x, y, id) => {
    const e = new Ev(type, { bubbles: true, clientX: x, clientY: y });
    e.pointerId = id; e.isPrimary = true; e.pointerType = 'touch';
    target.dispatchEvent(e);
  };
  PE('pointerdown', head, 100, 100, 7);
  ok('按下时把指针捕获到面板（拖过 iframe 也不断）', cap === 7, 'cap=' + cap);
  PE('pointermove', f.document.body, 160, 140, 7);
  ok('指针移动 -> 面板跟着走', box.style.left === '70px' && box.style.top === '50px',
    'left=' + box.style.left + ' top=' + box.style.top);
  PE('pointermove', f.document.body, 400, 400, 8);
  ok('第二根手指不会把面板抢走', box.style.left === '70px' && box.style.top === '50px',
    'left=' + box.style.left + ' top=' + box.style.top);
  PE('pointerup', f.document.body, 160, 140, 7);
  ok('松手时释放指针捕获', rel === 7, 'rel=' + rel);
  PE('pointermove', f.document.body, 500, 500, 7);
  ok('松手后再动不会继续跟着跑', box.style.left === '70px', 'left=' + box.style.left);
}

rawLog('\n=== I. 小窗口里拖动也要有足够行程（v1.3.9） ===');
{
  const f = makeDoc('<!doctype html><html><body></body></html>');
  const Panel = loadPanel(f);
  makePanel(f, Panel);
  const box = f.document.getElementById('ftk-panel');
  try { Object.defineProperty(box, 'offsetHeight', { value: 700, configurable: true }); }
  catch (e) { /* linkedom 版本差异，测不到就算了 */ }
  DOWN(f.document.getElementById('ftk-head'), 100, 100);
  MOVE(f.document, 150, 900);
  ok('往下拖到底时，标题栏仍在屏幕里（面板其余部分可以超出视口）',
    parseFloat(box.style.top) <= 766 && parseFloat(box.style.top) >= 0, 'top=' + box.style.top);
  MOVE(f.document, 150, -900);
  ok('往上拖到头时，标题栏仍然在屏幕顶部', parseFloat(box.style.top) >= 0,
    'top=' + box.style.top);
  UP(f.document, 150, -900);
}

rawLog('\n----------------------------------------');
rawLog((fail ? '\u274c' : '\u2705') + ' v122 结果：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);