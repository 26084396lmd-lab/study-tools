/* ============================================================================
 *  font.test.js —— 加密字体这条链路的两头
 *
 *  A. chaoxing.js 能不能从页面里把加密字体的 base64 抠出来
 *     （学习通把它内嵌在 <style id="cxSecretStyle"> 里）
 *  B. main.js 点了「开始答题」之后，是不是真的先把文字送去桥还原、
 *     再拿还原后的文字去查题库（而不是拿乱码去查）
 *
 *  真·解密算法在 Python 侧，由 research/test_fontdecode.py 验证。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');

/* B 段会把 console.log 抢过去收集脚本日志，所以断言输出必须走这条原始通道 */
const rawLog = console.log.bind(console);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; rawLog('  \u2713 ' + name); }
  else { fail++; rawLog('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}

const STYLE_TEXT =
  "@font-face{font-family:'cxsecret';src:url('data:application/font-ttf;" +
  "charset=utf-8;base64,QUJDREVG') format('truetype');}";
const B64 = 'QUJDREVG';

function styleTag(doc) {
  const st = doc.createElement('style');
  st.id = 'cxSecretStyle';
  st.textContent = STYLE_TEXT;
  return st;
}

function def(obj, name, value) {
  try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
  catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
}

/* ---------------------------------------------------------------- A 段 */
console.log('\n=== A. chaoxing.js 从页面里抠加密字体 ===');

function loadChaoxing(html) {
  const { document, window } = parseHTML(html);
  def(window, 'location', { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork' });
  /* ⚠ linkedom 的 window 是 Proxy，未知属性会落到 globalThis 上，
     所以 `window.self` 可能是上一段测试留下的别的对象 —— 必须强制覆盖。 */
  def(window, 'self', window);
  def(window, 'top', window);            /* 把本框架当顶层跑：徽标/面板由它建（v1.1.4 单例） */
  def(globalThis, '__ftkRoot', window);
  def(globalThis, 'window', window);
  def(globalThis, 'document', document);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8'), { filename: 'chaoxing.js' });
  return { document, window, CX: window.FreeTikuChaoxing };
}

const a1 = loadChaoxing('<!doctype html><html><body><div class="TiMu" data="0"></div></body></html>');
ok('页面里没有 cxSecretStyle 时返回空串', a1.CX.fontData() === '', JSON.stringify(a1.CX.fontData()));

const a2 = loadChaoxing('<!doctype html><html><head></head><body><div class="TiMu" data="0"></div></body></html>');
a2.document.head.appendChild(styleTag(a2.document));
ok('有 cxSecretStyle 时抠出 base64', a2.CX.fontData() === B64, JSON.stringify(a2.CX.fontData()));

/* 题型在子框架里、字体嵌在子框架自己的文档里（学习通常见） */
const a3 = loadChaoxing('<!doctype html><html><body><div class="TiMu" data="0"></div></body></html>');
{
  const sub = a3.document.createElement('iframe');
  a3.document.body.appendChild(sub);
  /* linkedom 里 contentDocument 要自己造一个同源文档挂上去 */
  const inner = parseHTML('<!doctype html><html><head></head><body></body></html>');
  inner.document.head.appendChild(styleTag(inner.document));
  def(sub, 'contentDocument', inner.document);
}
ok('字体在子框架里也能找到', a3.CX.fontData() === B64, JSON.stringify(a3.CX.fontData()));

/* 字体在父框架（题目在 iframe、style 留在外层） */
const a4 = loadChaoxing('<!doctype html><html><body><div class="TiMu" data="0"></div></body></html>');
{
  const parentDoc = parseHTML('<!doctype html><html><head></head><body></body></html>').document;
  parentDoc.head.appendChild(styleTag(parentDoc));
  const parentWin = { document: parentDoc };
  parentWin.parent = parentWin;
  def(a4.window, 'parent', parentWin);
  def(a4.window, 'top', parentWin);
}
ok('字体在父框架里也能找到', a4.CX.fontData() === B64, JSON.stringify(a4.CX.fontData()));

/* ---------------------------------------------------------------- B 段 */
console.log('\n=== B. 点「开始答题」后：先还原文字，再查题库 ===');

const HTML = `<!doctype html><html><head></head><body>
  <form action="/mooc-ans/work/addStudentWorkNew" method="post">
    <input type="hidden" name="answerwqbid" value="Q1,">
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle"><span>1【单选题】幍幊“Humanity”幎幈词幋幉是在什么时期提出縨？</span></div>
        <ul>
          <li><input type="radio" name="answerQ1" value="A">A 幏幐幒时幑</li>
          <li><input type="radio" name="answerQ1" value="B">B 幏幓幖时幑</li>
        </ul>
      </div>
    </div>
    <a id="submitBtn" href="javascript:;">提交</a>
  </form>
</body></html>`;

const REAL_STEM = '人文“Humanity”这个词最早是在什么时期提出的？';
const REAL_OPTS = ['A 古希腊时期', 'B 古罗马时期'];

const env = parseHTML(HTML);
const doc = env.document, win = env.window;
doc.head.appendChild(styleTag(doc));
def(win, 'location', { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=1' });
/* ⚠ 强制覆盖 self：linkedom 的 window 是 Proxy，`self` 可能还留着上一段测试的对象，
   那样 `top === window` 而 `self !== window`，isTop() 算成 false，面板就不会在本框架里建。 */
def(win, 'self', win);
def(win, 'top', win);

/* Node 24 自带的全局 Event 的 eventPhase 是只读的，linkedom 的 dispatchEvent 会去写它
   → 跟 dom.test.js 一样，给这个沙箱换一个自己写的、字段可写的 Event */
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
    /* linkedom 的 dispatchEvent 会往这几个字段里写，缺一不可 */
    this._path = [];
    this.NONE = 0;
    this.CAPTURING_PHASE = 1;
    this.AT_TARGET = 2;
    this.BUBBLING_PHASE = 3;
  }
  stopPropagation() {}
  stopImmediatePropagation() {}
  preventDefault() { this.defaultPrevented = true; }
}
def(win, 'Event', SandboxEvent);
def(win, 'MouseEvent', SandboxEvent);
def(globalThis, 'Event', SandboxEvent);
def(globalThis, 'MouseEvent', SandboxEvent);

const g = globalThis;
def(g, 'window', win);
def(g, 'document', doc);
def(g, 'location', win.location);
def(g, 'unsafeWindow', win);
def(g, '__ftkRoot', win);
delete g.GM_getValue; delete g.GM_setValue; delete g.GM_xmlhttpRequest;

const seen = { decode: null, searched: [] };
const origLog = console.log, origErr = console.error;
const lines = [];

/* 没有 GM API 时 main.js 走 fetch；这里用假的 fetch 顶替，顺便记下发了什么 */
def(g, 'fetch', function (url, opt) {
  opt = opt || {};
  if (/\/decode/.test(url)) {
    const body = JSON.parse(opt.body);
    seen.decode = body;
    /* 模拟桥：把假字换成真字 */
    const out = body.texts.map(function (t) {
      if (/幍幊/.test(t)) return t.replace(/幍幊“Humanity”幎幈词幋幉是在什么时期提出縨？/, '人文“Humanity”这个词最早是在什么时期提出的？');
      return t.replace('幏幐幒时幑', '古希腊时期').replace('幏幓幖时幑', '古罗马时期');
    });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(
      JSON.stringify({ ok: true, texts: out, changed: 12, note: '字体 9 个字形' })) });
  }
  seen.searched.push(decodeURIComponent(url));
  /* 题库一律答不上来，这样不会走到填答案那步，测试只关心送出去的题干 */
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"code":-1}') });
});

console.log = function () { lines.push(Array.prototype.join.call(arguments, ' ')); };
console.error = function () { lines.push('[err] ' + Array.prototype.join.call(arguments, ' ')); };

try {
  ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js', 'pipeline.js', 'video.js', 'main.js'].forEach(function (f) {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
  });
} catch (e) {
  console.log = origLog; console.error = origErr;
  ok('模块加载没抛异常', false, String(e && e.message));
}

