/* ============================================================================
 *  ui.test.js —— 徽标和面板必须是「全页面单例」（v1.1.5 跨框架通道版）
 *
 *  用户实测（m03109）：左下角叠了三个「免费题库」徽标，右边也叠了两个面板。
 *  原因：学习通一页里套了好几层同源 iframe（外层课程页 + 题目框 + 视频框），
 *  每一层都跑一遍脚本，每层都各自建了一个徽标 + 一个面板。
 *
 *  v1.1.5 的修法：不再靠 window 上的属性（篡改猴沙箱里各层不是同一个对象），
 *  改成在**顶层文档**里放一个隐藏登记表 `#ftk-xframe`，
 *  徽标 / 面板 / advance 服务都挂在登记表的 `__ftk` 上 —— 同源 iframe 共享 DOM，
 *  所以每一层都能读到同一份。谁先建谁 claim，别的层就不重复建。
 *
 *  这一份盯着：
 *    A. 单个顶层框架：一个徽标；点它建出面板、再点收起、再点展开
 *    B. 旧版本留在文档里的重复 DOM，会在建新的之前被清掉
 *    C. 子框架（题目框）不再自己冒徽标/面板，而且它的日志要写进顶层那个面板
 *    D. 一个既没题目也不是测验页的子框架同样不冒东西
 *    E. 空闲自动翻页：没题目的框架 + 开了流水线 -> 会去调外层的 advance 服务
 *
 *  ⚠ 测试环境的一个大坑（踩过，别再踩）：
 *     linkedom 的 `window` 是个 Proxy，**未知属性会落到 globalThis 上**，
 *     所以「两个 parseHTML 出来的 window」并不像真浏览器那样各有各的存储。
 *     这里给每个框架造一个**普通对象**当 root（只带 document/top/self/
 *     history/addEventListener/Event 这些脚本真正用到的成员），
 *     让「每一层各有各的 window」这件事能被真测出来。
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

function patchEnv(win) {
  try {
    const proto = win.Element && win.Element.prototype;
    if (proto) proto.getBoundingClientRect = function () {
      return { width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34 };
    };
  } catch (e) { /* ... */ }
  try { win.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; }; }
  catch (e) { /* ... */ }
  def(win, 'innerWidth', 1200);
  def(win, 'innerHeight', 800);
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

/* ---------------- 定时器全抓进桶里，由测试决定什么时候跑 ---------------- */
let timers = [];
function grabTimers() {
  timers = [];
  def(globalThis, 'setTimeout', function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; });
  def(globalThis, 'clearTimeout', function () { });
  def(globalThis, 'setInterval', function (fn, ms) { timers.push({ fn: fn, ms: ms, iv: true }); return timers.length; });
  def(globalThis, 'clearInterval', function () { });
}
/* 按登记顺序把一次性定时器跑掉（跑的过程中新登记的也接着跑），最多 limit 个 */
function flush(limit) {
  limit = limit || 80;
  let i = 0, ran = 0;
  while (i < timers.length && ran < limit) {
    const t = timers[i]; i++;
    if (!t || !t.fn || t.iv) continue;
    ran++;
    try { t.fn(); } catch (e) { rawLog('      [定时器抛异常] ' + ((e && e.message) || e)); }
  }
  return ran;
}
function runNamed(name) {
  let hit = 0;
  for (let i = 0; i < timers.length; i++) {
    const t = timers[i];
    if (t && t.fn && t.fn.name === name && !t.iv) { t.fn(); hit++; }
  }
  return hit;
}

/* --------------------------------- 页面 ---------------------------------- */
const PLAIN_HTML = `<!doctype html><html><body>
  <div id="mainid"><iframe id="iframe" src="/knowledge/cards"></iframe></div>
</body></html>`;

const PLAIN_WITH_JUNK = `<!doctype html><html><body>
  <div id="ftk-badge">旧的假徽标</div>
  <div id="ftk-panel">旧的假面板</div>
  <div id="ftk-badge">再一个</div>
  <div id="mainid"><iframe id="iframe" src="/knowledge/cards"></iframe></div>
</body></html>`;

