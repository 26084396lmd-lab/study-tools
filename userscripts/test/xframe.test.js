/* ============================================================================
 *  xframe.test.js —— 跨框架通道（把 DOM 节点当共享内存）
 *
 *  为什么要有它：1.1.4 及以前，徽标/面板/advance 服务都靠 window 上的属性共享。
 *  篡改猴带 @grant 时 window 是沙箱对象，各层不是同一个对象 ——
 *  子框架永远读不到外层面板（日志被吞），外层面板按钮绑在没有题目的那层
 *  （点了没反应）。1.1.5 改成在顶层文档里放一个隐藏登记表，
 *  这里就盯着那张登记表的行为。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const XFRAME = fs.readFileSync(path.join(SRC, 'xframe.js'), 'utf8');

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

const HTML = '<!doctype html><html><head></head><body><div id="mainid"></div></body></html>';
const FRAMESET_HTML = '<!doctype html><html><head></head><frameset><frame src="/a"></frameset></html>';

/* 造一个「框架」：真 document 来自 linkedom，root 是本框架专属的普通对象 */
function makeFrame(html, topFrame) {
  const env = parseHTML(html);
  const frame = {
    document: env.document,
    history: { pushState: function () { }, replaceState: function () { } },
    addEventListener: function () { }, removeEventListener: function () { },
    location: { href: 'https://mooc1.chaoxing.com/x' }
  };
  frame.self = frame;
  frame.top = topFrame || frame;
  return frame;
}

/* 每个「框架」跑一遍 xframe.js，得到各自那一层的 API */
function api(f) {
  def(globalThis, '__ftkRoot', f);
  vm.runInThisContext(XFRAME, { filename: 'xframe.js' });
  return f.FreeTikuX;
}

/* ------------------------------------------------------------------ A */
rawLog('\n=== A. 登记表：建一次、藏在顶层、每层读到的是同一个节点 ===');
const topA = makeFrame(HTML, null);
const subA1 = makeFrame(HTML, topA);
const subA2 = makeFrame(HTML, topA);
const xTop = api(topA), x1 = api(subA1), x2 = api(subA2);
{
  ok('还没人问的时候，文档里没有登记表', !topA.document.getElementById('ftk-xframe'));
  const n = xTop.regNode();
  ok('regNode() 建出了节点', !!n);
  ok('id 就是 ftk-xframe', n && n.id === 'ftk-xframe');
  ok('挂在顶层文档的 body 里', topA.document.body.contains(n));
  ok('是隐藏的（不占地方、不挡点击）', /display:\s*none/.test(n.getAttribute('style') || ''));
  ok('反复调用返回同一个节点', xTop.regNode() === n);
  ok('子框架拿到的也是同一个节点（这就是跨框架共享的关键）', x1.regNode() === n && x2.regNode() === n);
  ok('登记表上有一份共享槽位（panel/badge/advance/ctls/lock）',
    n.__ftk && 'panel' in n.__ftk && 'badge' in n.__ftk && 'advance' in n.__ftk &&
    !!n.__ftk.ctls && !!n.__ftk.lock);
  ok('每一层的 ID 各不相同', xTop.ID !== x1.ID && x1.ID !== x2.ID);
  ok('isTop() 只有顶层那层为真', xTop.isTop() === true && x1.isTop() === false);
  ok('子框架的 topDoc() 指向顶层文档', x1.topDoc() === topA.document);
  ok('每一层的 home() 都是顶层文档（UI 只在顶层建）',
    xTop.home() === topA.document && x1.home() === topA.document);
}

/* ------------------------------------------------------------------ B */
rawLog('\n=== B. set / get：对象和 DOM 节点都能跨层共享 ===');
{
  const box = topA.document.createElement('div');
  const plain = { hello: 'world', log: function () { } };
  xTop.set('badge', box);
  xTop.set('advance', plain);
  ok('子框架读到了顶层塞进去的 DOM 节点', x1.get('badge') === box);
  ok('子框架读到了顶层塞进去的普通对象', x1.get('advance') === plain);
  ok('反过来也行：子框架塞，顶层读', (function () {
    const o = { from: 'sub' };
    x1.set('panel', o);
    return xTop.get('panel') === o;
  })());
  ok('没塞过的键读出来是 null', xTop.get('nothing-here') === null);
  /* 后面几段要用干净的槽位 */
  xTop.set('badge', null); xTop.set('advance', null); xTop.set('panel', null);
}