setTimeout(function () {
  const badge = doc.getElementById('ftk-badge');
  ok('徽标挂出来了', !!badge);
  const runBtn = doc.getElementById('ftk-run');
  ok('「开始答题」按钮在', !!runBtn);
  /* 「还原后第 1 题：…」走的是 panel.detail，不勾详细日志是看不见的 —— 这里勾上，
     顺便验证详细日志这条通道本身 */
  const detailBox = doc.getElementById('ftk-logdetail');
  ok('「详细日志」勾选框在', !!detailBox);
  if (detailBox) {
    detailBox.checked = true;
    detailBox.dispatchEvent(new win.Event('change', { bubbles: true }));
  }
  if (runBtn) runBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

  setTimeout(function () {
    console.log = origLog; console.error = origErr;
    const text = (doc.body && doc.body.textContent) || '';

    ok('点了开始答题后，确实先请求了 /decode', !!seen.decode,
       seen.decode ? '' : '根本没发 /decode');
    if (seen.decode) {
      ok('送过去的是页面上的乱码原文（而不是已经好的文字）',
         seen.decode.texts.some(function (t) { return /幍幊/.test(t); }));
      ok('送过去的选项也是乱码原文',
         seen.decode.texts.some(function (t) { return /幏幐幒时幑/.test(t); }));
      ok('字体 base64 一起送过去了', seen.decode.font === B64, JSON.stringify(seen.decode.font));
    }
    ok('面板日志报了「已还原 … 个加密字」', /已还原 \d+ 个加密字/.test(text),
       lines.filter(function (l) { return /还原/.test(l); }).join(' | '));
    ok('还原后第 1 题的题干是真文字', /还原后第 1 题：/.test(text) && text.indexOf(REAL_STEM) >= 0,
       '日志里没有 ' + REAL_STEM);
    ok('去查题库时用的是还原后的题干（不是乱码）',
       seen.searched.some(function (u) { return u.indexOf('人文') >= 0; }),
       seen.searched.slice(0, 2).join(' | '));
    ok('查题库时不再出现乱码字', !seen.searched.some(function (u) { return /幍幊|幏幐/.test(u); }),
       seen.searched.slice(0, 2).join(' | '));
    ok('选项也是还原后的（选项文本进了请求）',
       seen.searched.length > 0);

    rawLog('\n' + '='.repeat(58));
    rawLog(`  通过 ${pass} 项，失败 ${fail} 项`);
    rawLog('='.repeat(58));
    process.exit(fail ? 1 : 0);
  }, 3000);
}, 1500);