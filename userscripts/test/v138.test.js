/* ============================================================================
 *  v138.test.js —— 页面卡死 / 绿色视频不翻页的回归测试
 *
 *  现场：
 *    - 视频任务点已经绿了，脚本不点下一节；
 *    - 随后面板的停止、拖动、其他按钮全部没反应；
 *    - 结果页日志里出现「交完了，点下一节」之后就停住。
 *
 *  根因回归点：
 *    A. 面板按钮被当成页面按钮，findSubmit/findRework 点到脚本自己，
 *       同步递归把主线程卡死；
 *    B. 面板由旧答题 iframe 创建，交卷/翻页后 DOM 还在，监听器成了僵尸；
 *    C. 绿色任务点被 mediaOwnedBy 判成「没活」，既不播也不翻页；
 *    D. 隐藏旧 iframe 里的任务点仍然拦住 goNext；
 *    E. 结果页没有记住 panelSig，面板被反复拆建，点击落在重建间隙。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const panelSrc = fs.readFileSync(path.join(SRC, 'panel.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const chaoxingSrc = fs.readFileSync(path.join(SRC, 'chaoxing.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   <<< ' + extra : '')); }
}

function makeChaoxing(html) {
  const { document, window } = parseHTML(
    '<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>');
  global.window = window;
  global.document = document;
  global.__ftkRoot = window;
  global.unsafeWindow = window;
  try {
    window.Element.prototype.getBoundingClientRect = function () {
      return { width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 };
    };
    window.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };
  } catch (e) { /* ... */ }
  const corePath = require.resolve('../src/core.js');
  delete require.cache[corePath];
  window.FreeTikuCore = require('../src/core.js');
  const cxPath = require.resolve('../src/chaoxing.js');
  delete require.cache[cxPath];
  require('../src/chaoxing.js');
  return { CX: window.FreeTikuChaoxing, document, window };
}

console.log('\n=== A. 自动按钮不能点到脚本自己 ===');
{
  ok('chaoxing 有 isOwnUI 过滤', /function isOwnUI\(el\)/.test(chaoxingSrc));
  ok('findSubmit 排除 #ftk-panel/#ftk-badge',
     /function findSubmit[\s\S]{0,1400}isOwnUI\(e2\)/.test(chaoxingSrc));
  ok('findRework 排除面板',
     /function findRework[\s\S]{0,900}isOwnUI\(el\)/.test(chaoxingSrc));
  ok('main 的 findRework 也排除面板',
     /function findRework[\s\S]{0,1200}closest\('#ftk-panel,#ftk-badge,#ftk-xframe'\)/.test(mainSrc));

  const { CX } = makeChaoxing(
    '<div id="ftk-panel"><button id="ftk-submit">交卷</button>' +
    '<button id="ftk-rework">重做</button></div>' +
    '<button id="real-submit">提交</button>');
  ok('findSubmit 没把面板的「交卷」当成页面提交',
     CX.findSubmit() && CX.findSubmit().id === 'real-submit');
  ok('findRework 没把面板的「重做」当成页面重做', CX.findRework() === null);
}

console.log('\n=== B. 面板僵尸 / 重建检查 ===');
{
  ok('panel 记录创建者 window/document/frame', /ownerWin/.test(panelSrc) && /ownerDoc/.test(panelSrc) && /ownerFrame/.test(panelSrc));
  ok('panel 暴露 isAlive()', /isAlive: function \(\)/.test(panelSrc));
  ok('创建者 iframe 被移除后 isAlive 返回 false', /ownerFrame\.isConnected === false/.test(panelSrc));
  ok('main 用 usablePanel 验活', /function usablePanel\(p\)/.test(mainSrc));
  ok('ensurePanel 会替换死面板', /!usablePanel\(have\)/.test(mainSrc));
  ok('boot 即使没题也先替换僵尸面板', /haveP && !usablePanel\(haveP\)/.test(mainSrc));
  ok('rebootstrap 也会替换僵尸面板', /var hp = XR/.test(mainSrc) && /!usablePanel\(hp\)/.test(mainSrc));
}

console.log('\n=== C. 绿色视频必须能继续下一节 ===');
{
  ok('有 mediaTaskFinished 判断', /function mediaTaskFinished\(win, v\)/.test(mainSrc));
  ok('boot 对已完成媒体不再置空后卡住',
     /mediaTaskFinished\(root, vid\)/.test(mainSrc) && /视频任务点已完成/.test(mainSrc));
  ok('startHere 对已完成媒体会返回 true 并排 idle',
     /mediaTaskFinished\(root, v\)/.test(mainSrc) && /scheduleIdleAdvance\('视频任务点已完成'/.test(mainSrc));
  ok('一键启动命令槽兜底后也会排 idle',
     /scheduleIdleAdvance\('启动后没有层报告有活'/.test(mainSrc));
  ok('idle 锁被占时有有限重试',
    /claim\('idleAdvance', 4000\)/.test(mainSrc) && /scheduleIdleAdvance\(why, 1000\)/.test(mainSrc));
}

console.log('\n=== D. 隐藏旧 iframe / 已完成任务点不拦翻页 ===');
{
  ok('有 docIsVisible', /function docIsVisible\(d\)/.test(mainSrc));
  ok('docUnfinished 跳过隐藏文档', /if \(!docIsVisible\(d\)\) return 0/.test(mainSrc));
  ok('mediaUnfinished 跳过隐藏文档', /if \(!docIsVisible\(d\)\) continue/.test(mainSrc));
  ok('任务点完成标记支持 icon_Completed', /icon_Completed/.test(mainSrc) && /icon_Completed/.test(fs.readFileSync(path.join(SRC, 'video.js'), 'utf8')));
}

console.log('\n=== E. 结果页 / 视频页不要反复拆面板 ===');
{
  ok('结果页记录 panelSig', /if \(st\) \{[\s\S]{0,350}panelSig = qsig\(\)/.test(mainSrc));
  ok('boot 开头也记录 panelSig', /var st = CX\.resultState[\s\S]{0,400}panelSig = qsig\(\)/.test(mainSrc));
  ok('rebootstrap 不 removeChild 重建', !/换章节了 -> 旧面板作废/.test(mainSrc) &&
     /换章节\/换题了：保留同一个面板实例/.test(mainSrc));
}

console.log('\n=== F. 自动点击期间静默原生弹窗 ===');
{
  ok('有 fireClickSafe', /function fireClickSafe\(el\)/.test(mainSrc));
  ok('提交走 fireClickSafe', /fireClickSafe\(btn\)/.test(mainSrc));
  ok('下一节走 fireClickSafe', /fireClickSafe\(nb\)/.test(mainSrc));
  ok('自动重做走 fireClickSafe', /fireClickSafe\(rw\)/.test(mainSrc));
}

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) process.exit(1);
