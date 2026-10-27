/* v1.3.11 runtime regression: AJAX switch to an empty reading tab must boot
 * again even though qsig() is empty and the panel already exists. */
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

function page() {
  const env = parseHTML(`<!doctype html><html><body>
    <div id="tabtags" class="tabtags">
      <span>1 前测题</span><span>2 视频</span><span class="current">3 后测题</span>
      <span>4 应用拓展</span><span>5 扩展阅读</span>
    </div>
    <div id="content">
      <form action="/mooc-ans/work/addStudentWorkNew" method="post">
        <input type="hidden" name="answerwqbid" value="Q1,">
        <div class="singleQuesId" data="Q1">
          <div class="TiMu" data="2">
            <div class="Zy_TItle"><span>1【填空题】已经填过的题</span></div>
            <textarea name="answerQ1">done</textarea>
          </div>
        </div>
        <a id="submitBtn" href="javascript:;">提交</a>
      </form>
    </div>
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

  const loc = { href: 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&courseid=2&knowledgeid=1242885263&num=2' };
  def(win, 'location', loc);
  const g = globalThis;
  def(g, 'window', win); def(g, 'document', doc);
  def(g, 'location', loc); def(g, 'unsafeWindow', win);
  def(g, '__ftkRoot', win);
  def(g, 'navigator', { userAgent: 'node-test' });
  def(win, 'self', win); def(win, 'top', win);
  def(g, 'self', win); def(g, 'top', win);

  const store = { ftk_run_v1: '1' };
  const sess = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  def(win, 'sessionStorage', sess); def(g, 'sessionStorage', sess);
  def(win, 'localStorage', sess); def(g, 'localStorage', sess);

  def(g, 'GM_getValue', function (k, d) {
    return k === 'ftk_settings_v1' ? { pipe: true, video: true, rate: 2, mediaWait: 8, auto: false } : d;
  });
  def(g, 'GM_setValue', function () { });
  delete g.GM_xmlhttpRequest;
  def(g, 'fetch', function () { return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') }); });

  return { doc, win, loc, nextClicks: () => nextClicks };
}

function loadAll() {
  ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js',
    'pipeline.js', 'video.js', 'main.js'].forEach((name) => {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, name), 'utf8'), { filename: name });
  });
}

function switchToReading(p) {
  p.loc.href = 'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?clazzid=1&courseid=2&knowledgeid=1242885263&num=4';
  p.doc.querySelector('#tabtags .current').classList.remove('current');
  const tabs = p.doc.querySelectorAll('#tabtags span');
  tabs[tabs.length - 1].classList.add('current');
  p.doc.getElementById('content').innerHTML = '<div class="reading-body">扩展阅读：声波的应用</div>';
}

(async function () {
  const origLog = console.log, origErr = console.error;
  const lines = [];
  console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); };
  console.error = function () { lines.push('[err] ' + Array.prototype.join.call(arguments, ' ')); };
  try {
    rawLog('\n=== AJAX 切到扩展阅读页：qsig 为空也要重新 boot ===');
    const p = page();
    loadAll();
    await wait(3600);                       // 初始题目 boot + 自动 run + watchAjax 启动
    const panel = p.doc.getElementById('ftk-panel');
    ok('初始题目页有面板', !!panel);
    ok('初始题目页没有点下一节', p.nextClicks() === 0, 'nextClicks=' + p.nextClicks());

    switchToReading(p);
    await wait(6000);                       // rebootstrap 3s + boot + idle 0.5s
    ok('切到扩展阅读页后会点「下一节」', p.nextClicks() > 0, 'nextClicks=' + p.nextClicks());
    ok('日志记录重新识别了扩展阅读页', /扩展阅读/.test(lines.join('\n')), lines.slice(-8).join(' / '));
    ok('页面没动会补点而不是躺平', /再试一次/.test(lines.join('\n')), lines.slice(-8).join(' / '));
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  rawLog('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})();