const QUIZ_HTML = `<!doctype html><html><body>
  <form action="/mooc-ans/work/addStudentWorkNew" method="post">
    <input type="hidden" name="answerwqbid" value="Q1,Q2,">
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle"><span>1【单选题】机械波的形成需要什么？</span></div>
        <ul>
          <li><input type="radio" name="answerQ1" value="A">A 介质</li>
          <li><input type="radio" name="answerQ1" value="B">B 真空</li>
        </ul>
      </div>
    </div>
  </form>
</body></html>`;

const WORK_URL = 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=999';
const OUTER_URL = 'https://mooc2-ans.chaoxing.com/mycourse/studentstudy?chapterId=1&courseId=2&clazzid=3';

function makeStorage() {
  const m = Object.create(null);
  return {
    getItem: function (k) { return m[k] === undefined ? null : m[k]; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; },
    clear: function () { for (const k in m) delete m[k]; }
  };
}

/* 造一个「框架」：真 document 来自 linkedom，root 是本框架专属的普通对象 */
function makeFrame(html, topFrame, href) {
  const env = parseHTML(html);
  const document = env.document, window = env.window;
  patchEnv(window);
  window.Event = window.MouseEvent = SandboxEvent;

  const frame = {
    document: document,
    history: { pushState: function () { }, replaceState: function () { } },
    addEventListener: function () { }, removeEventListener: function () { },
    getComputedStyle: window.getComputedStyle,
    Event: SandboxEvent, MouseEvent: SandboxEvent,
    location: { href: href || OUTER_URL },
    localStorage: makeStorage(),
    sessionStorage: makeStorage()
  };
  frame.self = frame;
  frame.top = topFrame || frame;
  frame.window = frame;
  return { document: document, window: window, frame: frame, env: env };
}

const FILES = ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js',
  'pipeline.js', 'video.js', 'main.js'];

function load(f, settingsObj) {
  def(globalThis, '__ftkRoot', f.frame);
  def(globalThis, 'window', f.window);
  def(globalThis, 'document', f.document);
  def(globalThis, 'location', f.frame.location);
  def(globalThis, 'unsafeWindow', f.window);
  def(globalThis, 'Event', SandboxEvent);
  def(globalThis, 'MouseEvent', SandboxEvent);
  def(globalThis, 'self', f.frame);
  /* 源码里用的是裸 sessionStorage（= 页面的那个），这里必须跟着框架走，
     否则 Node 自己的全局 sessionStorage 顶上来，「一键启动」标记永远读不到。 */
  if (f.frame.sessionStorage) def(globalThis, 'sessionStorage', f.frame.sessionStorage);
  def(globalThis, 'top', f.frame.top);
  delete globalThis.GM_xmlhttpRequest;
  def(globalThis, 'GM_setValue', function () { });
  def(globalThis, 'GM_getValue', function (k, d) { return settingsObj === undefined ? d : settingsObj; });
  FILES.forEach(function (name) {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, name), 'utf8'), { filename: name });
  });
}

const badges = (f) => f.document.querySelectorAll('#ftk-badge').length;
const panels = (f) => f.document.querySelectorAll('#ftk-panel').length;
const logText = (f) => {
  const el = f.document.getElementById('ftk-log');
  return el ? el.textContent : '';
};
const regOf = (f) => f.document.getElementById('ftk-xframe');
const panelObj = (f) => {
  const el = f.document.getElementById('ftk-panel');
  return el ? el.__ftkObj : null;
};

