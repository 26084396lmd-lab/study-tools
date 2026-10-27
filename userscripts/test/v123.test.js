/* ============================================================================
 *  v123.test.js —— 答案链路 + 「视频任务点绿了却停住」（v1.2.3）
 *
 *  两条真实报障：
 *    ① 用户截图：视频停在 9:50/10:56，左上角「任务点已完成」，
 *       面板却说「这一节的视频还在放，放完自己会往下走」→ 永远停在这一页。
 *    ② 子代理审计：答案「不增加」+ 选项「增加/不增加」会两个都命中，
 *       单选逐项点击以最后点的为准 → 直接选反；多选把否定项一起勾。
 *
 *  A 组测 core 的命中逻辑，B 组测 chaoxing 的解析，C 组盯构建产物里的关键改动。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', '学习小助手.user.js');

let pass = 0, fail = 0;
const rawLog = console.log.bind(console);
function ok(cond, label, extra) {
  if (cond) { pass++; rawLog('  \u2713 ' + label); }
  else { fail++; rawLog('  \u2717 ' + label + (extra ? '   <<< ' + extra : '')); }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label,
    'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

class SandboxEvent {
  constructor(t, o) {
    this.type = t; this.bubbles = !!(o && o.bubbles); this.eventPhase = 0;
    this.target = null; this.currentTarget = null; this._path = [];
  }
  stopPropagation() { } stopImmediatePropagation() { } preventDefault() { }
}

function scene(html) {
  const env = parseHTML(html);
  const win = env.window, doc = env.document;
  try {
    const proto = win.Element && win.Element.prototype;
    if (proto) proto.getBoundingClientRect = function () {
      return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
    };
  } catch (e) { /* ... */ }
  win.getComputedStyle = win.getComputedStyle || function () {
    return { display: 'block', visibility: 'visible' };
  };
  win.Event = win.MouseEvent = SandboxEvent;
  globalThis.Event = SandboxEvent;
  globalThis.MouseEvent = SandboxEvent;
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.unsafeWindow = win;
  globalThis.__ftkRoot = win;
  globalThis.getComputedStyle = win.getComputedStyle;
  globalThis.location = { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=1' };
  ['core.js', 'chaoxing.js'].forEach(function (f) {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
  });
  return { win: win, doc: doc, C: win.FreeTikuCore, CX: win.FreeTikuChaoxing };
}

/* ------------------------------------------------------------------ A 组 */
rawLog('\n=== A. 答案命中：否定项不能被顺走 ===');
{
  const s = scene('<!doctype html><html><body></body></html>');
  const C = s.C;
  ok(!!C, 'FreeTikuCore 加载了');

  const one = (ans, opts, type) => C.buildResponse(
    { question: 'q', options: opts.map(function (t, i) { return String.fromCharCode(65 + i) + '. ' + t; }), type: type == null ? 0 : type },
    [ans], []).answer;

  let r = one('\u4e0d\u589e\u52a0', ['\u589e\u52a0', '\u4e0d\u589e\u52a0'], 0);
  eq(r.answerKeyText, 'B', '答案「不增加」只勾「不增加」这一项（不把「增加」也勾上）');
  eq(r.answerKey, ['B'], '字母也只有 B');

  r = one('\u589e\u52a0', ['\u589e\u52a0', '\u4e0d\u589e\u52a0'], 0);
  eq(r.answerKeyText, 'A', '答案「增加」只勾「增加」，不会连「不增加」一起选');

  r = one('\u4e0d\u76f8\u7b49', ['\u76f8\u7b49', '\u4e0d\u76f8\u7b49'], 0);
  eq(r.answerKeyText, 'B', '「不相等」只勾「不相等」');

  r = one('\u4e0d\u80fd\u786e\u5b9a', ['\u786e\u5b9a', '\u4e0d\u80fd\u786e\u5b9a'], 0);
  eq(r.answerKeyText, 'B', '「不能确定」只勾「不能确定」');

  /* 多选：两个真的都该选时不能被否定保护误伤 */
  const multi = C.buildResponse(
    { question: 'q', options: ['A. 增加', 'B. 不增加', 'C. 不变'], type: 1 },
    ['增加', '不变'], []).answer;
  eq(multi.answerKeyText, 'AC', '多选仍然能勾两个（否定保护不会把正常的多选砍成一个）');

  /* 单选命中两个时只留完全相等的那个 */
  const cap = C.buildResponse(
    { question: 'q', options: ['A. 增加', 'B. 总能量增加'], type: 0 },
    ['总能量增加'], []).answer;
  eq(cap.answerKeyText, 'B', '单选命中多个 -> 留完全相等的那个');
  ok(cap.answerKeyText.length === 1, '单选永远只有一个字母');
}

