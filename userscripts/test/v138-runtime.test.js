/* v1.3.9 绿色视频现场回归：已完成任务点不重播，启动后必须走下一节。 */
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
  else { fail++; rawLog('  \u2717 ' + name + (extra ? '   <<< ' + extra : '')); }
}
function def(obj, name, value) {
  try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
  catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function greenVideoPage() {
  const env = parseHTML(`<!doctype html><html><body>
    <div class="ans-attach-ct ans-job-finished"><iframe></iframe></div>
    <video></video>
    <a id="prevNextFocusNext" href="javascript:void(0)">下一节</a>
  </body></html>`);
  const doc = env.document, win = env.window;
  try {
    win.Element.prototype.getBoundingClientRect = function () {
      return { width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
    };
    win.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };
  } catch (e) { /* ... */ }

  const media = doc.querySelector('video');
  let plays = 0, nextClicks = 0;
  media.play = function () { plays++; return Promise.resolve(); };
  media.pause = function () { };
  def(media, 'duration', { get: () => 600, configurable: true });
  def(media, 'currentTime', { get: () => 600, set: () => { }, configurable: true });
  def(media, 'ended', { get: () => true, configurable: true });
  def(media, 'paused', { get: () => true, configurable: true });
  def(media, 'readyState', { get: () => 4, configurable: true });

  const tbox = doc.querySelector('.ans-attach-ct');
  def(win, 'frameElement', { parentElement: tbox, isConnected: true });
  def(win, 'location', { href: 'https://mooc1.chaoxing.com/ananas/modules/video/index.html' });
  const next = doc.querySelector('#prevNextFocusNext');
  next.addEventListener('click', () => { nextClicks++; });

  const g = globalThis;
  def(g, 'window', win); def(g, 'document', doc);
  def(g, 'location', win.location); def(g, 'unsafeWindow', win);
  def(g, '__ftkRoot', win);
  def(g, 'navigator', { userAgent: 'node-test' });
  def(win, 'self', win); def(win, 'top', win);
  def(g, 'self', win); def(g, 'top', win);

  const store = {};
  const sess = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  def(win, 'sessionStorage', sess); def(g, 'sessionStorage', sess);
  def(win, 'localStorage', sess); def(g, 'localStorage', sess);

  def(g, 'GM_getValue', function (k, d) {
    return k === 'ftk_settings_v1' ? { pipe: true, video: true, rate: 2, mediaWait: 8 } : d;
  });
  def(g, 'GM_setValue', function () { });
  delete g.GM_xmlhttpRequest;
  def(g, 'fetch', function () { return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }); });

  return { doc, win, media, tbox, store, plays: () => plays, nextClicks: () => nextClicks };
}

function loadAll() {
  ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js',
    'pipeline.js', 'video.js', 'main.js'].forEach((name) => {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, name), 'utf8'), { filename: name });
  });
}

(async function () {
  const origLog = console.log, origErr = console.error;
  const lines = [];
  console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); };
  console.error = function () { lines.push('[err] ' + Array.prototype.join.call(arguments, ' ')); };
  try {
    rawLog('\n=== 绿色视频现场 ===');
    const p = greenVideoPage();
    loadAll();
    await wait(1100);
    const panel = p.doc.getElementById('ftk-panel');
    ok('面板出来了', !!panel);
    ok('绿色任务点没有被重新播放', p.plays() === 0, 'play()=' + p.plays());
    ok('面板说明视频已完成、等待启动', /已完成/.test(panel ? panel.textContent : ''), panel ? panel.textContent.slice(0, 180) : '');

    const btn = p.doc.getElementById('ftk-run');
    ok('启动按钮存在', !!btn);
    /* 模拟上一节 iframe 导航时留下的 goNext 锁：释放定时器已经跟着旧
       框架死掉，新页面在锁过期前不能直接躺平。1.3.9 必须重试到锁过期。 */
    try {
      const reg = p.doc.getElementById('ftk-xframe');
      if (reg) {
        reg.__ftk = reg.__ftk || { panel: null, badge: null, advance: null, ctls: {}, order: [], lock: {} };
        reg.__ftk.lock = reg.__ftk.lock || {};
        reg.__ftk.lock.goNext = { id: 'dead-frame', at: Date.now() };
      }
    } catch (eLock) { /* ... */ }
    if (btn) {
      const E = p.win.MouseEvent || p.win.Event;
      btn.dispatchEvent(new E('click', { bubbles: true }));
    }
    /* 锁 TTL 5 秒 + 1.8 秒重试，留足时间 */
    await wait(6500);
    ok('启动后仍然没有重播已完成视频', p.plays() === 0, 'play()=' + p.plays());
    ok('旧翻页锁占着也会重试到下一节', p.nextClicks() > 0, 'nextClicks=' + p.nextClicks());
    ok('日志写了视频任务点已完成', /视频任务点已完成/.test(lines.join('\n')) || /视频任务点已完成/.test(panel ? panel.textContent : ''));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  rawLog('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