/* ------------------------------------------------------------------ A */
rawLog('\n=== A. 单个顶层框架：一个徽标，点一下出面板、再点收起 ===');
const top1 = makeFrame(PLAIN_HTML, null, OUTER_URL);
{
  grabTimers();
  load(top1, { pipe: false });
  ok('加载时还没建徽标（等 boot）', badges(top1) === 0, '现在 ' + badges(top1) + ' 个');
  ok('定时器里排了 boot', runNamed('boot') > 0);
  ok('boot 之后恰好 1 个徽标', badges(top1) === 1, '现在 ' + badges(top1) + ' 个');
  ok('这页不是测验页，所以先不建面板', panels(top1) === 0, '现在 ' + panels(top1) + ' 个');
  ok('顶层文档里有跨框架登记表 #ftk-xframe', !!regOf(top1));
  ok('登记表是隐藏的（不占地方）', /display:\s*none/.test(regOf(top1).getAttribute('style') || ''));
  ok('徽标被登记进了登记表', !!regOf(top1).__ftk && !!regOf(top1).__ftk.badge);
  ok('徽标固定在左下角，不随滚动走',
    /position:fixed/.test((top1.document.getElementById('ftk-badge').getAttribute('style') || '')));

  top1.document.getElementById('ftk-badge').onclick();
  ok('点一下 -> 建出面板', panels(top1) === 1, '现在 ' + panels(top1) + ' 个');
  ok('面板默认可见', panelObj(top1) && panelObj(top1).isVisible() === true);
  ok('面板就是文档里那个 #ftk-panel',
    regOf(top1).__ftk.panel && regOf(top1).__ftk.panel.el === top1.document.getElementById('ftk-panel'));
  ok('面板带真按钮（不是个空壳）', !!top1.document.getElementById('ftk-run'));

  /* v1.3.1：视频「卡住放行」次数可配（以前 main.js 里写死 8） */
  const mw = top1.document.getElementById('ftk-mediawait');
  ok('面板有「视频卡住放行」输入框', !!mw);
  ok('默认是 8 次', mw && String(mw.value) === '8', mw && mw.value);
  if (mw) {
    mw.value = '12';
    mw.dispatchEvent(new SandboxEvent('change'));
    ok('改成 12 后写进 settings', panelObj(top1).settings.mediaWait === 12,
       String(panelObj(top1).settings.mediaWait));
    ok('values() 也返回 12', panelObj(top1).values().mediaWait === 12);
    mw.value = '0';
    mw.dispatchEvent(new SandboxEvent('change'));
    ok('填 0 会被夹到 1（不会变成「无限等」或负数）', panelObj(top1).settings.mediaWait === 1,
       String(panelObj(top1).settings.mediaWait));
  }

  top1.document.getElementById('ftk-badge').onclick();
  ok('再点一下 -> 面板收起', panelObj(top1).isVisible() === false);
  ok('收起只是隐藏，DOM 还在（不会越点越多）', panels(top1) === 1);

  top1.document.getElementById('ftk-badge').onclick();
  ok('第三下 -> 又展开', panelObj(top1).isVisible() === true);
  ok('连点三下也只有一个面板', panels(top1) === 1);
  ok('连点三下也只有一个徽标', badges(top1) === 1);
}

/* ------------------------------------------------------------------ B */
rawLog('\n=== B. 旧版本留下的重复 DOM 会被清掉 ===');
const top2 = makeFrame(PLAIN_WITH_JUNK, null, OUTER_URL);
{
  ok('动手前文档里确实有 2 个旧徽标 + 1 个旧面板',
    badges(top2) === 2 && panels(top2) === 1,
    '徽标 ' + badges(top2) + ' / 面板 ' + panels(top2));
  grabTimers();
  load(top2, { pipe: false });
  runNamed('boot');
  ok('建新徽标时把旧的清剩 1 个', badges(top2) === 1, '现在 ' + badges(top2) + ' 个');
  top2.document.getElementById('ftk-badge').onclick();
  ok('建新面板时把旧的清剩 1 个', panels(top2) === 1, '现在 ' + panels(top2) + ' 个');
  ok('留下的那个是新面板（带真实按钮）', !!top2.document.getElementById('ftk-run'));
  ok('旧的那个假徽标文字已经不在了',
    !/旧的假徽标/.test(top2.document.body.textContent),
    JSON.stringify(top2.document.body.textContent.slice(0, 60)));
}

