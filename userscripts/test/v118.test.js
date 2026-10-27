/* ============================================================================
 *  v118.test.js —— v1.1.8 的三处修复
 *
 *  A. 已经完成的任务点：不能再重播（用户报「暂无内容的页面卡着不翻页」）
 *  B. 找不到任务点标记时会放弃等待（别把流水线等死）
 *  C. goNext 先点页面上的「下一节」，而不是按章节树跳（5-3 / 6-2 来回蹦）
 *  D. apply 选不中选项时，拿选项的页面原文（o.raw）再试一次
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', '学习小助手.user.js');

const rawLog = console.log.bind(console);
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; rawLog('  \u2713 ' + name); }
  else { fail++; rawLog('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}
function def(obj, name, value) {
  try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
  catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
}

const clock = { now: 0, seq: 0, timers: {} };
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
function fakeSetInterval(fn, ms) { const id = ++clock.seq; clock.timers[id] = { fn, ms: ms || 1, next: clock.now + (ms || 1) }; return id; }
function fakeClearInterval(id) { delete clock.timers[id]; }
function tick(ms) {
  const end = clock.now + ms;
  for (;;) {
    let due = null;
    for (const k of Object.keys(clock.timers)) {
      const t = clock.timers[k];
      if (t.next <= end && (!due || t.next < due.next)) due = t;
    }
    if (!due) break;
    clock.now = due.next; due.next += due.ms;
    try { due.fn(); } catch (e) { /* 断言去抓 */ }
  }
  clock.now = end;
}
globalThis.setInterval = fakeSetInterval;
globalThis.clearInterval = fakeClearInterval;

