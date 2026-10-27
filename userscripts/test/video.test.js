/* ============================================================================
 *  video.test.js —— 视频/音频任务点驱动器
 *
 *  video.js 里的时间全靠 setInterval，所以要跑「重播」这类分支就得先把
 *  定时器换成假的（可以任意快进），否则光等 ENDED_CONFIRM_SEC=15 秒就受不了。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');

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

/* ---------------------------------------------------------------- 假时钟 */
const clock = { now: 0, seq: 0, timers: {} };
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
function fakeSetInterval(fn, ms) { const id = ++clock.seq; clock.timers[id] = { fn, ms: ms || 1, next: clock.now + (ms || 1) }; return id; }
function fakeClearInterval(id) { delete clock.timers[id]; }
function tick(ms) {
  const end = clock.now + ms;
  for (;;) {
    let due = null, id = null;
    for (const k of Object.keys(clock.timers)) {
      const t = clock.timers[k];
      if (t.next <= end && (!due || t.next < due.next)) { due = t; id = k; }
    }
    if (!due) break;
    clock.now = due.next;
    due.next += due.ms;
    try { due.fn(); } catch (e) { /* 回调里出的事由断言去抓 */ }
  }
  clock.now = end;
}
function useFakeClock() { globalThis.setInterval = fakeSetInterval; globalThis.clearInterval = fakeClearInterval; }
function useRealClock() { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; }

/* ---------------------------------------------------------------- 场景搭建 */
function boxStub(classes) {
  const set = {};
  (classes || []).forEach(c => { set[c] = 1; });
  return {
    className: 'ans-attach-ct',
    classList: {
      add(c) { set[c] = 1; }, remove(c) { delete set[c]; },
      contains(c) { return !!set[c]; }
    },
    _set: set
  };
}

/* 页面里得有这个菜单，否则 video.js 会认为「平台把倍速禁了」而退到 1x */
const RATE_MENU = '<div class="vjs-playback-rate"><ul class="vjs-menu-content"><li class="vjs-menu-item">2x</li></ul></div>';

function scene(html) {
  const { document, window } = parseHTML(html);
  def(window, 'location', { href: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' });
  /* ⚠ linkedom 的 window 是 Proxy，未知属性会落到 globalThis 上，
     所以 `window.self` 可能是上一段测试留下的别的对象 —— 必须强制覆盖。 */
  def(window, 'self', window);
  def(window, 'top', window);            /* 把本框架当顶层跑：徽标/面板由它建（v1.1.4 单例） */
  def(window, 'frameElement', undefined); /* 每个场景都清掉上一个场景留下的 iframe 父级 */
  def(globalThis, '__ftkRoot', window);
  def(globalThis, 'window', window);
  def(globalThis, 'document', document);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'video.js'), 'utf8'), { filename: 'video.js' });
  return { document, window, VK: window.FreeTikuVideo };
}

function fakeMedia(doc, tag, props) {
  const m = doc.createElement(tag || 'video');
  doc.body.appendChild(m);
  const handlers = {};
  const st = Object.assign({
    playbackRate: 1, muted: false, paused: true, ended: false,
    duration: 100, currentTime: 0, src: 'x.mp4'
  }, props || {});
  Object.keys(st).forEach(k => { m[k] = st[k]; });
  m.addEventListener = function (t, fn) { (handlers[t] = handlers[t] || []).push(fn); };
  m.fire = function (t) { (handlers[t] || []).slice().forEach(fn => fn({ type: t })); };
  m.plays = 0; m.pauses = 0;
  m.play = function () { m.plays++; m.paused = false; return Promise.resolve(); };
  m.pause = function () { m.pauses++; m.paused = true; };
  return m;
}

/* ================================================================ A. 纯函数 */
rawLog('\n=== A. detect / rateDisabled / clampRate / lockRate ===');

const a = scene('<!doctype html><html><body></body></html>');
ok('页面里没有媒体元素时 detect 返回 null', a.VK.detect(a.document) === null);

const m1 = fakeMedia(a.document, 'video');
ok('有 video 时 detect 认出 video', a.VK.detect(a.document).kind === 'video');

