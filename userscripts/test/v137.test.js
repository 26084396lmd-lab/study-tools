/* ============================================================================
 *  v137.test.js —— 答案识别 / 公式归一化 / 图片选项保护（v1.3.12）
 *
 *  现场问题：
 *    1. 「1【单选题】...」的题号+题型前缀没剥干净，题库相似度被拉低；
 *    2. 公式答案带反引号 / LaTeX（`log₁₀(100)=2`、\log_{10}），
 *       明明和选项是同一个式子却匹配不上；
 *    3. AI 返回一段和选项对不上的文字时，旧逻辑仍把它当答案，覆盖题库
 *       正确答案，最后页面报「无法定位选项」；
 *    4. 公式选项是纯图片（star3/origin 的 PNG，无 alt），必须标出来跳过，
 *       不能瞎猜、更不能带着空答案自动交卷。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', '\u5b66\u4e60\u901a\u514d\u8d39\u9898\u5e93\u52a9\u624b.user.js');
const dist = fs.readFileSync(DIST, 'utf8');
const coreSrc = fs.readFileSync(path.join(SRC, 'core.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const panelSrc = fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   <<< ' + extra : '')); }
}
function eq(a, b, name) { ok(name, a === b, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

function makeCore() {
  const p = require.resolve('../src/core.js');
  delete require.cache[p];
  return require('../src/core.js');
}
function makeChaoxing(html) {
  const { document, window } = parseHTML(
    '<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>');
  global.window = window;
  global.document = document;
  global.__ftkRoot = window;
  global.unsafeWindow = window;
  window.FreeTikuCore = makeCore();
  const p = require.resolve('../src/chaoxing.js');
  delete require.cache[p];
  require('../src/chaoxing.js');
  return { CX: window.FreeTikuChaoxing, document, window };
}

console.log('\n=== A. 构建产物与关键保护 ===');
{
  ok('@version 是 1.3.12', /@version\s+1\.3\.12/.test(dist));
  ok('var VERSION 同步到 1.3.12', /var VERSION = '1\.3\.12'/.test(dist));
  ok('选择题一条都没匹配上时，不产出 bestAnswer',
     /!options\.length\) \{[\s\S]{0,220}?outTexts = textsArr\.filter/.test(coreSrc));
  ok('AI 校验必须落到具体选项才允许覆盖题库',
     /!ai\.answer\.answerKey\.length && !ai\.answer\.answerIndex\.length/.test(coreSrc));
  ok('纯图片题走视觉识别，识别失败才停下不乱填',
     /q\.imageOnly \|\| q\.blindImage/.test(mainSrc) && /askVision\(q\)/.test(mainSrc) &&
     /if \(imageFail\)/.test(mainSrc) && /imageVisionHit/.test(mainSrc));
  ok('面板夹取保证至少 120px 可见（小窗口有纵向行程）',
     /Math\.min\(bh, 120\)/.test(panelSrc));
  ok('停止按钮先本地停、再广播、并且总是发兜底命令',
     /stopLocal\('用户停止'\)/.test(mainSrc) && /sendCmd\('stop'\)/.test(mainSrc));
}

console.log('\n=== B. 题干 / 选项清洗 ===');
{
  const C = makeCore();
  const { CX } = makeChaoxing('');
  eq(CX.cleanStem('1【单选题】\u4eba\u6587\u7684\u5b9a\u4e49\u662f\u4ec0\u4e48\uff1f'),
     '\u4eba\u6587\u7684\u5b9a\u4e49\u662f\u4ec0\u4e48\uff1f', 'cleanStem 去掉「1【单选题】」');
  eq(CX.cleanStem('12、\u4e0b\u5217\u8bf4\u6cd5\u6b63\u786e\u7684\u662f\uff08 \u3000\uff09'),
     '\u4e0b\u5217\u8bf4\u6cd5\u6b63\u786e\u7684\u662f', 'cleanStem 去题号/空括号');
  eq(CX.cleanOption('A. \u5317\u4eac'), '\u5317\u4eac', 'cleanOption 去 A. 前缀');
  eq(CX.cleanOption('（B）\u4e0a\u6d77'), '\u4e0a\u6d77', 'cleanOption 去（B）前缀');
  eq(CX.cleanOption('A 广州'), '广州', 'cleanOption 去「A 」前缀');
}

console.log('\n=== C. 公式 / LaTeX 归一化 ===');
{
  const C = makeCore();
  const opt = [
    'A. `log\u2081\u2080(100)=2`',
    'B. `log\u2081\u2080(100)=3`',
    'C. `log\u2081\u2080(10)=1`',
    'D. `log\u2081\u2080(1)=0`'
  ];
  const r = C.buildResponse(
    { question: '\u6c42 log10(100) \u7684\u503c', options: opt, type: 0 },
    ['\\log_{10}(100)=2'], []);
  eq(r.answer.answerKeyText, 'A', 'LaTeX 答案能匹配反引号+下标选项');
  eq(r.answer.bestAnswer[0], 'A. `log\u2081\u2080(100)=2`', 'bestAnswer 返回卷面选项原文');

  const r2 = C.buildResponse(
    { question: 'q', options: ['A. \u5bf9', 'B. \u9519'], type: 0 },
    ['\u5b8c\u5168\u4e0d\u76f8\u5173\u7684\u4e1c\u897f'], []);
  eq(r2.answer.bestAnswer.length, 0, '选择题无匹配时不产出答案');
  eq(r2.answer.answerKeyText, '', '选择题无匹配时 answerKey 为空');

  const r3 = C.buildResponse(
    { question: 'q', options: ['A. \u5bf9', 'B. \u9519'], type: 0 },
    ['A'], []);
  eq(r3.answer.answerKeyText, 'A', '数据源只回字母时也能落到选项');

  const r4 = C.buildResponse(
    { question: 'q', options: ['A. \u5bf9', 'B. \u9519'], type: 0 },
    ['E'], []);
  eq(r4.answer.bestAnswer.length, 0, 'A/B/C/D \u4e4b\u5916\u7684\u5b57\u6bcd\u4e0d\u80fd\u5f53\u7b54\u6848');
  eq(r4.answer.answerKeyText, '', '\u65e0\u6548\u5b57\u6bcd\u7684 answerKey \u8981\u6e05\u7a7a');
}

console.log('\n=== D. 纯图片公式选项：能识别、能按字母填、不会瞎猜 ===');
{
  const html = `
  <div class="singleQuesId" data="Q1">
    <div class="TiMu" data="0">
      <div class="Zy_TItle clearfix">
        <i class="fl">1</i>
        <div class="clearfix font-cxsecret fontLabel">
          <span class="newZy_TItle">\u3010\u5355\u9009\u9898\u3011</span>
          <p>\u4e00\u5e73\u9762\u6ce2\u6cbf x \u8f74\u4f20\u64ad\uff0c\u6ce2\u901f\u4e3a
            <img src="http://p.ananas.chaoxing.com/star3/origin/stem.png"></p>
        </div>
      </div>
      <div class="clearfix">
        <ul class="Zy_ulTop w-top fl">
          <li class="font-cxsecret before-after" qid="1" qtype="0">
            <label class="fl before"><span class="num_option" data="A">A</span></label>
            <a href="javascript:;" class="after"><p><img src="http://p.ananas.chaoxing.com/star3/origin/a.png"></p></a>
            <input type="radio" name="answer1" value="A">
          </li>
          <li class="font-cxsecret before-after" qid="1" qtype="0">
            <label class="fl before"><span class="num_option" data="B">B</span></label>
            <a href="javascript:;" class="after"><p><img src="http://p.ananas.chaoxing.com/star3/origin/b.png"></p></a>
            <input type="radio" name="answer1" value="B">
          </li>
          <li class="font-cxsecret before-after" qid="1" qtype="0">
            <label class="fl before"><span class="num_option" data="C">C</span></label>
            <a href="javascript:;" class="after"><p><img src="http://p.ananas.chaoxing.com/star3/origin/c.png"></p></a>
            <input type="radio" name="answer1" value="C">
          </li>
          <li class="font-cxsecret before-after" qid="1" qtype="0">
            <label class="fl before"><span class="num_option" data="D">D</span></label>
            <a href="javascript:;" class="after"><p><img src="http://p.ananas.chaoxing.com/star3/origin/d.png"></p></a>
            <input type="radio" name="answer1" value="D">
          </li>
        </ul>
      </div>
    </div>
  </div>`;
  const { CX } = makeChaoxing(html);
  const qs = CX.extractQuestions();
  const q = qs[0];
  ok('图片公式题解析出来了', !!q);
  eq(q && q.type, 'single', '题型仍是单选');
  eq(q && q.options.map(function (o) { return o.letter; }).join(''), 'ABCD', '字母没有错位');
  ok('四个纯图片选项都标记为 imageOnly',
     q && q.options.every(function (o) { return o.imageOnly; }));
  ok('整题标记为 imageOnly', q && q.imageOnly);
  ok('题干没有整段消失', q && /stream|origin|\u5e73\u9762\u6ce2/.test(q.stem));

  const res = CX.apply(q, {
    answer: { answerKeyText: 'B', bestAnswer: ['\u4e0d\u80fd\u770b\u89c1\u7684\u56fe\u7247\u516c\u5f0f'] }
  }, { overwrite: false });
  ok('知道字母 B 时仍然能按字母选中图片选项', res.applied);
  ok('B 的 input 真的被勾上', q.options[1].input && q.options[1].input.checked);
}

(async function () {
  console.log('\n=== E. AI 对不上选项时不覆盖题库 ===');
  {
    const C = makeCore();
    const calls = [];
    const transport = function (opt) {
      calls.push(opt.url);
      if (opt.url.indexOf('/ai/ask') >= 0) {
        /* AI 返回一段和卷面选项完全对不上的文字 */
        return Promise.resolve(JSON.stringify({
          ok: true, answers: ['\u5b8c\u5168\u4e0d\u76f8\u5173\u7684\u4e1c\u897f']
        }));
      }
      return Promise.resolve(JSON.stringify({ code: 1, data: '\u56db\u500d' }));
    };
    const s = C.makeSearcher({
      sources: ['icodef', 'ai'],
      transport: transport,
      minInterval: 0,
      maxRetries: 0,
      log: function () {},
      verifyAi: true
    });
    const resp = await s.queryOnce({
      question: '一弹簧振子振幅变两倍，总能量变为原来的',
      options: ['\u4e8c\u5206\u4e4b\u4e00', '\u4e24\u500d', '\u56db\u500d', '\u56db\u5206\u4e4b\u4e00'], type: 0
    });
    eq(resp && resp.answer.answerKeyText, 'C', 'AI 乱答不会把题库的 C 冲掉');
    ok('来源仍是题库', resp && resp.source === 'icodef');
  }

  console.log('\n==========================================================');
  console.log(fail ? ('\u274c v137 结果：通过 ' + pass + '，失败 ' + fail) :
                   ('\u2705 v137 结果：通过 ' + pass + '，失败 ' + fail));
  process.exit(fail ? 1 : 0);
})();