/* ------------------------------------------------------------------ B 组 */
rawLog('\n=== B. 解析：复合题不漏、题干里的 ul 不抢选项、多空都填上 ===');
{
  const html = `<!doctype html><html><body>
  <div class="singleQuesId" data="Q1">
    <div class="TiMu" data="0">
      <div class="Zy_TItle"><span>1【单选题】第一小题的题干</span></div>
      <ul>
        <li><input type="radio" name="answerQ1" value="A">A 甲</li>
        <li><input type="radio" name="answerQ1" value="B">B 乙</li>
      </ul>
    </div>
    <div class="TiMu" data="0">
      <div class="Zy_TItle"><span>2【单选题】第二小题的题干</span></div>
      <ul>
        <li><input type="radio" name="answerQ1_2" value="A">A 丙</li>
        <li><input type="radio" name="answerQ1_2" value="B">B 丁</li>
      </ul>
    </div>
  </div>
  <div class="singleQuesId" data="Q2">
    <div class="TiMu" data="0">
      <div class="Zy_TItle">
        <span>3【单选题】材料题的题干</span>
        <ul><li>要点一</li><li>要点二</li></ul>
      </div>
      <ul>
        <li><input type="radio" name="answerQ2" value="A">A 方案甲</li>
        <li><input type="radio" name="answerQ2" value="B">B 方案乙</li>
        <li><input type="radio" name="answerQ2" value="C">C 方案丙</li>
      </ul>
    </div>
  </div>
  <div class="singleQuesId" data="Q3">
    <div class="TiMu" data="2">
      <div class="Zy_TItle"><span>4【填空题】城市______，省份______。</span></div>
      <textarea name="answerQ3_1" rows="2"></textarea>
      <textarea name="answerQ3_2" rows="2"></textarea>
    </div>
  </div>
</body></html>`;
  const s = scene(html);
  const CX = s.CX;
  const qs = CX.extractQuestions ? CX.extractQuestions() : CX.extractQuestions();

  ok(qs.length === 4, '一个 .singleQuesId 里的两个 .TiMu 各算一题', '实际 ' + qs.length + ' 题');
  ok(qs.some(function (q) { return /第二小题/.test(q.stem); }), '第二小题没有被吞掉',
    qs.map(function (q) { return q.stem; }).join(' | '));

  const material = qs.filter(function (q) { return /材料题/.test(q.stem); })[0];
  ok(!!material, '材料题取到了');
  if (material) {
    eq(material.options.length, 3, '材料题 3 个选项（题干里的 ul 没有被当成选项）');
    eq(material.options.map(function (o) { return o.letter; }), ['A', 'B', 'C'], '字母从 A 开始，没有错位');
  }

  const blank = qs.filter(function (q) { return q.type === 'completion'; })[0];
  ok(!!blank, '填空题取到了');
  ok(blank && blank.textareas && blank.textareas.length === 2, '填空题有 2 个空',
    'textareas=' + (blank && blank.textareas ? blank.textareas.length : 'n/a'));

  if (blank) {
    const res = CX.apply(blank, { answer: { bestAnswer: ['\u5317\u4eac', '\u4e0a\u6d77'], answerKeyText: '' } }, {});
    ok(res.applied === true, 'apply 报成功', JSON.stringify(res));
    eq(blank.textareas[0].value, '\u5317\u4eac', '第一空 = 北京');
    eq(blank.textareas[1].value, '\u4e0a\u6d77', '第二空 = 上海（不是把「北京#上海」整串塞第一个）');
  }
}

/* ------------------------------------------------------------------ C 组 */
rawLog('\n=== C. 构建产物里那几个关键改动还在 ===');
{
  const dist = fs.readFileSync(DIST, 'utf8');
  ok(/function docTaskDone/.test(dist), '任务点已完成的文档不再拿 video 拦翻页');
  ok(/!isFinite\(dur\)/.test(dist), 'duration 是 Infinity/NaN 时不作判据');
  ok(/settings\.mediaWait/.test(dist), '媒体拦翻页的放行次数可配（v1.3.2 起不再写死 8）');
  ok(/VK\.stop\(why \|\| '用户停止'\)/.test(dist), '按「停止」真的会停视频（每一层都会收到）');
  ok(/settings\.pipe && \(stopFlag \|\| isPaused\(\)\)/.test(dist), '按了停止就不自动交卷');
  ok(/PL\.dismissUnfinished/.test(dist), '点「下一节」之后补两刀去点弹窗');
  ok(/claim\('goNext'/.test(dist), 'goNext 跨框架互斥');
  ok(/LOCK_TTL/.test(dist), 'idleAdvance 的锁会过期（iframe 重载不会把锁留死）');
  ok(/@version\s+1\.3\.12/.test(dist), '版本号是 1.3.12');
  ok(/var VERSION = '1\.3\.12'/.test(dist), '徽标 / beacon 的版本号与 @version 同步');
}

rawLog('\n----------------------------------------');
rawLog((fail ? '\u274c' : '\u2705') + ' v123 结果：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);