const b = scene('<!doctype html><html><body></body></html>');
fakeMedia(b.document, 'audio');
ok('只有 audio 时 detect 认出 audio', b.VK.detect(b.document).kind === 'audio');

ok('倍速菜单被删光 → rateDisabled 为真', (() => {
  const c = scene('<!doctype html><html><body></body></html>');
  return c.VK.rateDisabled(c.document) === true;
})());
ok('有倍速菜单 → rateDisabled 为假', (() => {
  const c = scene('<!doctype html><html><body><div class="vjs-playback-rate"><ul class="vjs-menu-content"><li class="vjs-menu-item">2x</li></ul></div></body></html>');
  return c.VK.rateDisabled(c.document) === false;
})());

ok('clampRate(0) → 2', a.VK.clampRate(0) === 2);
ok('clampRate(NaN) → 2', a.VK.clampRate(NaN) === 2);
ok('clampRate(100) → 16（封顶）', a.VK.clampRate(100) === 16);
ok('clampRate(0.2) → 0.5（保底）', a.VK.clampRate(0.2) === 0.5);
ok('clampRate(2) → 2', a.VK.clampRate(2) === 2);

const lock = scene('<!doctype html><html><body></body></html>');
const lm = fakeMedia(lock.document, 'video');
lock.VK.lockRate(lm, 4);
ok('lockRate 之后读到 4', lm.playbackRate === 4, String(lm.playbackRate));
lm.playbackRate = 1;                                     // 模拟超星想改回去
ok('超星改 playbackRate 改不动（还是 4）', lm.playbackRate === 4, String(lm.playbackRate));
lock.VK.unlockRate(lm);
lm.playbackRate = 1;
ok('unlockRate 之后可以正常改成 1', lm.playbackRate === 1, String(lm.playbackRate));

/* ================================================================ B. 任务点 */
rawLog('\n=== B. taskBox / isFinished / hideVideoQuiz ===');

const bb = scene('<!doctype html><html><body></body></html>');
const box = boxStub([]);
def(bb.window, 'frameElement', { parentElement: box });
ok('taskBox 从 window.frameElement 拿到容器', bb.VK.taskBox(bb.window) === box);
ok('没加 class 时 isFinished 为假', bb.VK.isFinished(box) === false);
box.classList.add('ans-job-finished');
ok('加上 .ans-job-finished 后 isFinished 为真', bb.VK.isFinished(box) === true);

/* 任务点归属：媒体自己或 iframe 父级链上要有 ans-attach-ct 等容器 */
const owned = scene('<!doctype html><html><body><div class="ans-attach-ct"><video></video></div></body></html>');
const ownedMedia = owned.document.querySelector('video');
const ownedBox = owned.document.querySelector('.ans-attach-ct');
ok('mediaTaskBox 从媒体祖先找到任务点容器', owned.VK.mediaTaskBox(owned.window, ownedMedia) === ownedBox);

const climb = scene('<!doctype html><html><body><div class="ans-attach-ct"><div id="wrap"></div></div></body></html>');
def(climb.window, 'frameElement', { parentElement: climb.document.getElementById('wrap') });
ok('taskBox 会从 iframe 父级往上找到真正的任务点',
  climb.VK.taskBox(climb.window) === climb.document.querySelector('.ans-attach-ct'));

const plain = scene('<!doctype html><html><body><audio></audio></body></html>');
ok('页面里裸挂的 audio 不算任务点', plain.VK.mediaTaskBox(plain.window, plain.document.querySelector('audio')) === null);

/* 音频没有 video.js 倍速菜单，不能误报「平台禁了倍速」 */
const audioRate = scene('<!doctype html><html><body></body></html>');
const audioMedia = fakeMedia(audioRate.document, 'audio');
const audioLogs = [];
audioRate.VK.drive(audioRate.document, { rate: 4, log: function (m) { audioLogs.push(m); } });
ok('音频不会因为找不到视频倍速菜单被压成 1x', audioMedia.playbackRate === 4, String(audioMedia.playbackRate));
ok('音频不会误报「倍速菜单被去掉」', !audioLogs.some(function (l) { return /倍速菜单去掉了/.test(l); }), audioLogs.join(' | '));
audioRate.VK.stop();

