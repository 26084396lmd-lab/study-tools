/* ============================================================================
 *  pipeline.test.js —— 流水线（自动切下一个章节测验）的离线验证
 *
 *  这个功能最难的地方是「在没有真实学习通页面的情况下证明它不会乱点」。
 *  所以这里造两份 DOM：
 *    A. 最外层的课程页（课程树 + 任务点 iframe + .tabtags）—— 验证它读得对、挑得对；
 *    B. 答题框架（外面有 __ftkAdvance 服务）—— 验证它调得对、轮数记得住。
 *  所有选择器都对着 ocsjs 的 ocs-cx-api.js / sk-main.js / chaoxing.js 抄的，
 *  测试里也按那三个文件的真实结构造 DOM，不是我自己想的结构。
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

/* Node 里没有 sessionStorage，给个内存版（流水线靠它跨框架记轮数） */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear()
  };
}

function load(win) {
  def(globalThis, '__ftkRoot', win);
  def(globalThis, 'window', win);
  def(globalThis, 'document', win.document);
  def(globalThis, 'sessionStorage', fakeStorage());
  def(globalThis, 'location', win.location || { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'pipeline.js'), 'utf8'), { filename: 'pipeline.js' });
  return win.FreeTikuPipeline;
}

/* =========================================================== A. 课程页 */
console.log('\n=== A. 最外层课程页：读得对、挑得对 ===');

const COURSE_HTML = `<!doctype html><html><body>
  <div class="ncells">
    <h4 id="cur101" class="currents"><i class="jobCount"></i><a href="#">1.1 第一节</a></h4>
    <h4 id="cur102"><i class="jobCount"></i><a href="#">1.2 第二节</a></h4>
    <h4 id="cur103"><i class="noJob"></i><a href="#">1.3 第三节</a></h4>
  </div>
  <div class="tabtags">
    <span class="currents">1.1 视频</span><span>1.2 章节测验</span><span>1.3 章节测验</span>
  </div>
  <div class="ans-attach-ct ans-job-finished" id="box0"><i class="ans-job-icon"></i>
    <iframe src="https://mooc1.chaoxing.com/ananas/modules/video/index.html?objectId=v1"></iframe></div>
  <div class="ans-attach-ct" id="box1"><i class="ans-job-icon"></i>
    <iframe src="https://mooc1.chaoxing.com/ananas/modules/work/index.html?workId=1"></iframe></div>
  <div class="ans-attach-ct" id="box2"><i class="ans-job-icon"></i>
    <iframe src="https://mooc1.chaoxing.com/ananas/modules/work/index.html?workId=2"></iframe></div>
  <div id="iframe"><iframe src="https://mooc1.chaoxing.com/mooc-ans/knowledge/cards"></iframe></div>
</body></html>`;

