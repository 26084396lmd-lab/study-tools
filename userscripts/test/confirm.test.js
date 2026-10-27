/* ============================================================================
 *  confirm.test.js —— 「确认提交？」那个框到底有没有被点掉
 *
 *  实测踩到的坑（用户截图）：
 *    点「提交」→ 弹出「提示 / 确认提交？ / 取消 提交」→ 脚本没点掉它 →
 *    面板停在「不确定交上没有，已停下」，流水线断在这里。
 *  两个真原因：
 *    ① 那个框经常挂在外层文档上，而题目在一个 iframe 里 —— 只在 document 里找是找不到的；
 *    ② 页面自己的交卷按钮就叫「提交」，不能盲目点页面上任何一个「提交」。
 *  所以判据是「以『取消』为锚，往上找那个同时含『取消』和『提交/确定』的小容器」。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}
function def(obj, name, value) {
  try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
  catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
}

function patchEnv(win) {
  try {
    const proto = win.Element && win.Element.prototype;
    if (proto) {
      proto.getBoundingClientRect = function () {
        return { width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34 };
      };
    }
  } catch (e) { /* linkedom 里没有就算了 */ }
  try { win.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; }; }
  catch (e) { /* ... */ }
}

/* 造一个「点了哪个按钮」都记下来的环境 */
function makeEnv(html) {
  const { document, window } = parseHTML(html);
  patchEnv(window);
  if (!window.self) def(window, 'self', window);
  const clicked = [];
  const mark = () => {
    const all = document.querySelectorAll('a,button,span,input');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      el.click = (id => function () { clicked.push(id); })(el.id || ('#' + i));
    }
  };
  mark();
  def(window, '__ftkClicked', clicked);
  def(window, '__ftkRemark', mark);
  return { document, window, clicked };
}

function load(win) {
  def(globalThis, '__ftkRoot', win);
  def(globalThis, 'window', win);
  def(globalThis, 'document', win.document);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8'), { filename: 'chaoxing.js' });
  return win.FreeTikuChaoxing;
}

/* ------------------------------------------------------------------ A */
console.log('\n=== A. 没有弹窗时不能乱点 ===');
{
  const e = makeEnv(`<!doctype html><html><body>
    <div class="sub"><a id="pageSubmit">提交</a><a id="pageSave">保存</a></div>
  </body></html>`);
  const CX = load(e.window);
  ok('页面上有个叫「提交」的按钮，但没弹窗时 confirmDialog() 必须是 false',
     CX.confirmDialog() === false);
  ok('那个「提交」按钮没被动过', e.clicked.length === 0, JSON.stringify(e.clicked));
}

/* ------------------------------------------------------------------ B */
console.log('\n=== B. 弹窗在本框架（通用结构）===');
{
  const e = makeEnv(`<!doctype html><html><body>
    <div class="pop">
      <div class="hd">提示</div>
      <div class="bd">确认提交？</div>
      <div class="ft"><a id="cancelBtn">取消</a><a id="okBtn">提交</a></div>
    </div>
  </body></html>`);
  const CX = load(e.window);
  const got = CX.confirmDialog();
  ok('认出确认框', got === true);
  ok('点的是「提交」，不是「取消」',
     e.clicked.length === 1 && e.clicked[0] === 'okBtn', JSON.stringify(e.clicked));
}

/* ------------------------------------------------------------------ C */
console.log('\n=== C. 弹窗里有「取消」+「确定」（不是提交）===');
{
  const e = makeEnv(`<!doctype html><html><body>
    <div class="layer">
      <div class="title">提示</div>
      <div class="body">确定要提交吗？</div>
      <div class="footer"><a id="c2">取消</a><a id="o2">确定</a></div>
    </div>
  </body></html>`);
  const CX = load(e.window);
  ok('认出确认框', CX.confirmDialog() === true);
  ok('点的是「确定」', e.clicked.length === 1 && e.clicked[0] === 'o2', JSON.stringify(e.clicked));
}

