/* dom.test.js —— 用 linkedom 造一份「学习通章节测验」结构的 DOM，验证 chaoxing.js 的
 *               解析（题干/选项/题型）与作答（点选/填表）是否真的能落地。
 *
 *  结构按 api/decode.py 的取法复刻：
 *    .singleQuesId[data=qid] > .TiMu[data=题型码] + .Zy_TItle + ul>li>input
 *  判断题用 li>b.ri / b.wr 标记对错（ocsjs 的 chaoxingWork/sk-main.js 就是这么判的）。
 *
 * 用法：node dom.test.js
 */
'use strict';

const path = require('path');
const { parseHTML } = require('linkedom');

/* ----------------------------------------------------------- 夹具 HTML */
const FIXTURE = `
<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="questionBox">
  <form id="workForm">
    <input type="hidden" name="workId" value="123456">
    <input type="hidden" name="courseId" value="266998280">
    <input type="hidden" name="clazzId" value="154562848">
    <input type="hidden" name="answerwqbid" value="Q1,Q2,Q3,Q4,">

    <!-- 1. 单选 -->
    <div class="singleQuesId" data="Q1">
      <div class="TiMu" data="0">
        <div class="Zy_TItle clearfix"><div class="fl"><i>1</i>、【单选题】中华人民共和国的首都是哪里？</div></div>
        <ul>
          <li><label><input type="radio" name="answerQ1" value="A"><span> A、上海</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="B"><span> B、广州</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="C"><span> C、北京</span></label></li>
          <li><label><input type="radio" name="answerQ1" value="D"><span> D、深圳</span></label></li>
        </ul>
      </div>
    </div>

    <!-- 2. 多选 -->
    <div class="singleQuesId" data="Q2">
      <div class="TiMu" data="1">
        <div class="Zy_TItle clearfix"><div class="fl"><i>2</i>、【多选题】马克思主义的三个组成部分包括？</div></div>
        <ul>
          <li><label><input type="checkbox" name="answerQ2" value="A"><span> A、马克思主义哲学</span></label></li>
          <li><label><input type="checkbox" name="answerQ2" value="B"><span> B、马克思主义政治经济学</span></label></li>
          <li><label><input type="checkbox" name="answerQ2" value="C"><span> C、科学社会主义</span></label></li>
          <li><label><input type="checkbox" name="answerQ2" value="D"><span> D、空想社会主义</span></label></li>
        </ul>
      </div>
    </div>

    <!-- 3. 判断（b.ri / b.wr） -->
    <div class="singleQuesId" data="Q3">
      <div class="TiMu" data="3">
        <div class="Zy_TItle clearfix"><div class="fl"><i>3</i>、【判断题】北京是中华人民共和国的首都。</div></div>
        <ul>
          <li><b class="ri"></b><label><input type="radio" name="answerQ3" value="true"><span>对</span></label></li>
          <li><b class="wr"></b><label><input type="radio" name="answerQ3" value="false"><span>错</span></label></li>
        </ul>
      </div>
    </div>

    <!-- 4. 填空（无 ul，只有 textarea） -->
    <div class="singleQuesId" data="Q4">
      <div class="TiMu" data="2">
        <div class="Zy_TItle clearfix"><div class="fl"><i>4</i>、【填空题】中国现存最早的一部完整的农书是《______》。</div></div>
        <textarea name="answerQ4" rows="3"></textarea>
      </div>
    </div>

    <a id="submitBtn" class="completeBtn">提交</a>
  </form>
</div>
</body></html>`;

/* ------------------------------------------------------------ 断言 */
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? '   <<< ' + extra : '')); }
}
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

/* --------------------------------------------- 搭一个「像浏览器」的环境 */
const { window } = parseHTML(FIXTURE);
const doc = window.document;

