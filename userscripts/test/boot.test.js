/* ============================================================================
 *  boot.test.js —— 在 linkedom 造的「学习通章节测验」页面里，
 *  真的把 core.js + panel.js + chaoxing.js + main.js 依次执行一遍，
 *  检查引导逻辑有没有把东西挂到页面上（尤其那个必现的绿点徽标）。
 *
 *  这补的是之前测试的盲区：core/chaoxing 都有测试，main.js 没人跑过。
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

/* --- 一份能过 chaoxing.js 解析器的章节测验页 --- */
const HTML = `<!doctype html><html><body>
  <form action="/mooc-ans/work/addStudentWorkNew" method="post">
    <input type="hidden" name="answerwqbid" value="Q1,Q2,">
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="2">
        <div class="Zy_TItle"><span>1【填空题】Rise is a unique crop because it can grow well in wet ____.</span></div>
        <textarea name="answerQ1"></textarea>
      </div>
    </div>
    <div class="singleQuesId" data="Q2">
      <div class="TiMu" data="2">
        <div class="Zy_TItle"><span>2【填空题】The scientists are developing a flood-resistant rice ____.</span></div>
        <textarea name="answerQ2"></textarea>
      </div>
    </div>
    <a id="submitBtn" href="javascript:;">提交</a>
  </form>
</body></html>`;

function boot() {
  const { document, window } = parseHTML(HTML);

  /* linkedom 的窗口对象不完整，补上脚本会用到的东西 */
  const loc = { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=999' };
  try { Object.defineProperty(window, 'location', { value: loc, configurable: true }); } catch (e) { /* 补不上就算了 */ }
  if (!window.self) { try { window.self = window; } catch (e) { /* ... */ } }
  /* 这一份把当前框架当成「顶层框架」来跑：徽标和面板由顶层建。
     v1.1.4 起徽标/面板是全页面单例，子框架不再自己冒一个
     （那条路子在 test/ui.test.js 里单独盯着）。
     学习通真实页面里最外层课程页一样会跑这个脚本，所以徽标一定有人建。 */
  try { window.top = window; } catch (e) { /* ... */ }
  try { window.localStorage; } catch (e) { /* 没有就没有，脚本里有 try/catch */ }

  /* Node 24 的 globalThis 上 location/window 之类是只读的，用 defineProperty 硬塞 */
  function def(obj, name, value) {
    try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
    catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
  }

  const g = globalThis;
  def(g, 'window', window);
  def(g, 'document', document);
  def(g, 'location', loc);
  def(g, 'unsafeWindow', window);
  /* 1.0.4 起四个模块统一挂到 __ftkRoot（构建器提供）。测试里也走同一条路，
     否则测的还是老那套「core 挂 globalThis、其他读 unsafeWindow」的不一致装配。 */
  def(g, '__ftkRoot', window);
  delete g.GM_getValue;                    // 模拟「没有 GM 存储 API」的降级路径
  delete g.GM_setValue;
  delete g.GM_xmlhttpRequest;
  g.confirm = () => true;

  const errors = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); };
  const origLog = console.log;
  console.log = () => { };                 // 别把脚本自己的日志混进测试输出

  try {
    ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js', 'pipeline.js', 'video.js', 'main.js'].forEach((f) => {
      const code = fs.readFileSync(path.join(SRC, f), 'utf8');
      vm.runInThisContext(code, { filename: f });
    });
  } catch (e) {
    console.log = origLog; console.error = origError;
    return { document, window, errors, thrown: e };
  }
  console.log = origLog; console.error = origError;
  return { document, window, errors, thrown: null };
}

console.log('\n=== 模块加载与引导（真跑 main.js） ===');

const env = boot();
ok('4 个模块执行时没有抛异常', !env.thrown, env.thrown ? String(env.thrown && env.thrown.message) : '');
ok('core 挂到了共享对象上', !!(env.window && env.window.FreeTikuCore));
ok('chaoxing 挂上了', !!(env.window && env.window.FreeTikuChaoxing));
ok('panel 挂上了', !!(env.window && env.window.FreeTikuPanel));
ok('main 没有打 console.error', env.errors.length === 0, env.errors.join(' | '));

/* main.js 是 setTimeout(boot, 800) 起来的，等它一下 */
setTimeout(() => {
  const d = env.document;
  const badge = d.getElementById('ftk-badge');
  const panelEl = d.querySelector('[id^="ftk"], .ftk-panel');
  ok('页面上出现了常驻绿点徽标 #ftk-badge', !!badge,
     badge ? '' : '这就是「没有绿点」的复现！');
  if (badge) {
    ok('徽标文字含「免费题库」', /免费题库/.test(badge.textContent || ''));
    ok('徽标有 onclick', typeof badge.onclick === 'function');
  }
  ok('题目解析到了 2 题（说明页面 fixture 有效）', env.window.FreeTikuChaoxing.extractQuestions().length === 2);
  ok('面板也挂出来了', !!panelEl);
  ok('本框架是顶层框架，徽标就挂在它上面', env.window.top === env.window.self && !!badge,
     'top===self? ' + (env.window.top === env.window.self));

  /* ---- 换章节：学习通是 AJAX，URL 变、页面不重新加载、题目被换掉 ----
     期望 watchAjax() 的兜底把旧面板拆掉、按新题目重建一个。
     watchAjax 在 2500ms 装上、setInterval 每 3000ms 兜一次，所以下面等到 6800ms。 */
  const form = d.querySelector('form');
  form.innerHTML =
    '<input type="hidden" name="answerwqbid" value="Q7,Q8,Q9,">' +
    [7, 8, 9].map((n) =>
      '<div class="singleQuesId" data="Q' + n + '">' +
      '<div class="TiMu" data="2">' +
      '<div class="Zy_TItle"><span>' + n + '【填空题】换章节之后的第 ' + n + ' 题 ____</span></div>' +
      '<textarea name="answerQ' + n + '"></textarea></div></div>').join('') +
    '<a id="submitBtn" href="javascript:;">提交</a>';

  setTimeout(() => {
    const txt = (d.body && d.body.textContent) || '';
    ok('AJAX 换章节后解析到 3 题', env.window.FreeTikuChaoxing.extractQuestions().length === 3,
       '实际 ' + env.window.FreeTikuChaoxing.extractQuestions().length);
    ok('面板被自动重建（日志里出现「共 3 题」）', /共 3 题/.test(txt));
    ok('徽标没有堆出重复的', d.querySelectorAll('#ftk-badge').length === 1,
       '实际 ' + d.querySelectorAll('#ftk-badge').length);
    /* 注意：面板日志里也有一句「点『开始答题』即可」，所以不能按文本数，只能按按钮 id 数 */
    ok('旧面板已经被拆掉，页面上只剩一个「开始答题」按钮',
       d.querySelectorAll('#ftk-run').length === 1,
       '实际 ' + d.querySelectorAll('#ftk-run').length + ' 个按钮');

    console.log('\n' + '='.repeat(58));
    console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
    console.log('='.repeat(58));
    process.exit(fail ? 1 : 0);
  }, 5400);
}, 1400);