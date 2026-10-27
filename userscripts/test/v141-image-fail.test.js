/* ============================================================================
 * v141-image-fail.test.js —— 1.3.11 图片题视觉失败时仍拦下自动交卷
 *
 * 假桥明确报错（图片下载失败），确认：
 *   1. 不猜答案、不勾任何选项；
 *   2. 即使开了「自动交卷」也不交空白卷；
 *   3. 面板明确要求人工处理。
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

const HTML = `<!doctype html><html><head></head><body>
  <form action="/mooc-ans/work/addStudentWorkNew" method="post">
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle"><span>1【单选题】已知一平面简谐波的表达式为
          <img src="http://p.ananas.chaoxing.com/star3/origin/formula1.png">，则：</span></div>
        <ul>
          <li><input type="radio" name="answerQ1" value="A"><a class="after">波的频率为
            <img src="http://p.ananas.chaoxing.com/star3/origin/formula2.png"></a></li>
          <li><input type="radio" name="answerQ1" value="B"><a class="after">
            <img src="http://p.ananas.chaoxing.com/star3/origin/formula3.png"></a></li>
        </ul>
      </div>
    </div>
    <a id="submitBtn" href="javascript:;">提交</a>
  </form>
</body></html>`;

const env = parseHTML(HTML);
const doc = env.document, win = env.window;
def(win, 'location', { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=140' });
def(win, 'self', win);
def(win, 'top', win);
try {
  win.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34 };
  };
} catch (e) { /* ... */ }
win.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };

class SandboxEvent {
  constructor(type, init) {
    init = init || {};
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.eventPhase = 0;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this._path = [];
  }
  stopPropagation() {}
  stopImmediatePropagation() {}
  preventDefault() { this.defaultPrevented = true; }
}
def(win, 'Event', SandboxEvent);
def(win, 'MouseEvent', SandboxEvent);
def(globalThis, 'Event', SandboxEvent);
def(globalThis, 'MouseEvent', SandboxEvent);

const store = {
  ftk_settings_v1: JSON.stringify({ auto: true, ai: true, baidu: true, icodef: true })
};
function fakeStorage() {
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
}
def(globalThis, 'localStorage', fakeStorage());
def(globalThis, 'sessionStorage', fakeStorage());
def(win, 'localStorage', globalThis.localStorage);
def(win, 'sessionStorage', globalThis.sessionStorage);

const g = globalThis;
def(g, 'window', win);
def(g, 'document', doc);
def(g, 'location', win.location);
def(g, 'unsafeWindow', win);
def(g, '__ftkRoot', win);
delete g.GM_getValue;
delete g.GM_setValue;
delete g.GM_xmlhttpRequest;

const seen = { vision: null, search: [], submitted: 0 };
const submitBtn = doc.getElementById('submitBtn');
submitBtn.addEventListener('click', function (ev) {
  /* 脚本自动点提交也会走到这里；记录一下，证明图片题也走了自动交卷 */
  seen.submitted++;
  try { ev.preventDefault(); } catch (e) { /* ... */ }
});

const origLog = console.log, origErr = console.error;
const lines = [];
console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); };
console.error = function () { lines.push('[err] ' + Array.prototype.join.call(arguments, ' ')); };

def(g, 'fetch', function (url, opt) {
  if (/\/ai\/ask/.test(url)) {
    seen.vision = JSON.parse(opt.body);
    return Promise.resolve({
      ok: true, status: 200,
      text: function () {
        return Promise.resolve(JSON.stringify({ ok: false, error: '图片下载失败' }));
      }
    });
  }
  if (/\/decode/.test(url)) {
    return Promise.resolve({
      ok: true, status: 200,
      text: function () { return Promise.resolve(JSON.stringify({ ok: true, texts: [], changed: 0 })); }
    });
  }
  /* 图片题不应该再走百度/GO题文本搜索；只记这两类，/trace /ping 不算。
     真走了就记下来让断言失败。 */
  if (/easylearn\.baidu\.com|q\.icodef\.com|\/adapter-service\/search/.test(url)) {
    seen.search.push(decodeURIComponent(url));
  }
  return Promise.resolve({
    ok: true, status: 200,
    text: function () { return Promise.resolve('{"code":-1}'); }
  });
});

try {
  ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js', 'pipeline.js', 'video.js', 'main.js'].forEach(function (f) {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
  });
} catch (e) {
  console.log = origLog; console.error = origErr;
  ok('模块加载没抛异常', false, String(e && e.message));
}

setTimeout(function () {
  const runBtn = doc.getElementById('ftk-run');
  ok('「一键启动」按钮在', !!runBtn);
  if (runBtn) runBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  setTimeout(function () {
    console.log = origLog; console.error = origErr;
    const text = (doc.body && doc.body.textContent) || '';
    const body = seen.vision || {};

    ok('图片题确实请求了视觉接口', !!seen.vision);
    ok('请求带上了题干和选项的图片', Array.isArray(body.images) && body.images.length === 3,
       body.images ? JSON.stringify(body.images.map(function (x) { return x.url; })) : 'none');
    ok('请求带上了卷面真实字母', JSON.stringify(body.optionLetters) === '["A","B"]',
       JSON.stringify(body.optionLetters));
    ok('题干图片排在选项图片前面',
       body.images && /formula1/.test(body.images[0].url) &&
       /formula2/.test(body.images[1].url) && /formula3/.test(body.images[2].url),
       JSON.stringify((body.images || []).map(function (x) { return x.url; })));
    ok('图片题没有再走百度/GO题文本搜索', seen.search.length === 0,
       seen.search.slice(0, 2).join(' | '));
    ok('视觉失败没有猜 B', !doc.querySelector('input[name="answerQ1"][value="B"]').checked);
    ok('视觉失败没有猜 A', !doc.querySelector('input[name="answerQ1"][value="A"]').checked);
    ok('视觉失败绝不自动交卷', seen.submitted === 0, 'submitted=' + seen.submitted);
    ok('面板明确说明没读出公式', /视觉模型也没读出这道题的公式/.test(text));
    ok('面板明确说明已停下等人工处理', /图片公式没识别出来，已停下等你手动处理/.test(text));

    rawLog('\n' + '='.repeat(58));
    rawLog(`  通过 ${pass} 项，失败 ${fail} 项`);
    rawLog('='.repeat(58));
    process.exit(fail ? 1 : 0);
  }, 3000);
}, 1200);