// 布局类 API 补丁（linkedom 不做排版）
const anyEl = doc.querySelector('div');
if (window.Element && window.Element.prototype) {
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
  };
}
if (anyEl && !anyEl.getBoundingClientRect) {
  // 兜底：逐个补
  Array.from(doc.querySelectorAll('*')).forEach(function (e) {
    e.getBoundingClientRect = function () {
      return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
    };
  });
}
window.getComputedStyle = window.getComputedStyle || function () {
  return { display: 'block', visibility: 'visible' };
};
// 沙箱里的 Event 必须用我们自己的可写版本：Node 24 自带一个全局 `Event`，它的
// `eventPhase` 是只读 getter，而 linkedom 的 dispatchEvent 会去赋值它 → TypeError。
class SandboxEvent {
  constructor(t, o) {
    this.type = t;
    this.bubbles = !!(o && o.bubbles);
    this.eventPhase = 0;
    this.target = null;
    this.currentTarget = null;
  }
  stopPropagation() {} stopImmediatePropagation() {} preventDefault() {}
}
window.Event = SandboxEvent;
window.MouseEvent = SandboxEvent;
globalThis.Event = SandboxEvent;
globalThis.MouseEvent = SandboxEvent;

// 让 input.click() 具有「浏览器激活行为」：radio 组内互斥、checkbox 翻转
function installClickBehaviour(document) {
  Array.from(document.querySelectorAll('input')).forEach(function (inp) {
    inp.checked = false;
    inp.click = function () {
      const type = (this.getAttribute('type') || '').toLowerCase();
      if (type === 'radio') {
        const name = this.getAttribute('name');
        Array.from(document.querySelectorAll('input')).forEach(function (o) {
          if (o.getAttribute('name') === name) o.checked = false;
        });
        this.checked = true;
      } else if (type === 'checkbox') {
        this.checked = !this.checked;
      } else {
        this.checked = true;
      }
      this.dispatchEvent(new window.Event('click', { bubbles: true }));
    };
  });
}
installClickBehaviour(doc);