/* ------------------------------------------------------------------ C */
rawLog('\n=== C. claim / release：只准一层的抢到「我来建」 ===');
{
  ok('第一层抢 badge 抢到了', xTop.claim('badge') === true);
  ok('同一层再抢一次抢不到（已经在建了）', xTop.claim('badge') === false);
  ok('别的框架也抢不到', x1.claim('badge') === false && x2.claim('badge') === false);
  xTop.release('badge');
  ok('release 之后别的框架抢得到', x1.claim('badge') === true);
  ok('这时原来那层反而抢不到了', xTop.claim('badge') === false);
  x1.release('badge');
  /* 已经建好并写进槽位之后，谁都抢不到 */
  xTop.set('panel', { el: null });
  ok('槽位里已经有东西了，谁都 claim 不到（不会重复建）', xTop.claim('panel') === false && x1.claim('panel') === false);
  xTop.set('panel', null);
}

/* ------------------------------------------------------------------ D */
rawLog('\n=== D. 控制器登记表：面板上的按钮要点到「真正有活干的那一层」 ===');
{
  let topRun = 0, subRun = 0, subStop = 0;
  xTop.ctlRegister({
    hasWork: function () { return false; },      /* 顶层课程页：没题目 */
    busy: false,
    run: function () { topRun++; }
  });
  x1.ctlRegister({
    hasWork: function () { return true; },       /* 题目框：有活 */
    busy: function () { return false; },
    run: function () { subRun++; },
    stop: function () { subStop++; }
  });
  ok('有活的那层会被认出来 ctlHasWork()', xTop.ctlHasWork() === true);
  ok('顶层调 ctlPick 会挑到子框架那个（它有活）', xTop.ctlPick('any', true).id === x1.ID);
  ok('顶层 ctlDispatch(run) 打到了子框架，而不是自己', (function () {
    const r = xTop.ctlDispatch('run');
    return r === true && subRun === 1 && topRun === 0;
  })());
  ok('子框架 dispatch 时不会派回自己（skipSelf）', (function () {
    const before = subRun;
    const r = x1.ctlDispatch('run');
    return r === true && topRun === 1 && subRun === before;
  })());
  ok('ctlBusy() 一开始是 0', x1.ctlBusy() === 0);
  x1.ctlUpdate({ busy: true });
  ok('标了忙之后 ctlBusy() 变成 1', x1.ctlBusy() === 1);
  x1.ctlUpdate({ busy: false });
  ok('忙完又回到 0', x1.ctlBusy() === 0);
  ok('找不到命令对应的函数时返回 false', x1.ctlDispatch('no-such-cmd') === false);
  x1.ctlRegister({ hasWork: function () { return true; }, dead: true, run: function () { } });
  ok('登记过的控制器不会重复进队列', x1.ctlPick('any', true) !== null);
  x1.ctlUpdate({ dead: true });
  ok('标记 dead 之后就不再被挑中', (function () {
    const c = xTop.ctlPick('any', true);
    return !c || c.id !== x1.ID;
  })());
}

/* ------------------------------------------------------------------ E */
rawLog('\n=== E. home()：顶层塞不下时（frameset）只让一个子框架顶上 ===');
{
  const fsTop = makeFrame(FRAMESET_HTML, null);
  def(fsTop.document, 'body', null);            /* 模拟 frameset 页面：没有 body */
  const c1 = makeFrame(HTML, fsTop);
  const c2 = makeFrame(HTML, fsTop);
  const xf = api(fsTop), y1 = api(c1), y2 = api(c2);
  ok('frameset 顶层自己承载不了 UI', xf.canHost(fsTop.document) === false);
  ok('frameset 顶层自己也不建', xf.home() === null);
  ok('第一个子框架顶上（挂在自己文档里）', y1.home() === c1.document);
  ok('第二个子框架不顶（不重复）', y2.home() === null);
  ok('顶上的那个会在顶层 documentElement 上留个记号',
    fsTop.document.documentElement.__ftkHome === y1.ID);
  ok('登记表仍然放在顶层文档里', y1.regNode() === fsTop.document.getElementById('ftk-xframe'));
}

/* ------------------------------------------------------------------ F */
rawLog('\n=== F. frames()：诊断用，能数清树里有几层 ===');
{
  const fTop = makeFrame(HTML, null);
  const fSub = makeFrame(HTML, fTop);
  fTop.document.getElementById('mainid').appendChild(
    (function () { const fr = fTop.document.createElement('iframe'); return fr; })());
  const xf = api(fTop);
  /* linkedom 不会真的把 contentWindow 接上，所以这里只验证「不炸」和至少数到自己 */
  const list = xf.frames();
  ok('frames() 不会抛异常', Array.isArray(list));
  ok('至少数到了自己这一层', list.length >= 1 && list[0].win === fTop);
  ok('子框架对象本身可用（不是靠 frames() 才拿得到）', api(fSub).isTop() === false);
}

rawLog('\n' + (fail ? '\u2717 ' : '\u2713 ') + 'xframe: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exitCode = 1;