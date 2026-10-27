/* ============================================================================
 * v139.test.js —— 1.3.9 现场回归
 *
 * 用户 2026-10-23 反馈：
 *   A. 「做过的题全对又做了一遍」：结果页的隐藏失败模板 / disabled textarea
 *      不能再被当成答题页。
 *   B. 「图片公式题 AI 找不到答案」：关键公式在图片里时，要直接停下手动处理，
 *      不要拿「波的频率为［式］」去问 AI。
 *   C. 「视频绿了不翻页 / 点启动视频不播」：翻页锁要短、抢不到要重试；
 *      已完成标记必须属于当前任务点，不能拿整页任意绿标凑数。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist', '学习小助手.user.js');

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
    if (proto) proto.getBoundingClientRect = function () {
      return { width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34 };
    };
  } catch (e) { /* ... */ }
  try { win.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; }; }
  catch (e) { /* ... */ }
}
function loadCX(html) {
  const { document, window } = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
  patchEnv(window);
  def(globalThis, '__ftkRoot', window);
  def(globalThis, 'window', window);
  def(globalThis, 'document', document);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8'), { filename: 'chaoxing.js' });
  return window.FreeTikuChaoxing;
}

function scene(html) {
  const { document, window } = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
  patchEnv(window);
  def(globalThis, '__ftkRoot', window);
  def(globalThis, 'window', window);
  def(globalThis, 'document', document);
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8'), { filename: 'chaoxing.js' });
  return window.FreeTikuChaoxing;
}

const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const cxSrc = fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8');
const videoSrc = fs.readFileSync(path.join(SRC, 'video.js'), 'utf8');
const panelSrc = fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8');
const dist = fs.readFileSync(DIST, 'utf8');

console.log('\n=== A. 图片公式题：提取公式图，交给视觉识别（失败仍停下） ===');
{
  const html =
    '<div class="singleQuesId" data="Q1"><div class="TiMu" data="0">' +
      '<div class="Zy_TItle"><span>已知一平面简谐波的表达式为 ' +
        '<img src="http://p.ananas.chaoxing.com/star3/origin/formula1.png">' +
      '，则：</span></div>' +
      '<ul>' +
        '<li><input type="radio" name="answerQ1" value="A"><a class="after">波的频率为 ' +
          '<img src="http://p.ananas.chaoxing.com/star3/origin/formula2.png"></a></li>' +
        '<li><input type="radio" name="answerQ1" value="B"><a class="after">波的周期为 ' +
          '<img src="http://p.ananas.chaoxing.com/star3/origin/formula3.png"></a></li>' +
      '</ul>' +
    '</div></div>';
  const CX = scene(html);
  const qs = CX.extractQuestions();
  ok('题目解析出来了', qs.length === 1, 'n=' + qs.length);
  const q = qs[0];
  ok('题干/选项里有读不到的公式图片', !!(q && q.blindImage), JSON.stringify(q && {
    stem: q.stem, blind: q.blindImage, imageOnly: q.imageOnly
  }));
  ok('不是「纯图片选项」，但关键公式仍藏在图片里', q && q.imageOnly === false,
     'imageOnly=' + (q && q.imageOnly));
  ok('题干公式图的 URL 被提取出来了', q && q.stemImages && q.stemImages.length === 1,
     JSON.stringify(q && q.stemImages));
  ok('选项公式图的 URL 被提取出来了',
     q && q.options[0].images && q.options[0].images.length === 1,
     JSON.stringify(q && q.options && q.options[0].images));
  ok('主流程仍进入图片分支', /q\.imageOnly \|\| q\.blindImage/.test(mainSrc));
  ok('图片分支会调用视觉识别', /askVision\(q\)/.test(mainSrc));
  ok('视觉识别失败仍然明确不乱填', /视觉模型也没读出这道题的公式，已跳过不乱填/.test(mainSrc));
  ok('图片题识别成功自动交卷，失败才拦', /imageFail/.test(mainSrc) &&
     /和普通题一样计入自动交卷/.test(mainSrc) && /图片公式没识别出来/.test(mainSrc));
}

