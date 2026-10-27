/* v1.2.1 回归：两件用户实报的事
 *  1) 判断题的 input value 是 "true"/"false"，不能被当成选项字母（否则 answerKeyText:'A'
 *     会算出 TRUE，落到「字母对不上选项」，题就空着不选）。
 *  2) 题库/模型给的答案文字跟卷面选项字面对不上时（「组别相等」vs「连接组标号相等」），
 *     要按最长公共子序列挑最像的一项，不许干看着不选。
 *
 * 用法：node test/v121.test.js
 */
'use strict';

const { parseHTML } = require('linkedom');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (detail ? '   <<< ' + detail : '')); }
}

function make(body) {
  const { document, window } = parseHTML(
    '<!doctype html><html><head><meta charset="utf-8"></head><body>' + body + '</body></html>');
  global.window = window;
  global.document = document;
  return { document, window };
}

function load(win) {
  const p = require.resolve('../src/core.js');
  delete require.cache[p];
  require('../src/core.js');
  const q = require.resolve('../src/chaoxing.js');
  delete require.cache[q];
  require('../src/chaoxing.js');
  return { CX: win.FreeTikuChaoxing, Core: win.FreeTikuCore };
}

/* ------------------------------------------------------------------ A */
console.log('\n=== A. 判断题：value="true" 不许变成字母 TRUE ===');
{
  const { document, window } = make(`
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="3">
        <div class="Zy_TItle clearfix"><div class="fl"><i>1</i>、【判断题】简谐振动的动能和势能都随时间作周期性变化。</div></div>
        <ul>
          <li><b class="ri"></b><label><input type="radio" name="answerQ1" value="true"><span>对</span></label></li>
          <li><b class="wr"></b><label><input type="radio" name="answerQ1" value="false"><span>错</span></label></li>
        </ul>
      </div>
    </div>`);
  const { CX } = load(window);
  const q = CX.extractQuestions(document)[0];
  ok(q && q.type === 'judgement', '认出判断题', q && q.type);
  ok(q.options.map(o => o.letter).join('') === 'AB',
    '选项字母是 AB 而不是 TRUEFALSE', q.options.map(o => o.letter).join(''));

  const r = CX.apply(q, { answer: { answerKeyText: 'A', bestAnswer: ['正确'] } }, { overwrite: true });
  ok(r.applied, 'answerKeyText=A 能落到页面上', JSON.stringify(r));
  ok(q.options.map(o => !!(o.input && o.input.checked)).join(',') === 'true,false',
    '勾上的是「对」', q.options.map(o => !!(o.input && o.input.checked)).join(','));

  /* 再来一次：题库只给文字不给字母 */
  const q2 = CX.extractQuestions(document)[0];
  const r2 = CX.apply(q2, { answer: { answerKeyText: '', bestAnswer: ['不正确'] } }, { overwrite: true });
  ok(r2.applied, '只给「不正确」也能选', JSON.stringify(r2));
  ok(q2.options.map(o => !!(o.input && o.input.checked)).join(',') === 'false,true',
    '勾上的是「错」（先判否）', q2.options.map(o => !!(o.input && o.input.checked)).join(','));
}

/* ------------------------------------------------------------------ B */
console.log('\n=== B. 答案字面对不上：按最像的选项落地 ===');
{
  const { document, window } = make(`
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle clearfix"><div class="fl"><i>1</i>、【单选题】变压器并联条件中必须满足的条件是（）。</div></div>
        <ul>
          <li><label><input type="radio" name="answerQ1" value="A"><span> A、变比相等</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="B"><span> B、连接组标号相等</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="C"><span> C、短路阻抗标幺值相等</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="D"><span> D、额定电压相等</span></label></li>
        </ul>
      </div>
    </div>`);
  const { CX } = load(window);
  const q = CX.extractQuestions(document)[0];

  /* 用户截图里的真事：答案是「组别相等」，卷面写「连接组标号相等」——
     原来的三道匹配全落空，最后报「无法定位选项」，题就空着。 */
  const r = CX.apply(q, { answer: { answerKeyText: '', bestAnswer: ['组别相等'] } }, { overwrite: true });
  ok(r.applied, '不再报「无法定位选项」', JSON.stringify(r));
  ok(q.options.filter(o => o.input && o.input.checked).map(o => o.letter).join('') === 'B',
    '挑中了最像的 B、连接组标号相等',
    q.options.filter(o => o.input && o.input.checked).map(o => o.letter).join('') || '一个都没选');

  /* 差得实在太远时不许瞎猜 */
  const q2 = CX.extractQuestions(document)[0];
  q2.options.forEach(o => { if (o.input) o.input.checked = false; });
  const r2 = CX.apply(q2, { answer: { answerKeyText: '', bestAnswer: ['完全无关的一句话'] } }, { overwrite: true });
  ok(!r2.applied, '完全不沾边时仍然老实报没定位到', JSON.stringify(r2));
  ok(q2.options.every(o => !(o.input && o.input.checked)), '也没乱勾',
    q2.options.map(o => !!(o.input && o.input.checked)).join(','));
}

/* ------------------------------------------------------------------ C */
console.log('\n=== C. 原样答案照旧精确命中（别被模糊逻辑带偏） ===');
{
  const { document, window } = make(`
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle clearfix"><div class="fl"><i>1</i>、【单选题】一弹簧振子振幅翻倍，总能量变为原来的？</div></div>
        <ul>
          <li><label><input type="radio" name="answerQ1" value="A"><span> A、二分之一</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="B"><span> B、两倍</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="C"><span> C、四倍</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="D"><span> D、四分之一</span></label></li>
        </ul>
      </div>
    </div>`);
  const { CX } = load(window);
  const q = CX.extractQuestions(document)[0];
  const r = CX.apply(q, { answer: { answerKeyText: 'C', bestAnswer: ['四倍'] } }, { overwrite: true });
  ok(r.applied && r.how.indexOf('点选 C') >= 0, '字母 C 精确命中', JSON.stringify(r));
  ok(q.options.filter(o => o.input && o.input.checked).map(o => o.letter).join('') === 'C',
    '勾的是 C、四倍', q.options.filter(o => o.input && o.input.checked).map(o => o.letter).join(''));
}

console.log('\n================  v121.test.js  ' + pass + ' 通过 / ' + fail + ' 失败  ================');
process.exit(fail ? 1 : 0);