const env = parseHTML(COURSE_HTML);
def(env.window, 'location', { href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=101' });
if (!env.window.self) def(env.window, 'self', env.window);
def(env.window, 'top', env.window);       // 顶层框架：top === self
const PL = load(env.window);
const doc = env.document;

/* --- moduleType：六个类型 + 未知 --- */
ok('moduleType 认视频', PL.moduleType('https://a/ananas/modules/video/x') === 'video');
ok('moduleType 认音频', PL.moduleType('https://a/ananas/modules/audio/x') === 'audio');
ok('moduleType 认章节测验', PL.moduleType('https://a/ananas/modules/work/x') === 'work');
ok('moduleType 认 PPT', PL.moduleType('https://a/ananas/modules/ppt/x') === 'ppt');
ok('moduleType 认文档', PL.moduleType('https://a/ananas/modules/pdf/x') === 'pdf');
ok('moduleType 认书本', PL.moduleType('https://a/ananas/modules/innerbook/x') === 'book');
ok('moduleType 认不出来就空串', PL.moduleType('https://a/hello') === '');

/* --- scan --- */
const s = PL.scan(doc);
ok('扫出 2 个未完成章节（.jobCount，.noJob 不算）', s.chapters.length === 2, '实际 ' + s.chapters.length);
ok('扫出 3 个任务点标签', s.tabs.length === 3, '实际 ' + s.tabs.length);
ok('扫出 3 个任务点 iframe', s.points.length === 3, '实际 ' + s.points.length);
ok('第 1 个任务点是视频且已完成', s.points[0].type === 'video' && s.points[0].finish === true,
   s.points[0] ? s.points[0].type + '/' + s.points[0].finish : '没有');
ok('第 2 个任务点是章节测验且未完成', s.points[1].type === 'work' && s.points[1].finish === false);
ok('第 3 个任务点是章节测验且未完成', s.points[2].type === 'work' && s.points[2].finish === false);
ok('读到当前章节 .currents', s.cur.indexOf('1.1') >= 0, JSON.stringify(s.cur));
ok('章节都找到了可点的 <a>', s.chapters.every(c => !!c.a));

/* --- pickNext：优先切本章未做过的章节测验，且要切到对应的那个 tab --- */
let clicked = [];
s.tabs.forEach((t, i) => { if (t.el) t.el.onclick = () => clicked.push(i); });
[s.chapters[0].a, s.chapters[1].a].forEach((a, i) => { a.onclick = () => clicked.push('ch' + i); });

let nx = PL.pickNext(s);
ok('下一步 = 切任务点（不是章节）', nx && nx.what === 'task', JSON.stringify(nx));
ok('切的是第 2 个 tab（第 1 个未完成的章节测验）', nx && nx.click === s.tabs[1].el);
clicked = []; PL.installAdvance({ log: () => { } }).next();
ok('installAdvance 把 __ftkAdvance 装到了窗口上', !!env.window.__ftkAdvance);
ok('next() 真的点了那个 tab', clicked.length === 1 && clicked[0] === 1, JSON.stringify(clicked));
ok('next() 报告切成功', env.window.__ftkAdvance.last.ok === true, JSON.stringify(env.window.__ftkAdvance.last));

/* 第 1 个测验试过了 -> 应该轮到第 2 个 */
PL.markTried(s.points[1].url);
nx = PL.pickNext(PL.scan(doc));
ok('第 1 个试过之后，轮到第 2 个任务点', nx && nx.what === 'task' && nx.click === s.tabs[2].el, JSON.stringify(nx));

/* 两个都试过了 -> 应该换章（而且必须跳过「当前这一章」） */
PL.markTried(s.points[2].url);
nx = PL.pickNext(PL.scan(doc));
ok('本章测验都试过后，改切下一章', nx && nx.what === 'chapter', JSON.stringify(nx));
ok('切的是 1.2 章（跳过当前这一章 1.1）', nx && nx.desc.indexOf('1.2') >= 0, JSON.stringify(nx && nx.desc));

/* --- v1.1.6：重做过还是不及格的任务点，不要再切回去 --- */
{
  PL.resetRound();                                   /* 清掉「试过」的标记，只留「失败」这一条判据 */
  const s2 = PL.scan(doc);
  PL.markFailed(s2.points[1].url);                    /* 把第 1 个章节测验标成「没及格过」 */
  ok('记下了「这一页没及格过」', PL.failedBefore(s2.points[1].url) === true);
  const nx2 = PL.pickNext(PL.scan(doc));
  ok('没及格过的那一页被跳过，直接切下一个任务点',
     !!nx2 && nx2.what === 'task' && nx2.click === s2.tabs[2].el, JSON.stringify(nx2));
  ok('重做次数记账能用', PL.bumpRework() === 1 && PL.reworkCount() === 1);
  /* 把状态恢复成这一段之前的样子，后面的断言还指着「两个都试过」 */
  PL.resetRound();
  PL.markTried(s2.points[1].url);
  PL.markTried(s2.points[2].url);
}

/* 只剩当前这一章挂着 .jobCount -> 必须收手，不能原地打转 */
doc.getElementById('cur102').removeChild(doc.getElementById('cur102').querySelector('.jobCount'));
nx = PL.pickNext(PL.scan(doc));
ok('只剩当前章有未完成标记时，判定为「卡住了」而不是再点一次',
   nx && nx.what === 'stuck', JSON.stringify(nx));
ok('卡住时给出人话原因', !!(nx && /试过一轮/.test(nx.why || '')), JSON.stringify(nx && nx.why));

/* --- report：诊断文本要能看出问题 --- */
const rep = PL.report(PL.scan(doc));
ok('诊断报告里有任务点分类', /章节测验/.test(rep) && /视频/.test(rep), rep.slice(0, 80));
ok('诊断报告里有已完成/未完成', /\[已完成\]/.test(rep) && /\[未完成\]/.test(rep));
ok('诊断报告里有已试过标记', /已试过/.test(rep));
ok('诊断报告里有轮数', /已跑轮数/.test(rep));

/* --- 轮数记账 --- */
ok('这里是顶层框架（topWin 返回 null）', PL.topWin() === null);
PL.resetRound();
ok('resetRound 之后轮数归零', PL.getRound() === 0 && PL.triedCount() === 0);

/* ======================================================= B. 答题框架 */
console.log('\n=== B. 答题框架：叫外层切页 ===');

const env2 = parseHTML('<!doctype html><html><body><div class="TiMu" data="0"></div></body></html>');
def(env2.window, 'location', { href: 'https://mooc1.chaoxing.com/ananas/modules/work/index.html?workId=1' });
if (!env2.window.self) def(env2.window, 'self', env2.window);

/* 造一个「外层窗口」：有 document，且装了 __ftkAdvance */
const calls = [];
const fakeTop = {
  document: parseHTML('<!doctype html><html><body></body></html>').document,
  __ftkAdvance: {
    scan: () => ({ chapters: [], tabs: [], points: [], cur: '', url: '' }),
    next: function (o) { calls.push(o); return { ok: true, what: 'chapter', desc: '1.2 第二节' }; }
  }
};
def(env2.window, 'top', fakeTop);
def(env2.window, 'parent', fakeTop);

const PL2 = load(env2.window);
ok('答题框架里 topWin() 能拿到外层窗口', PL2.topWin() === fakeTop);

PL2.resetRound();
let logs = [];
let r = PL2.advance({ log: (m) => logs.push(m) });
ok('advance 调到了外层的 next()', calls.length === 1, JSON.stringify(calls));
ok('advance 报告成功', r && r.ok === true, JSON.stringify(r));
ok('advance 把当前 URL 记进「已试过」',
   PL2.triedBefore('https://mooc1.chaoxing.com/ananas/modules/work/index.html?workId=1'));
ok('advance 轮数 +1', PL2.getRound() === 1, String(PL2.getRound()));
ok('advance 会告诉用户它干了什么', logs.some(l => /第 1 轮|已让外层页面切过去/.test(l)), JSON.stringify(logs));

/* 外层没有这个服务时，必须老老实实说「切不了」，而不是假装成功 */
const env3 = parseHTML('<!doctype html><html><body></body></html>');
def(env3.window, 'location', { href: 'https://x/y' });
if (!env3.window.self) def(env3.window, 'self', env3.window);
def(env3.window, 'top', { document: parseHTML('<!doctype html><html><body></body></html>').document });
const PL3 = load(env3.window);
logs = [];
r = PL3.advance({ log: (m) => logs.push(m) });
ok('外层没装服务时返回 ok=false', r && r.ok === false, JSON.stringify(r));
ok('并且明确说了「没法自动切下一个」', logs.some(l => /没法自动切下一个/.test(l)), JSON.stringify(logs));

/* 轮数上限：跑到 maxRounds 必须自己停 */
const env4 = parseHTML('<!doctype html><html><body></body></html>');
def(env4.window, 'location', { href: 'https://x/z' });
if (!env4.window.self) def(env4.window, 'self', env4.window);
def(env4.window, 'top', fakeTop);
const PL4 = load(env4.window);
PL4.resetRound();
let last = null;
for (let i = 0; i < 5; i++) last = PL4.advance({ log: () => { }, maxRounds: 3 });
ok('超过 maxRounds 之后拒绝继续', last && last.ok === false && last.why === '轮数上限', JSON.stringify(last));

/* ==================================================== C. 新版课程树 */
console.log('\n=== C. 新版课程树（.posCatalog + getTeacherAjax）===');

const MODERN_HTML = `<!doctype html><html><body>
  <div class="posCatalog_select firstLayer">
    <a class="posCatalog_name" onclick="getTeacherAjax('2669','1545','101')">1.1 第一节</a>
    <span class="jobUnfinishCount" value="0"></span>
  </div>
  <div class="posCatalog_select posCatalog_active">
    <a class="posCatalog_name" onclick="getTeacherAjax('2669','1545','102')">1.2 第二节</a>
    <span class="jobUnfinishCount" value="3"></span>
  </div>
  <div class="posCatalog_select">
    <a class="posCatalog_name" onclick="getTeacherAjax('2669','1545','103')">1.3 第三节</a>
    <i class="icon_Completed"></i>
  </div>
  <div class="posCatalog_select">
    <a class="posCatalog_name" onclick="getTeacherAjax('2669','1545','104')">1.4 第四节</a>
    <span class="jobUnfinishCount" value="2"></span>
  </div>
  <input type="hidden" id="curChapterId" value="102">
  <input type="hidden" id="curCourseId" value="2669">
  <input type="hidden" id="curClazzId" value="1545">
  <div id="prev_tab"><ul class="prev_ul"><li>1.2 视频</li><li class="active">1.2 章节测验</li></ul></div>
  <div class="ans-attach-ct ans-job-finished"><i class="ans-job-icon"></i>
    <iframe src="https://mooc1.chaoxing.com/ananas/modules/video/index.html?objectId=v9"></iframe></div>
  <div class="ans-attach-ct"><i class="ans-job-icon"></i>
    <iframe src="https://mooc1.chaoxing.com/ananas/modules/work/index.html?workId=9"></iframe></div>
  <div id="workpop"><div class="jobFinishTip">当前章节还有任务点未完成，确定进入下一节？<a href="#">下一节</a></div></div>
</body></html>`;

const env5 = parseHTML(MODERN_HTML);
const doc5 = env5.document;
def(env5.window, 'location', { href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=102' });
if (!env5.window.self) def(env5.window, 'self', env5.window);
def(env5.window, 'top', env5.window);
/* 超星页面自己的跳章入口 */
const jumped = [];
env5.window.getTeacherAjax = function (c, cl, ch) { jumped.push([c, cl, ch]); };
/* 「下一节」链接被点了吗 —— 直接替换 click 方法，比靠 DOM0 onclick 可靠 */
let nextSectionClicked = false;
{
  const nextA = doc5.querySelector('#workpop a');
  nextA.click = function () { nextSectionClicked = true; };
}

const PL5 = load(env5.window);
const s5 = PL5.scan(doc5);
ok('认出新版课程树', s5.modernMode === true);
ok('读出 4 章', s5.chapters.length === 4, '实际 ' + s5.chapters.length);
ok('当前章 id 从 #curChapterId 读到', s5.curId === '102', JSON.stringify(s5.curId));
ok('courseId / clazzId 也读到了', s5.courseId === '2669' && s5.clazzId === '1545',
   s5.courseId + '/' + s5.clazzId);
ok('当前章名从 .posCatalog_active 读到', s5.cur.indexOf('1.2') >= 0, JSON.stringify(s5.cur));
ok('任务点标签从 #prev_tab .prev_ul li 读到', s5.tabs.length === 2, '实际 ' + s5.tabs.length);
ok('章节 id 从 onclick 里抠出来', PL5.chapterIdFromOnclick(s5.chapters[3].el) === '104',
   PL5.chapterIdFromOnclick(s5.chapters[3].el));
ok('jobUnfinishCount=0 视为「做完了」', s5.chapters[0].finish === true);
ok('jobUnfinishCount=3 视为「还没完」', s5.chapters[1].finish === false);
ok('icon_Completed 视为「做完了」', s5.chapters[2].finish === true);

let nx5 = PL5.pickNext(s5);
ok('先切本节没做过的章节测验', nx5 && nx5.what === 'task', JSON.stringify(nx5));

PL5.markTried(s5.points[1].url);
nx5 = PL5.pickNext(PL5.scan(doc5));
ok('本节做完后，跳到第一个「没做完且不是当前章」的章', nx5 && nx5.what === 'chapter', JSON.stringify(nx5));
ok('跳过当前章(102)、跳过已完成的(101/103)，选中 104',
   nx5 && nx5.desc.indexOf('1.4') >= 0, JSON.stringify(nx5 && nx5.desc));
ok('换章带上了 getTeacherAjax 的三参数',
   !!(nx5 && nx5.jump && nx5.jump.chapterId === '104'), JSON.stringify(nx5 && nx5.jump));

jumped.length = 0;
PL5.markTried(s5.points[1].url);   // resetRound 会清掉「已试过」，这里补回来
PL5.installAdvance({ log: () => { } }).next();
ok('换章真的调了页面自己的 getTeacherAjax', jumped.length === 1 && jumped[0][2] === '104',
   JSON.stringify(jumped));
ok('顺手把「当前章节还有任务点未完成」弹窗里的「下一节」点了', nextSectionClicked === true);
ok('#workpop 被藏起来了', doc5.getElementById('workpop').style.display === 'none',
   JSON.stringify(doc5.getElementById('workpop').style.display));

const rep5 = PL5.report(PL5.scan(doc5));
ok('新版诊断报告写明是新版课程树', /新版 \.posCatalog/.test(rep5), rep5.slice(0, 60));
ok('新版诊断报告带当前章 id', /当前章 id=102/.test(rep5), rep5.slice(0, 60));

/* ------------------------------------------------------------------ D */
console.log('\n=== D. 任务点标签错位：宁可退回方框链接，也不点隔壁 ===');

function tabStub(text) {
  const el = { text: text, clicks: 0 };
  el.click = function () { el.clicks++; };
  return { el: el, text: text, cls: '' };
}
function pointStub(type, text, url) {
  const a = { clicks: 0 };
  a.click = function () { a.clicks++; };
  const box = { querySelector: function (sel) { return sel === 'a' ? a : null; } };
  return { el: {}, box: box, url: url, type: type, finish: false, text: text };
}
function scene(tabs, points) {
  return { chapters: [], tabs: tabs, points: points, cur: '', modernMode: false };
}

PL5.resetRound();
{
  /* 标签比 iframe 多一个「统计」页签：不能按位置硬取 */
  const t0 = tabStub('1.1 视频'), t1 = tabStub('1.2 章节测验'),
        t2 = tabStub('1.3 章节测验'), t3 = tabStub('统计');
  const p0 = pointStub('video', '1.1 视频', 'https://x/v131/v');
  p0.finish = true;
  const p1 = pointStub('work', '1.2 章节测验', 'https://x/v131/w1');
  const p2 = pointStub('work', '1.3 章节测验', 'https://x/v131/w2');
  const nxA = PL5.pickNext(scene([t0, t1, t2, t3], [p0, p1, p2]));
  ok('标签里混进「统计」时，仍切到第一个未完成测验', nxA && nxA.click === t1.el,
     nxA && (nxA.desc || ''));
  ok('而且没有误点「统计」或视频标签', t0.el.clicks === 0 && t3.el.clicks === 0);
}

PL5.resetRound();
{
  /* 第 1 个测验的标签丢了：没有可靠对应关系，必须退回点方框里的链接 */
  const t0 = tabStub('1.1 视频'), t2 = tabStub('1.3 章节测验');
  const p0 = pointStub('video', '1.1 视频', 'https://x/v131/v2');
  p0.finish = true;
  const p1 = pointStub('work', '1.2 章节测验', 'https://x/v131/w3');
  const p2 = pointStub('work', '1.3 章节测验', 'https://x/v131/w4');
  const nxB = PL5.pickNext(scene([t0, t2], [p0, p1, p2]));
  ok('对不上时不瞎点标签，改点任务点方框里的链接',
     nxB && nxB.click === p1.box.querySelector('a'), nxB && (nxB.desc || ''));
  ok('隔壁的「1.3 章节测验」标签没被误点', t2.el.clicks === 0);
}

PL5.resetRound();
{
  /* 标签文案不带题型（「第二章 作业」），但同类型数量一致 -> 按第几个同类任务点对 */
  const t1 = tabStub('第二章 作业');
  const p0 = pointStub('video', '1.1 视频', 'https://x/v131/v3');
  p0.finish = true;
  const p1 = pointStub('work', '1.2 章节测验', 'https://x/v131/w5');
  const nxC = PL5.pickNext(scene([t1], [p0, p1]));
  ok('文案对不上但同类型数量一致时，按序号对上', nxC && nxC.click === t1.el,
     nxC && (nxC.desc || ''));
}

console.log('\n' + '='.repeat(58));
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(58));
process.exit(fail ? 1 : 0);