const qz = scene('<!doctype html><html><body><div class="ans-timelineobjects">题</div><div class="ans-timelineobjectsbg"></div></body></html>');
qz.VK.hideVideoQuiz(qz.document);
ok('视频弹题被隐藏', qz.document.querySelector('.ans-timelineobjects').style.display === 'none' &&
  qz.document.querySelector('.ans-timelineobjectsbg').style.display === 'none');

/* ================================================================ C. drive */
rawLog('\n=== C. drive：播放 / 倍速 / 收尾降速 / 重播 ===');

async function caseFinish() {
  const s = scene('<!doctype html><html><body>' + RATE_MENU + '</body></html>');
  const media = fakeMedia(s.document, 'video');
  const tbox = boxStub([]);
  def(s.window, 'frameElement', { parentElement: tbox });
  const logs = [];
  useFakeClock();
  const p = s.VK.drive(s.document, { rate: 4, log: (m) => logs.push(m) });
  media.fire('playing');
  ok('drive 开始播放', media.plays >= 1);
  ok('drive 把 muted 设成 true', media.muted === true);
  ok('drive 锁住了 4x', media.playbackRate === 4, String(media.playbackRate));

  media.duration = 100; media.currentTime = 95;
  media.fire('timeupdate');
  ok('最后 10 秒降回 1x', media.playbackRate === 1, String(media.playbackRate));
  ok('降速时记了日志', logs.some(l => /降回 1x/.test(l)), logs.join(' | '));

  tbox.classList.add('ans-job-finished');
  tick(6000);                                            // 看门狗轮询
  const r = await p;
  useRealClock();
  ok('任务点完成后 Promise 兑现 done=true', r.done === true, JSON.stringify(r));
  ok('完成时把播放暂停了', media.pauses >= 1);
}

async function caseReplay() {
  const s = scene('<!doctype html><html><body>' + RATE_MENU + '</body></html>');
  const media = fakeMedia(s.document, 'video');
  const tbox = boxStub([]);
  def(s.window, 'frameElement', { parentElement: tbox });
  const logs = [];
  useFakeClock();
  const p = s.VK.drive(s.document, { rate: 2, log: (m) => logs.push(m) });
  media.fire('playing');

  media.ended = true; media.fire('ended');
  tick(16000);
  ok('放完但任务点没完成 → 从头重播一次', media.currentTime === 0 && logs.some(l => /第 1 次从头重播/.test(l)),
    'currentTime=' + media.currentTime + ' | ' + logs.join(' | '));
  /* 锁已经被拆掉（不是读出 1）——真浏览器里拆掉后会回落到原生 setter */
  ok('重播时把倍速锁放开了（回到 1x）', Object.getOwnPropertyDescriptor(media, 'playbackRate') === undefined,
    String(Object.getOwnPropertyDescriptor(media, 'playbackRate')));

  media.ended = true; media.fire('ended');
  tick(16000);
  ok('第二次仍未完成 → 再重播一次', logs.some(l => /第 2 次从头重播/.test(l)));

  media.ended = true; media.fire('ended');
  tick(16000);
  const r = await p;
  useRealClock();
  ok('重播次数用尽 → 放弃并报原因', r.done === false && /重播/.test(r.why || ''), JSON.stringify(r));
}

async function caseSpeedForced1x() {
  const s = scene('<!doctype html><html><body><div class="vjs-playback-rate"><ul class="vjs-menu-content"></ul></div></body></html>');
  const media = fakeMedia(s.document, 'video');
  const tbox = boxStub([]);
  def(s.window, 'frameElement', { parentElement: tbox });
  const logs = [];
  useFakeClock();
  s.VK.drive(s.document, { rate: 8, log: (m) => logs.push(m) });
  media.fire('playing');
  useRealClock();
  ok('倍速被平台禁用时退到 1x', media.playbackRate === 1, String(media.playbackRate));
  ok('并且说明了原因', logs.some(l => /倍速菜单去掉了/.test(l)), logs.join(' | '));
}

