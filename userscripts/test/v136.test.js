/* ============================================================================
 *  v136.test.js —— 空页面不再卡住（v1.3.6）
 *
 *  现场：交完卷点「下一节」后，学习通换到一个「暂无内容」的 tab（4 应用拓展），
 *  日志停在那句「点页面上的下一节」，总开关还是开着，但再也没人叫 goNext。
 *
 *  修法：
 *    A. 点完「下一节」3 秒后验一次，还是空页就继续找；
 *    B. 章节树跳转后 4 秒也验一次，防止跳到一个空章；
 *    C. 同一个空页第二次还空，就自动停，不能无限循环；
 *    D. 当前章已经绿了（完成）时，章节树要跳过它，挑后面的未完成章。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', '\u5b66\u4e60\u901a\u514d\u8d39\u9898\u5e93\u52a9\u624b.user.js');
const dist = fs.readFileSync(DIST, 'utf8');
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}
function def(obj, name, value) {
  try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
  catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
}
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
  def(globalThis, 'location', win.location || { href: 'https://mooc1.chaoxing.com/mycourse/studentstudy' });
  vm.runInThisContext(fs.readFileSync(path.join(SRC, 'pipeline.js'), 'utf8'), { filename: 'pipeline.js' });
  return win.FreeTikuPipeline;
}

console.log('\n=== A. 版本 / 空页检查代码 ===');
{
  ok('@version 是 1.3.12', /@version\s+1\.3\.12/.test(dist));
  ok('var VERSION 同步到 1.3.12', /var VERSION = '1\.3\.12'/.test(dist));
  ok('有 pageFingerprint', /function pageFingerprint\(\)/.test(mainSrc));
  ok('有 scheduleEmptyCheck', /function scheduleEmptyCheck\(before, seq, why, delay\)/.test(mainSrc));
  ok('点「下一节」后 3 秒检查空页',
    /scheduleEmptyCheck\(_before, _seq, why, 3000\)/.test(mainSrc));
  ok('章节树跳转后 4 秒也检查',
    /scheduleEmptyCheck\(_beforeTree, _seq, '章节树', 4000\)/.test(mainSrc));
  ok('空页用可见内容判断，不把隐藏的旧 iframe 算进来',
    /empty = !visibleWorkInTree\(\)/.test(mainSrc));
  ok('有 visibleWorkInTree / isShown',
    /function visibleWorkInTree\(\)/.test(mainSrc) &&
    /function isShown\(el\)/.test(mainSrc) &&
    /getBoundingClientRect/.test(mainSrc) && /getClientRects/.test(mainSrc));
  ok('空页会继续 goNext', /goNext\('空页，继续往下', true\)/.test(mainSrc));
  ok('同一个空页重复出现就自动停',
    /emptyDone\[key\]/.test(mainSrc) && /这一页一直是空页/.test(mainSrc));
  ok('启动 / 重置会清掉空页记录',
    /idleDone = \{\}; emptyDone = \{\};/.test(mainSrc));
}

console.log('\n=== B. 指纹只看页面，不看面板日志 ===');
{
  const start = mainSrc.indexOf('function pageFingerprint()');
  const end = mainSrc.indexOf('var navSeq');
  const fp = start >= 0 && end > start ? mainSrc.slice(start, end) : '';
  ok('抓到了 pageFingerprint 函数体', fp.length > 100, '长度 ' + fp.length);
  ok('指纹包含当前 tab', /activeTabText\(\)/.test(fp));
  ok('指纹包含当前章节 id', /curChapterId/.test(fp));
  ok('指纹包含题数 / 媒体 / iframe 数', /'q'/.test(fp) && /'v'/.test(fp) && /'f'/.test(fp));
  ok('指纹没有把面板日志算进去', !/ftk-panel/.test(fp));
}

console.log('\n=== C. 当前章已完成：章节树挑后面的未完成章 ===');
{
  const HTML = `<!doctype html><html><body>
    <div class="posCatalog_select">
      <a class="posCatalog_name" onclick="getTeacherAjax('2669','1545','101')">1.1 旧章</a>
      <i class="icon_Completed"></i>
    </div>
    <div class="posCatalog_select posCatalog_active">
      <a class="posCatalog_name" onclick="getTeacherAjax('2669','1545','103')">1.3 5-3 简谐振动的能量</a>
      <i class="icon_Completed"></i>
    </div>
    <div class="posCatalog_select">
      <a class="posCatalog_name" onclick="getTeacherAjax('2669','1545','201')">2.1 6-1 机械波的形成</a>
      <span class="jobUnfinishCount" value="1"></span>
    </div>
    <div class="posCatalog_select">
      <a class="posCatalog_name" onclick="getTeacherAjax('2669','1545','202')">2.2 6-2</a>
      <span class="jobUnfinishCount" value="2"></span>
    </div>
    <input type="hidden" id="curChapterId" value="103">
    <input type="hidden" id="curCourseId" value="2669">
    <input type="hidden" id="curClazzId" value="1545">
  </body></html>`;
  const env = parseHTML(HTML);
  def(env.window, 'location', { href: 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=103' });
  if (!env.window.self) def(env.window, 'self', env.window);
  def(env.window, 'top', env.window);
  const jumped = [];
  env.window.getTeacherAjax = (c, cl, ch) => { jumped.push(ch); };

  const PL = load(env.window);
  const s = PL.scan(env.document);
  ok('当前章 1.3 认成已完成', s.chapters[1].finish === true);
  ok('下一章 2.1 认成未完成', s.chapters[2].finish === false);

  const nx = PL.pickNext(s);
  ok('空页会挑 2.1，而不是回到 1.3 或跳去 2.2',
    nx && nx.what === 'chapter' && nx.jump && nx.jump.chapterId === '201',
    JSON.stringify(nx && { what: nx.what, desc: nx.desc, jump: nx.jump }));

  const ra = PL.installAdvance({ log: () => { } }).next();
  ok('章节树跳转调用学习通自己的 getTeacherAjax',
    !!(ra && ra.ok && jumped.length === 1 && jumped[0] === '201'),
    JSON.stringify({ ra: ra, jumped: jumped }));
}

console.log('\n----------------------------------------');
console.log((fail ? '\u274c' : '\u2705') + ' v136 结果：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