/* --------------------------------------------------- 载入待测模块 */
globalThis.window = window;
globalThis.document = doc;
globalThis.unsafeWindow = window;
globalThis.__ftkRoot = window;      // 与构建产物一致：core/chaoxing 共用同一个挂载对象
globalThis.location = { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork?workId=123456' };
globalThis.getComputedStyle = window.getComputedStyle;

const SRC = path.join(__dirname, '..', 'src');
require(path.join(SRC, 'core.js'));
require(path.join(SRC, 'chaoxing.js'));

const C = window.FreeTikuCore || globalThis.FreeTikuCore;
const CX = window.FreeTikuChaoxing || globalThis.FreeTikuChaoxing;
if (!C || !CX) {
  console.error('模块没挂到 window 上；FreeTikuCore=' + !!C + ' FreeTikuChaoxing=' + !!CX);
  process.exit(2);
}

/* ============================================================ 测试开始 */
console.log('\n=== A. 页面识别 ===');
eq(CX.pageKind(), 'work', 'pageKind 认出这是作业/测验页');

console.log('\n=== B. 题目解析 ===');
const qs = CX.extractQuestions();
eq(qs.length, 4, '解析出 4 道题');
if (qs.length !== 4) { console.error('题目数不对，后续测试跳过'); process.exit(1); }

eq(qs.map(q => q.qid), ['Q1', 'Q2', 'Q3', 'Q4'], '题目 id 从 .singleQuesId[data] 取到');
eq(qs.map(q => q.type), ['single', 'multiple', 'judgement', 'completion'], '题型码 0/1/3/2 -> single/multiple/judgement/completion');

eq(qs[0].stem, '中华人民共和国的首都是哪里？', '单选题干剥掉了「1、」「【单选题】」');
eq(qs[1].stem, '马克思主义的三个组成部分包括？', '多选题干清洗正确');
eq(qs[2].stem, '北京是中华人民共和国的首都。', '判断题干清洗正确');
eq(qs[3].stem, '中国现存最早的一部完整的农书是《______》。', '填空题干清洗正确');

eq(qs[0].options.map(o => o.letter), ['A', 'B', 'C', 'D'], '单选选项字母取自 input[value]');
eq(qs[0].options.map(o => o.text), ['上海', '广州', '北京', '深圳'], '单选选项文本剥掉了「A、」前缀');
eq(qs[2].options.map(o => o.text), ['对', '错'], '判断题靠 b.ri / b.wr 得到 对/错');
eq(qs[2].options.map(o => o.judge), [true, false], '判断题 judge 语义正确');
eq(qs[3].options.length, 0, '填空题没有选项');
ok(!!qs[3].textarea, '填空题找到了 textarea');
eq(qs.map(q => q.answered), [false, false, false, false], '初始都没作答');

console.log('\n=== C. 作答落地（单选）===');
let r = CX.apply(qs[0], { answer: { answerKeyText: 'C', bestAnswer: ['C、北京'] } }, { overwrite: true });
ok(r.applied, '单选 apply 返回成功', JSON.stringify(r));
const q1in = qs[0].options.map(o => o.input);
eq(q1in.map(i => !!i.checked), [false, false, true, false], '只勾上了 C');

console.log('\n=== D. 作答落地（多选）===');
r = CX.apply(qs[1], {
  answer: { answerKeyText: 'ABC', bestAnswer: ['A、马克思主义哲学', 'B、马克思主义政治经济学', 'C、科学社会主义'] }
}, { overwrite: true });
ok(r.applied, '多选 apply 返回成功', JSON.stringify(r));
eq(qs[1].options.map(o => !!o.input.checked), [true, true, true, false], 'ABC 勾上，D 没动');

console.log('\n=== E. 多选覆盖：先误选 D，再改成 ABC ===');
qs[1].options[3].input.click();     // 页面/自己先误点了 D
eq(qs[1].options.map(o => !!o.input.checked), [true, true, true, true], '前置状态：ABCD 全勾上了');
r = CX.apply(qs[1], {
  answer: { answerKeyText: 'ABC', bestAnswer: ['A、马克思主义哲学', 'B、马克思主义政治经济学', 'C、科学社会主义'] }
}, { overwrite: true });
ok(r.how.indexOf('清掉误选 1 项') >= 0, 'apply 报告清掉了 1 项误选', r.how);
eq(qs[1].options.map(o => !!o.input.checked), [true, true, true, false], 'D 被取消，只剩 ABC');

console.log('\n=== F. 作答落地（判断）===');
r = CX.apply(qs[2], { answer: { answerKeyText: 'A', bestAnswer: ['正确'] } }, { overwrite: true });
ok(r.applied, '判断题 apply 返回成功', JSON.stringify(r));
eq(qs[2].options.map(o => !!o.input.checked), [true, false], '题库答「正确」-> 勾上「对」');

qs[2].options[0].input.click();     // 先清掉
qs[2].options[1].input.click();
r = CX.apply(qs[2], { answer: { answerKeyText: 'B', bestAnswer: ['不正确'] } }, { overwrite: true });
eq(qs[2].options.map(o => !!o.input.checked), [false, true], '题库答「不正确」-> 勾上「错」（先判否生效）');

console.log('\n=== G. 作答落地（填空）===');
r = CX.apply(qs[3], { answer: { answerKeyText: '', bestAnswer: ['齐民要术'] } }, { overwrite: true });
ok(r.applied, '填空 apply 返回成功', JSON.stringify(r));
eq(qs[3].textarea.value, '齐民要术', 'textarea 被填上答案');

console.log('\n=== H. 已作答检测 & 交卷按钮 ===');
const fresh = CX.extractQuestions();
eq(fresh.map(q => q.answered), [true, true, true, true], '重新解析后识别出四题都已作答');
const btn = CX.findSubmit();
ok(!!btn, 'findSubmit 找到提交按钮', btn && (CX.txt(btn) || btn.value));
ok(btn && btn.id === 'submitBtn', '找到的是 #submitBtn');

console.log('\n=== I. 题干清洗函数本身 ===');
eq(CX.cleanStem('【单选题】下面说法正确的是'), '下面说法正确的是', 'cleanStem 去【题型】');
eq(CX.cleanStem('12、（2分）题干内容'), '题干内容', 'cleanStem 去题号与分值');
eq(CX.cleanStem('3、题干（5.0分）'), '题干', 'cleanStem 去尾部（5.0分）');
eq(CX.cleanOption('B、选项内容'), '选项内容', 'cleanOption 去前缀');
eq(CX.cleanOption('C. 选项内容'), '选项内容', 'cleanOption 去 "C. " 前缀');

console.log('\n' + '='.repeat(58));
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(58));
process.exit(fail ? 1 : 0);