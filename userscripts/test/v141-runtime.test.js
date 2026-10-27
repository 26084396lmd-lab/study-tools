/* v1.3.11 runtime regression: empty / reading pages must auto-advance. */
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
  else { fail++; rawLog('  \u2717 ' + name + (extra ? '   <<< ' + extra : '')); }
}
function def(obj, name, value) {
  try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
  catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function readingPage() {
  const env = parseHTML(`<!doctype html><html><body>
    <div class="tabtags">
      <span>1 前测题</span><span>2 视频</span><span>3 后测题</span>
      <span>4 应用拓展</span><span class="current">5 扩展阅读</span>
    </div>
    <div class="reading-body">扩展阅读：声波的应用</div>
    <a id="prevNextFocusNext" href="javascript:void(0)">下一节</a>
  </body></html>`);
  const doc = env.document, win = env.window;
  win.Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
  };
  win.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };

  let nextClicks = 0;
  const next = doc.querySelector('#prevNextFocusNext');
  next.addEventListener('click', () => { nextClicks++; });

  def(win, 'location', { href: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&courseid=2&knowledgeid=1242885263&num=4' });
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

  return { doc, win, store, nextClicks: () => nextClicks };
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
    rawLog('\n=== 扩展阅读空页：启动后自动下一节 ===');
    const p = readingPage();
    loadAll();
    await wait(1100);
    const panel = p.doc.getElementById('ftk-panel');
    ok('面板出来了', !!panel);
    ok('识别到扩展阅读页', /扩展阅读/.test(panel ? panel.textContent : ''), panel ? panel.textContent.slice(0, 240) : '');
    const btn = p.doc.getElementById('ftk-run');
    ok('启动按钮存在', !!btn);
    if (btn) {
      const E = p.win.MouseEvent || p.win.Event;
      btn.dispatchEvent(new E('click', { bubbles: true }));
    }
    await wait(3500);
    ok('扩展阅读页会自动点「下一节」', p.nextClicks() > 0, 'nextClicks=' + p.nextClicks());
    ok('日志写明自动下一节', /下一节|不在这一页/.test(lines.join('\n')) || /下一节/.test(panel ? panel.textContent : ''));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  rawLog('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