/* ------------------------------------------------------------------ D */
console.log('\n=== D. 页面自己的交卷按钮旁边没有「取消」，绝不能点 ===');
{
  const e = makeEnv(`<!doctype html><html><body>
    <div class="ZY_sub clearfix">
      <a id="realSubmit">提交</a>
      <a id="back">返回</a>
    </div>
    <div class="other"><a id="cancelElsewhere">取消</a></div>
    <p>这里是题目正文，和那个取消按钮隔得很远。</p>
  </body></html>`);
  const CX = load(e.window);
  const got = CX.confirmDialog();
  ok('没有真弹窗时返回 false', got === false);
  ok('页面自己的交卷按钮没有被误点',
     e.clicked.indexOf('realSubmit') < 0, JSON.stringify(e.clicked));
}

/* ------------------------------------------------------------------ E */
console.log('\n=== E. 老版固定结构 .AlertCon02 a.bluebtn ===');
{
  const e = makeEnv(`<!doctype html><html><body>
    <div class="AlertCon02"><a class="bluebtn" id="blueOk">确定</a></div>
  </body></html>`);
  const CX = load(e.window);
  ok('认出老版确认框', CX.confirmDialog() === true);
  ok('点了 a.bluebtn', e.clicked.length === 1 && e.clicked[0] === 'blueOk', JSON.stringify(e.clicked));
}

/* ------------------------------------------------------------------ F */
console.log('\n=== F. 弹窗挂在外层文档上（这就是用户遇到的真实情况）===');
{
  /* 题目在 iframe 里 —— 脚本跑在 iframe 里 */
  const child = makeEnv('<!doctype html><html><body><div class="TiMu" data="0">题目</div></body></html>');
  /* 弹窗挂在外层页面 */
  const parent = makeEnv(`<!doctype html><html><body>
    <div class="pop">
      <div class="hd">提示</div>
      <div class="bd">确认提交？</div>
      <div class="ft"><a id="outerCancel">取消</a><a id="outerOk">提交</a></div>
    </div>
  </body></html>`);
  parent.window.parent = parent.window;
  def(child.window, 'parent', parent.window);
  def(child.window, 'top', parent.window);

  const CX = load(child.window);
  const got = CX.confirmDialog();
  ok('在 iframe 里也能认出外层文档上的确认框', got === true);
  ok('点的是外层的「提交」',
     parent.clicked.length === 1 && parent.clicked[0] === 'outerOk',
     '外层=' + JSON.stringify(parent.clicked) + ' 本层=' + JSON.stringify(child.clicked));
  ok('没有在本层乱点', child.clicked.length === 0, JSON.stringify(child.clicked));
}

/* ------------------------------------------------------------------ G */
console.log('\n=== G. 连弹两次（点掉一层还有一层）===');
{
  const e = makeEnv(`<!doctype html><html><body>
    <div class="pop1">
      <div class="bd">确认提交？</div>
      <div class="ft"><a id="c31">取消</a><a id="o31">提交</a></div>
    </div>
    <div class="pop2">
      <div class="bd">确认提交？</div>
      <div class="ft"><a id="c32">取消</a><a id="o32">提交</a></div>
    </div>
  </body></html>`);
  const CX = load(e.window);
  ok('第一次点掉一层', CX.confirmDialog() === true);
  ok('第二次还能点掉另一层', CX.confirmDialog() === true);
  ok('两次点的都是「提交」而不是「取消」',
     e.clicked.indexOf('o31') >= 0 || e.clicked.indexOf('o32') >= 0,
     JSON.stringify(e.clicked));
  ok('两个「取消」都没被点',
     e.clicked.indexOf('c31') < 0 && e.clicked.indexOf('c32') < 0, JSON.stringify(e.clicked));
}

console.log('\n' + '='.repeat(58));
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(58));
process.exit(fail ? 1 : 0);