/* ================================================================ D. 集成 */
rawLog('\n=== D. 装配：视频页要自动开跑、播完要往下翻 ===');

const HTML = `<!doctype html><html><head></head><body>
  <video></video>
  <form action="/mooc-ans/work/addStudentWorkNew" method="post"></form>
</body></html>`;

function caseBoot() {
  const env = parseHTML(HTML);
  const doc = env.document, win = env.window;
  def(win, 'location', { href: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' });
  const tbox = boxStub([]);
  def(win, 'frameElement', { parentElement: tbox });
  const g = globalThis;
  def(g, 'window', win); def(g, 'document', doc);
  def(g, 'location', win.location); def(g, 'unsafeWindow', win);
  def(g, '__ftkRoot', win);
  /* ⚠ 本框架要当成顶层框架，self/top 必须显式指回自己。
     linkedom 的 window 是 Proxy，未知属性会落到 globalThis 上，
     前面几段留下的 globalThis.top 会污染这里（症状：徽标建到了上一个环境的
     文档里，本页一个都没有）。所以 win 和 globalThis 两边都要写。 */
  def(win, 'self', win); def(win, 'top', win);
  def(g, 'self', win); def(g, 'top', win);
  delete g.GM_getValue; delete g.GM_setValue; delete g.GM_xmlhttpRequest;
  let saved = null;
  def(g, 'GM_setValue', function (k, v) { saved = saved || {}; saved[k] = v; });
  def(g, 'GM_getValue', function (k, d) { return (saved && saved[k] !== undefined) ? saved[k] : d; });
  /* v1.3.0：不按「一键启动」视频不应自己播，所以这里种好运行标记，
     测的是「用户按过启动之后」的行为。 */
  const sessStore = { ftk_run_v1: '1' };
  const sess = {
    getItem: (k) => (k in sessStore ? sessStore[k] : null),
    setItem: (k, v) => { sessStore[k] = String(v); },
    removeItem: (k) => { delete sessStore[k]; }
  };
  def(win, 'sessionStorage', sess);
  def(g, 'sessionStorage', sess);
  def(g, 'fetch', function () { return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }); });

  const lines = [];
  const origLog = console.log, origErr = console.error;
  console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); };
  console.error = function () { lines.push('[err] ' + Array.prototype.join.call(arguments, ' ')); };

  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'beacon.js'), 'utf8'), { filename: 'beacon.js' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'xframe.js'), 'utf8'), { filename: 'xframe.js' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'core.js'), 'utf8'), { filename: 'core.js' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8'), { filename: 'panel.js' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8'), { filename: 'chaoxing.js' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'pipeline.js'), 'utf8'), { filename: 'pipeline.js' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'video.js'), 'utf8'), { filename: 'video.js' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'main.js'), 'utf8'), { filename: 'main.js' });

  setTimeout(function () {
    console.log = origLog; console.error = origErr;
    const text = (doc.body && doc.body.textContent) || '';
    ok('视频页也挂出了徽标', !!doc.getElementById('ftk-badge'));
    ok('视频页也挂出了面板', !!doc.getElementById('ftk-panel'));
    ok('面板出现了「自动播放视频」勾选框', !!doc.getElementById('ftk-video'));
    ok('面板出现了「视频倍速」输入框', !!doc.getElementById('ftk-rate'));
    ok('日志说了这是视频任务点', /视频任务点/.test(text), lines.join(' | '));
    ok('日志说了开始自动播放', /开始自动播放/.test(text));
    ok('没有把它当成「不是测验页」直接翻走', !/这一页不是测验/.test(text), lines.join(' | '));

    rawLog('\n' + '='.repeat(58));
    rawLog(`  通过 ${pass} 项，失败 ${fail} 项`);
    rawLog('='.repeat(58));
    process.exit(fail ? 1 : 0);
  }, 1600);
}

(async function () {
  try {
    await caseFinish();
    await caseReplay();
    await caseSpeedForced1x();
  } catch (e) {
    rawLog('[异常] ' + ((e && e.stack) || e));
  }
  useRealClock();
  caseBoot();
})();