/* ------------------------------------------------------------------ C */
rawLog('\n=== C. 子框架不再自己冒一个，日志写进顶层面板 ===');
{
  const sub = makeFrame(QUIZ_HTML, top1.frame, WORK_URL);
  grabTimers();
  load(sub, { pipe: false });
  ok('子框架里没有徽标', badges(sub) === 0, '现在 ' + badges(sub) + ' 个');
  ok('子框架里没有面板', panels(sub) === 0, '现在 ' + panels(sub) + ' 个');
  ok('子框架读到的登记表就是顶层那一个',
    !!sub.frame.FreeTikuX && sub.frame.FreeTikuX.regNode() === regOf(top1));
  ok('子框架读到的是同一个徽标对象',
    sub.frame.FreeTikuX.get('badge') === regOf(top1).__ftk.badge);

  const before = logText(top1);
  const hit = runNamed('boot');
  ok('子框架的 boot 跑过了', hit > 0);
  ok('跑完子框架里依然没有徽标', badges(sub) === 0, '现在 ' + badges(sub) + ' 个');
  ok('跑完子框架里依然没有面板', panels(sub) === 0, '现在 ' + panels(sub) + ' 个');
  ok('顶层那个徽标还在，且没有多出来', badges(top1) === 1, '徽标 ' + badges(top1) + ' 个');
  ok('顶层那个面板还在，且没有多出来', panels(top1) === 1, '面板 ' + panels(top1) + ' 个');
  ok('子框架的日志写进了顶层面板（顶层面板多了一行）',
    logText(top1).length > before.length,
    JSON.stringify(logText(top1).slice(-80)));
  ok('子框架自己文档里没有被写进日志框', sub.document.getElementById('ftk-log') === null);
}

/* ------------------------------------------------------------------ D */
rawLog('\n=== D. 空子框架（没题目、也不是测验页）同样不冒东西 ===');
{
  const sub2 = makeFrame(PLAIN_HTML, top1.frame, OUTER_URL);
  grabTimers();
  load(sub2, { pipe: false });
  runNamed('boot');
  ok('空子框架里没有徽标', badges(sub2) === 0, '现在 ' + badges(sub2) + ' 个');
  ok('空子框架里没有面板', panels(sub2) === 0, '现在 ' + panels(sub2) + ' 个');
  ok('整页始终只有顶层那一个徽标', badges(top1) === 1);
  ok('整页始终只有顶层那一个面板', panels(top1) === 1);
}

/* ------------------------------------------------------------------ E */
rawLog('\n=== E. 空闲自动翻页：没题 + 开了流水线 -> 调外层的 advance ===');
{
  const sub3 = makeFrame(PLAIN_HTML, top1.frame, 'https://mooc2-ans.chaoxing.com/mycourse/studentstudy?chapterId=77&courseId=2&clazzid=3');
  grabTimers();
  /* v1.3.0：没按「一键启动」就一律待命，所以这里种好运行标记 */
  sub3.frame.sessionStorage.setItem('ftk_run_v1', '1');
  load(sub3, { pipe: true, video: true, rate: 2 });
  /* 把外层登记表里的 advance 换成一个假服务，看它到底会不会被叫 */
  const reg = regOf(top1).__ftk;
  let asked = 0;
  reg.advance = {
    version: 'test',
    next: function () { asked++; return { ok: true, what: 'task', desc: '假装的下一个任务点' }; }
  };
  flush(120);
  ok('没题目 + 流水线 -> 真的去问外层要下一个任务点了', asked > 0, '被问了 ' + asked + ' 次');
  ok('子框架自己仍然没有冒徽标', badges(sub3) === 0, '现在 ' + badges(sub3) + ' 个');
  ok('也没有冒面板', panels(sub3) === 0, '现在 ' + panels(sub3) + ' 个');
  ok('日志里说明白了它在干什么',
    /没有可做的事/.test(logText(top1)),
    JSON.stringify(logText(top1).slice(-90)));
  /* 假的 advance 不要再被后面的段用到 */
  reg.advance = null;
}

rawLog('\n' + (fail ? '\u2717 ' : '\u2713 ') + 'ui: ' + pass + ' 通过 / ' + fail + ' 失败');
/* 直接退出：里面残留的定时器句柄会让进程挂住，断言已经打完了 */
process.exit(fail ? 1 : 0);