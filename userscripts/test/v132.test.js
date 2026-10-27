/* ============================================================================
 *  v132.test.js —— 「点停止」必须真的把视频按住（v1.3.2）
 *
 *  用户实测（2026-10-21 截图）：面板已经显示「已全部停止」，视频还在播；
 *  手动点暂停，过一会儿又被脚本按回播放。
 *
 *  两个真实成因：
 *    A. video.js 的 pause 监听没有「用户停止」这道闸：stop() 里 media.pause()
 *       触发 pause 事件 -> 监听立刻 resume() -> 视频又动起来。
 *    B. 面板住在最外层，视频在子 iframe 里；onStop 只调了本层 VK.stop()，
 *       再 dispatch('stop') 只挑一个框架，视频那一层可能根本收不到。
 *       现在改成 ctlEach('stop') 广播到每一层。
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

/* ---------------------------------------------------------------- 假时钟 */
const clock = { now: 0, seq: 0, timers: {} };
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
function fakeSetInterval(fn, ms) { const id = ++clock.seq; clock.timers[id] = { fn, ms: ms || 1, next: clock.now + (ms || 1) }; return id; }
function fakeClearInterval(id) { delete clock.timers[id]; }
function useFakeClock() { globalThis.setInterval = fakeSetInterval; globalThis.clearInterval = fakeClearInterval; }
function useRealClock() { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; }

const RATE_MENU = '<div class="vjs-playback-rate"><ul class="vjs-menu-content"><li class="vjs-menu-item">2x</li></ul></div>';

function scene() {
  const { document, window } = parseHTML('<!doctype html><html><body>' + RATE_MENU + '<video></video></body></html>');
  def(window, 'location', { href: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' });
  def(window, 'self', window);
  def(window, 'top', window);
  def(globalThis, '__ftkRoot', window);
  def(globalThis, 'window', window);
  def(globalThis, 'document', document);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'video.js'), 'utf8'), { filename: 'video.js' });
  return { document, window, VK: window.FreeTikuVideo };
}

function fakeMedia(doc) {
  const m = doc.querySelector('video');
  const handlers = {};
  m.playbackRate = 1; m.muted = false; m.paused = true; m.ended = false;
  m.duration = 100; m.currentTime = 0;
  m.addEventListener = function (t, fn) { (handlers[t] = handlers[t] || []).push(fn); };
  m.fire = function (t) { (handlers[t] || []).slice().forEach(fn => fn({ type: t })); };
  m.plays = 0; m.pauses = 0;
  m.play = function () { m.plays++; m.paused = false; m.fire('playing'); return Promise.resolve(); };
  m.pause = function () { m.pauses++; m.paused = true; m.fire('pause'); };
  return m;
}

/* ==================================================== A. 停止后必须真的停 */
async function sectionA() {
  rawLog('\n=== A. video.js：停止后 pause 事件不能再把视频按回播放 ===');
  useFakeClock();
  const s = scene();
  const media = fakeMedia(s.document);
  let result = null;
  const p = s.VK.drive(s.document, { rate: 2, log: function () { } });
  p.then(function (r) { result = r; });

  ok('启动后进入了播放状态', s.VK.status().running === true);
  ok('启动时确实调了 play', media.plays >= 1, String(media.plays));
  ok('倍速被锁成 2x', media.playbackRate === 2, String(media.playbackRate));

  s.VK.stop();
  await Promise.resolve();
  await Promise.resolve();

  ok('stop() 之后 running=false', s.VK.status().running === false);
  ok('stop() 之后 paused=true', media.paused === true);
  ok('stop() 之后至少 pause 过一次', media.pauses >= 1, String(media.pauses));
  ok('stop() 会把还在 await 的 drive() 兑现掉', result && result.done === false,
    JSON.stringify(result));
  ok('兑现的理由写的是「用户停止」', result && /用户停止/.test(result.why || ''), result && result.why);

  const playsAfterStop = media.plays;
  media.fire('pause');                       // 学习通/浏览器补发的 pause 事件
  await Promise.resolve();
  ok('停止后再收到 pause 事件，不会偷偷 resume', media.plays === playsAfterStop,
    'plays=' + media.plays + ' after=' + playsAfterStop);

  /* 手动暂停：再点一次播放器，然后点暂停 —— 脚本不能再抢回去 */
  media.play();
  const playsAfterManual = media.plays;
  media.pause();
  media.fire('pause');
  await Promise.resolve();
  ok('停止后手动播放/暂停，脚本不再抢控制权', media.plays === playsAfterManual,
    'plays=' + media.plays + ' after=' + playsAfterManual);

  /* 停止时已经 unlockRate，用户手动调倍速应该能改 */
  media.playbackRate = 1.5;
  ok('停止后倍速锁已放开（手动调倍速有效）', media.playbackRate === 1.5, String(media.playbackRate));

  /* 再启动：stopped 标记要复位，否则视频永远起不来 */
  const p2 = s.VK.drive(s.document, { rate: 1, log: function () { } });
  ok('停止后再次启动，能重新开播', media.plays > playsAfterManual, String(media.plays));
  ok('再次启动后 stopped 复位（running=true）', s.VK.status().running === true);
  s.VK.stop();
  await p2;

  useRealClock();
}

/* ============================================ B. 构建产物：停止要广播 */
function sectionB() {
  rawLog('\n=== B. 构建产物：停止走 ctlEach 广播，且 video.js 有 stopped 闸 ===');
  const dist = fs.readFileSync(DIST, 'utf8');
  ok('onStop 调用 stopLocal', /stopLocal\('用户停止'\)/.test(dist));
  ok('onStop 用 ctlEach(\'stop\') 广播到每一层', /ctlEach\('stop'\)/.test(dist));
  ok('每个框架的 stop 控制器会真的停视频',
    /stop:\s*function\s*\(arg\)\s*\{\s*stopLocal\(\(arg && arg\.why\) \|\| '用户停止'/.test(dist));
  ok('命令轮询收到 stop 也走 stopLocal', /cmd === 'stop'\)\s*\{\s*stopLocal\('用户停止'\)/.test(dist));
  ok('video.js 的 pause 监听受 stopped 保护', /state\.stopped \|\| media\.ended \|\| isResolved/.test(dist));
  ok('video.js 的 resume 受 stopped 保护', /if \(state\.stopped \|\| hasEnded \|\| isResolved \|\| isResuming\) return;/.test(dist));
  ok('video.js 的 stop 会放开倍速锁', /unlockRate\(state\.media\)/.test(dist));
  ok('媒体未完成检查同时认 video 和 audio', /querySelectorAll\('video, audio'\)/.test(dist));
  ok('「视频卡住放行」次数从设置读，不再写死 8',
    /settings\.mediaWait/.test(dist) && !/idleDone\[_mk\] <= 8/.test(dist));
}

(async function () {
  await sectionA();
  sectionB();
  rawLog('\n================  v132.test.js  ' + pass + ' 通过 / ' + fail + ' 失败  ================');
  process.exit(fail ? 1 : 0);
})();
