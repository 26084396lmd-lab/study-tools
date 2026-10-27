/* ============================================================================
 * v140.test.js —— 1.3.11 图片公式题视觉兜底
 *
 * 现场问题：题干/选项里的公式是 p.ananas.chaoxing.com 的 PNG，源码没有
 * alt/LaTeX。旧版只能标成「［式］」后跳过，用户问「这种题没有办法了吗」。
 * 现在把图片 URL 提取出来，交给本地桥的 DeepSeek 视觉接口先读公式再作答；
 * 识别成功和普通题一样自动交卷，识别失败仍然停下，不交空白卷。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', '学习小助手.user.js');
const dist = fs.readFileSync(DIST, 'utf8');
const coreSrc = fs.readFileSync(path.join(SRC, 'core.js'), 'utf8');
const cxSrc = fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   <<< ' + extra : '')); }
}
function eq(a, b, name) {
  ok(name, JSON.stringify(a) === JSON.stringify(b),
     'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

function makeCore() {
  const p = require.resolve('../src/core.js');
  delete require.cache[p];
  return require('../src/core.js');
}

function scene(html) {
  const { document, window } = parseHTML(
    '<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>');
  try {
    const proto = window.Element && window.Element.prototype;
    if (proto) proto.getBoundingClientRect = function () {
      return { width: 120, height: 24, left: 10, top: 10, right: 130, bottom: 34 };
    };
  } catch (e) { /* ... */ }
  try { window.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; }; }
  catch (e2) { /* ... */ }
  globalThis.__ftkRoot = window;
  globalThis.window = window;
  globalThis.document = document;
  globalThis.unsafeWindow = window;
  globalThis.FreeTikuCore = makeCore();
  window.FreeTikuCore = globalThis.FreeTikuCore;
  vm.runInThisContext(cxSrc, { filename: 'chaoxing.js' });
  return window.FreeTikuChaoxing;
}

console.log('\n=== A. 图片 URL 提取 ===');
{
  const html =
    '<div class="singleQuesId" data="Q1"><div class="TiMu" data="0">' +
      '<div class="Zy_TItle"><span>已知一平面简谐波的表达式为 ' +
        '<img src="http://p.ananas.chaoxing.com/star3/origin/formula1.png">' +
      '，则：</span></div>' +
      '<ul>' +
        '<li><input type="radio" name="answerQ1" value="A"><a class="after">波的频率为 ' +
          '<img src="/star3/origin/formula2.png"></a></li>' +
        '<li><input type="radio" name="answerQ1" value="B"><a class="after">' +
          '<img src="http://p.ananas.chaoxing.com/star3/origin/formula3.png"></a></li>' +
        '<li><input type="radio" name="answerQ1" value="C"><a class="after">' +
          '<img src="http://p.ananas.chaoxing.com/star3/origin/icon/radio.png" width="8" height="8"></a></li>' +
      '</ul>' +
    '</div></div>';
  const CX = scene(html);
  const q = CX.extractQuestions()[0];
  ok('题目解析出来了', !!q);
  eq(q.stemImages, ['http://p.ananas.chaoxing.com/star3/origin/formula1.png'], '题干图片按顺序提取');
  eq(q.options[0].images, ['https://mooc1.chaoxing.com/star3/origin/formula2.png'], '选项相对地址转绝对地址');
  eq(q.options[1].images, ['http://p.ananas.chaoxing.com/star3/origin/formula3.png'], '纯图片选项也能提取');
  eq(q.options[2].images, [], '小图标不送给视觉模型');
  ok('关键公式在图片里仍然标记为 blindImage', q.blindImage === true);
  ok('有图片的选项仍然标记 imageOnly', q.options[1].imageOnly === true);
}

console.log('\n=== B. core：请求带图 / 视觉返回字母 ===');
{
  const C = makeCore();
  const imgs = [{ url: 'http://p.ananas.chaoxing.com/a.png', where: 'stem', label: '题干' }];
  const req = C.aiRequest('题目', ['甲', '乙'], 'single', imgs, ['A', 'B']);
  const body = JSON.parse(req.body);
  eq(body.images, imgs, '请求体带 images');
  eq(body.optionLetters, ['A', 'B'], '请求体带卷面真实字母');
  eq(body.type, 0, 'single 归一成 0');
  eq(req.timeout, 120000, '视觉请求给足 120 秒');

  const parsed = C.parseAi(JSON.stringify({ ok: true, answers: ['C'], letters: ['C'] }));
  eq(parsed.answers, undefined, 'parseAi 不暴露原始 answers 数组');
  eq(parsed.texts, ['C'], 'answers 保留');
  eq(parsed.letters, ['C'], 'letters 单独保留');

  const resp = C.buildResponse({
    question: '图片选项题', options: ['［图］', '［图］', '［图］', '［图］'], type: 'single'
  }, parsed.texts, parsed.letters);
  eq(resp.answer.answerKeyText, 'C', '视觉字母 C 能落到卷面 C');
  eq(resp.answer.bestAnswer.length, 1, '图片占位选项也能产出 bestAnswer');

  const bad = C.parseAi(JSON.stringify({ ok: false, error: '图片下载失败' }));
  eq(bad.texts, [], '桥报错时不伪造答案');
  eq(bad.letters, [], '桥报错时不给字母');
}

console.log('\n=== C. 主流程：先视觉识别，成功自动交卷，失败不乱填 ===');
{
  ok('主流程有 visionImages', /function visionImages\(q\)/.test(mainSrc));
  ok('主流程有 askVision', /async function askVision\(q\)/.test(mainSrc));
  ok('图片题仍进入专门分支', /q\.imageOnly \|\| q\.blindImage/.test(mainSrc));
  ok('图片分支调用视觉识别', /vresp = await askVision\(q\)/.test(mainSrc));
  ok('视觉成功会填答案并计数', /imageVisionHit\+\+/.test(mainSrc));
  ok('视觉失败明确不乱填', /视觉模型也没读出这道题的公式，已跳过不乱填/.test(mainSrc));
  ok('识别成功的图片题进入普通自动交卷', /和普通题一样计入自动交卷/.test(mainSrc));
  ok('识别失败的图片题仍会拦下不交空白卷', /if \(imageFail\)/.test(mainSrc) &&
     /图片公式没识别出来，已停下等你手动处理/.test(mainSrc));
  ok('只有识别成功才加命中', /if \(vres\.applied\)[\s\S]{0,160}hit\+\+/.test(mainSrc));
}

console.log('\n=== D. 构建产物 ===');
{
  ok('@version 是 1.3.11', /@version\s+1\.3\.12/.test(dist));
  ok('var VERSION 同步到 1.3.11', /var VERSION = '1\.3\.12'/.test(dist));
  ok('dist 含图片提取', /function collectImages/.test(dist));
  ok('dist 含视觉请求', /AI视觉/.test(dist) && /askVision/.test(dist));
  ok('dist 含 optionLetters', /optionLetters/.test(dist));
  ok('dist 不会把图片题直接跳过', !/脚本读不到公式内容，先跳过不乱填/.test(dist));
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