class SandboxEvent {
  constructor(type, init) {
    this.type = type; this.bubbles = !!(init && init.bubbles);
    this.eventPhase = 0; this._path = []; this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { }
}

function boxStub(classes) {
  const set = {};
  (classes || []).forEach(c => { set[c] = 1; });
  return {
    className: 'ans-attach-ct',
    classList: { add(c) { set[c] = 1; }, remove(c) { delete set[c]; }, contains(c) { return !!set[c]; } },
    _set: set
  };
}

const RATE_MENU = '<div class="vjs-playback-rate"><ul class="vjs-menu-content"><li class="vjs-menu-item">2x</li></ul></div>';

function load(file, frame) {
  def(globalThis, '__ftkRoot', frame);
  const code = fs.readFileSync(path.join(SRC, file), 'utf8');
  vm.runInThisContext(code, { filename: file });
  return frame;
}

function scene(html, boxClasses) {
  const { document, window } = parseHTML(html);
  def(window, 'location', { href: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' });
  def(window, 'self', window); def(window, 'top', window);
  def(globalThis, 'self', window); def(globalThis, 'top', window);
  def(window, 'Event', SandboxEvent); def(window, 'MouseEvent', SandboxEvent);
  def(globalThis, 'Event', SandboxEvent); def(globalThis, 'MouseEvent', SandboxEvent);
  const box = boxStub(boxClasses);
  def(window, 'frameElement', { parentElement: box });
  return { document, window, box, frame: window };
}

function stubMedia(doc, tag) {
  const el = doc.querySelector(tag);
  let played = 0;
  el.play = function () { played++; el.paused = false; return Promise.resolve(); };
  el.pause = function () { el.paused = true; };
  el.muted = false;
  def(el, 'paused', true);
  def(el, 'duration', 600);
  def(el, 'currentTime', 0);
  def(el, 'ended', false);
  def(el, 'addEventListener', function () { });
  return { el, played: () => played };
}

/* ------------------------------------------------------------------ A */
async function sectionA() {
  rawLog('\n=== A. 已经完成的任务点：不能再重播 ===');
  const s = scene('<video></video>' + RATE_MENU, ['ans-job-finished']);
  const VK = load('video.js', s.frame).FreeTikuVideo;
  ok('video.js 挂到了本框架上', !!VK);
  const m = stubMedia(s.document, 'video');

  const r = await VK.drive(s.document, { rate: 2, log() { } });
  ok('已完成的媒体任务点：直接算完成', r && r.done === true, JSON.stringify(r));
  ok('已完成的媒体任务点：理由说清楚了', /早就完成/.test(String(r && r.why)), r && r.why);
  ok('已完成的媒体任务点：没有再去播它', m.played() === 0, 'play 调了 ' + m.played() + ' 次');

  const s2 = scene('<video></video>' + RATE_MENU, []);
  const VK2 = load('video.js', s2.frame).FreeTikuVideo;
  const m2 = stubMedia(s2.document, 'video');
  let settled2 = null;
  VK2.drive(s2.document, { rate: 2, log() { } }).then(function (r) { settled2 = r; });
  tick(5);
  ok('没完成的任务点：不走「早就完成了」的捷径',
    !(settled2 && settled2.done === true && /早就完成/.test(String(settled2.why))),
    JSON.stringify(settled2));
  ok('没完成的任务点：也不会误报「找不到媒体」', !(settled2 && /没找到 video/.test(String(settled2.why))),
    JSON.stringify(settled2));
  VK2.stop();
  tick(70000);
}

/* ------------------------------------------------------------------ C / B / A2：结构断言 */
function sectionCDB() {
  rawLog('\n=== B/C. 翻页顺序 + 不在已完成的任务点上干等（dist 结构） ===');
  const dist = fs.readFileSync(DIST, 'utf8');

  const g = dist.indexOf('function goNext(');
  ok('dist 里找得到 goNext', g > 0);
  /* 窗口从 2600 放宽到 4200：v1.3.1 在 goNext 前面加了「视频卡住放行」的可配置逻辑，
     断言要检查的顺序没变，只是代码变长了一点。 */
  const seg = dist.slice(g, g + 4200);
  const atBtn = seg.indexOf('findNextBtnInTree()');
  const atAdv = seg.indexOf('localAdvance()');
  ok('goNext 里「点页面上的下一节」排在「章节树」前面', atBtn > 0 && atAdv > 0 && atBtn < atAdv,
    'button@' + atBtn + ' advance@' + atAdv);
  ok('goNext 里写明了按学习通自己的顺序', seg.indexOf('按学习通自己的顺序') > 0);
  ok('goNext 保留了「退回章节树」的兜底', seg.indexOf('localAdvance()') > 0);

  ok('localWork 不把已完成的任务点当成有活',
    /if \(mediaStillTodo\(root, document\)\) return true;/.test(dist));
  ok('workInTree 同样排除已完成的任务点',
    /function workInTree\(\)[\s\S]{0,300}visibleWorkInDoc\(root, 0\)/.test(dist));
  ok('video.js：已完成的任务点不重播', /任务点已经完成了，不用再播/.test(dist));
  ok('video.js：找不到任务点标记会放弃等待', /NOBOX_GIVEUP_SEC/.test(dist));
  ok('面板日志会打出题干和选项（方便诊断）', /选项：/.test(dist));
}

/* ------------------------------------------------------------------ D */
function sectionD() {
  rawLog('\n=== D. apply 用选项的页面原文兜底 ===');
  const s = scene('<div></div>', []);
  const frame = s.frame;
  frame.FreeTikuCore = {
    answerVariants: function (x) { return [String(x).toLowerCase().replace(/\s+/g, '')]; }
  };
  const CX = load('chaoxing.js', frame).FreeTikuChaoxing;
  ok('chaoxing.js 挂到了本框架上', !!CX);

  const resp = { answer: { answerKeyText: '', bestAnswer: ['三角形'], answerText: '三角形' } };

  function fakeInput() {
    return {
      checked: false, type: 'radio',
      click: function () { this.checked = true; },
      dispatchEvent: function () { },
      setAttribute: function () { },
      removeAttribute: function () { },
      getAttribute: function () { return ''; }
    };
  }
  function fakeLi() {
    return {
      querySelector: function () { return null; },
      classList: { add() { }, remove() { }, contains() { return false; } },
      click: function () { }, dispatchEvent: function () { }, getAttribute: function () { return ''; }
    };
  }
  function opt(letter, text, raw) { return { letter: letter, text: text, raw: raw, input: fakeInput(), li: fakeLi() }; }

  /* 内存里的选项文字是加密后的（对不上答案），但 o.raw 是页面原文 */
  const q1 = {
    type: 'single', stem: 'x',
    options: [opt('A', '料底', 'A 星形'), opt('B', '崎岖', 'B 三角形'), opt('C', '罔罔', 'C 方形')]
  };
  const r1 = CX.apply(q1, resp, {});
  ok('能被 o.raw 救回来（不再报「无法定位选项」）', r1.how !== '无法定位选项', JSON.stringify(r1));
  ok('救回来之后真的填上了', r1.applied === true, JSON.stringify(r1));

  /* 对照：连页面原文都对不上时，还是要老实报「无法定位选项」 */
  const q2 = {
    type: 'single', stem: 'x',
    options: [opt('A', '啥也不是', 'A 啥也不是'), opt('B', '乱七八糟', 'B 乱七八糟')]
  };
  const r2 = CX.apply(q2, resp, {});
  ok('对不上时仍然报「无法定位选项」（没有乱填）', r2.applied === false && r2.how === '无法定位选项',
    JSON.stringify(r2));

  /* 内存文字就是对的：老路径不能坏 */
  const q3 = {
    type: 'single', stem: 'x',
    options: [opt('A', '星形', 'A 星形'), opt('B', '三角形', 'B 三角形')]
  };
  const r3 = CX.apply(q3, resp, {});
  ok('内存文字本来就对时照旧能用', r3.how !== '无法定位选项' && r3.applied === true, JSON.stringify(r3));
}

(async function main() {
  rawLog('================  v118.test.js  ================');
  try { await sectionA(); } catch (e) { fail++; rawLog('  \u2717 A 段炸了：' + (e && e.stack || e)); }
  try { sectionCDB(); } catch (e) { fail++; rawLog('  \u2717 B/C 段炸了：' + (e && e.stack || e)); }
  try { sectionD(); } catch (e) { fail++; rawLog('  \u2717 D 段炸了：' + (e && e.stack || e)); }
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  rawLog('\n================  v118.test.js  ' + pass + ' 通过 / ' + fail + ' 失败  ================');
  process.exit(fail ? 1 : 0);
})();