console.log('\n=== B. 结果页：隐藏失败提示 / disabled textarea 不能再触发重做 ===');
{
  const hiddenFail =
    '<div class="singleQuesId" data="Q1"><div class="TiMu" data="0">' +
      '<div class="Zy_TItle"><span>1【单选题】测试题</span></div>' +
      '<textarea disabled>旧答案</textarea>' +
      '<div class="myAnswer">我的答案：A</div>' +
      '<div class="correctAnswer">正确答案：A</div>' +
    '</div></div>' +
    '<div style="display:none">未达到及格线，请重做</div>' +
    '<div>得分：100</div>';
  const CX = scene(hiddenFail);
  ok('disabled textarea 不算可填控件', CX.hasAnswerInputs() === false);
  ok('隐藏的「未达到及格线」不触发 fail', CX.resultState() === 'done',
     String(CX.resultState()));
}
{
  const visibleFail =
    '<div class="singleQuesId" data="Q1"><div class="TiMu" data="0">' +
      '<div class="Zy_TItle"><span>1【单选题】测试题</span></div>' +
      '<div class="myAnswer">我的答案：B</div>' +
      '<div class="correctAnswer">正确答案：A</div>' +
    '</div></div>' +
    '<div class="tip">未达到及格线，请重做</div>' +
    '<div>得分：25</div>';
  const CX = scene(visibleFail);
  ok('真正可见的失败提示仍然要重做', CX.resultState() === 'fail', String(CX.resultState()));
}
{
  const visibleRetryButton =
    '<div class="singleQuesId" data="Q1"><div class="TiMu" data="0">' +
      '<div class="Zy_TItle"><span>1【单选题】测试题</span></div>' +
      '<div class="myAnswer">我的答案：A</div>' +
      '<div class="correctAnswer">正确答案：A</div>' +
    '</div></div>' +
    '<button>重新答题</button><div>得分：100</div>';
  const CX = scene(visibleRetryButton);
  ok('满分结果页上的「重新答题」按钮不能误判成不及格',
     CX.resultState() === 'done', String(CX.resultState()));
}
ok('runBody 入口会拦结果页', /CX\.resultState[\s\S]{0,500}不再重复作答/.test(mainSrc));

console.log('\n=== C. 视频完成态 / 翻页锁 / 版本 ===');
{
  ok('完成标记必须属于当前任务点（有 hasOwnFinished）',
     /function hasOwnFinished/.test(videoSrc) && /hasOwnFinished\(box\)/.test(videoSrc));
  ok('不能再拿整页任意绿标当当前视频已完成',
     !/d && d\.querySelector && d\.querySelector\('\.ans-job-finished/.test(mainSrc));
  ok('goNext 抢不到锁会重试', /function retryGoNext/.test(mainSrc) && /retryGoNext\(why/.test(mainSrc));
  ok('goNext 的锁有更短的 TTL', /claim\('goNext', 5000\)/.test(mainSrc));
  ok('同一页的下一节按钮允许补点一次', /nextTry:/.test(mainSrc) && /_nt < 2/.test(mainSrc));
  ok('idle 锁在真正翻页前才抢，且很快释放',
     /claim\('idleAdvance', 4000\)/.test(mainSrc) && /release\('idleAdvance'\)/.test(mainSrc));
  ok('一键启动后有兜底 idle 检查', /启动后等待媒体\/题目/.test(mainSrc));
  ok('面板标题显示版本号', /ftk-ver/.test(panelSrc) && /__ftkVersion/.test(panelSrc));
}
{
  ok('dist 版本是 1.3.9', /@version\s+1\.3\.12/.test(dist));
  ok('var VERSION 与头部同步', /var VERSION = '1\.3\.12'/.test(dist));
  ok('dist 含图片公式保护', /blindImage/.test(dist));
  ok('dist 含结果页入口保护', /这一页是结果页，不再重复作答/.test(dist));
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
