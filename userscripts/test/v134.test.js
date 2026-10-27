/* ============================================================================
 *  v134.test.js —— 面板「拖不动」修复（v1.3.4）
 *
 *  用户实测（2026-10-22）：题库窗口拖不动、没法移动。
 *  真实成因：面板内容约 690px 高，而学习通视频页在笔记本 125%/150% 缩放下
 *  可视区只有 600px 左右；CSS 用 bottom:16px 定位，标题栏被顶到屏幕外。
 *  面板下半截又全是按钮/勾选框/日志（都不当拖动手柄），于是根本抓不到。
 *
 *  这一版：
 *    A. 面板最大高度 = 视口 - 32px，标题栏永远留在屏幕里，内容区自己滚；
 *    B. 标题栏加一个明确的拖动抓手；
 *    C. 拖动改用指针事件 + setPointerCapture，拖过 iframe 也不会断；
 *    D. 视口变化 / 窗口失焦时重新夹回位置，不会把面板弄丢。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist', '\u5b66\u4e60\u901a\u514d\u8d39\u9898\u5e93\u52a9\u624b.user.js');

let pass = 0, fail = 0;
const rawLog = console.log.bind(console);
function ok(name, cond, extra) {
  if (cond) { pass++; rawLog('  \u2713 ' + name); }
  else { fail++; rawLog('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}

const dist = fs.readFileSync(DIST, 'utf8');

rawLog('\n=== A. 版本与高度限制 ===');
{
  ok('@version 是 1.3.12', /@version\s+1\.3\.12/.test(dist));
  ok('var VERSION 与 @version 同步', /var VERSION = '1\.3\.12'/.test(dist));
  ok('面板限制最大高度（100vh）', /#ftk-panel\{[^}]*max-height:calc\(100vh - 32px\)/.test(dist));
  ok('面板限制最大高度（100dvh，移动端）', /max-height:calc\(100dvh - 32px\)/.test(dist));
  ok('面板是纵向 flex，标题栏不会被压缩', /#ftk-panel\{[^}]*display:flex;flex-direction:column/.test(dist));
  ok('标题栏不参与收缩', /#ftk-head\{[^}]*flex:none/.test(dist));
  ok('内容区自己滚动', /#ftk-body\{[^}]*overflow-y:auto/.test(dist));
  ok('JS 里也按视口算最大高度（老浏览器兜底）',
    /box\.style\.maxHeight = Math\.max\(160, v\.H - 32\)/.test(dist));
}

rawLog('\n=== B. 拖动抓手 ===');
{
  ok('标题栏里有 ftk-grip', /class="ftk-grip"/.test(dist));
  ok('抓手有提示文字', /按住这里拖动面板/.test(dist));
  ok('抓手样式是 move 光标', /\.ftk-grip\{[^}]*cursor:move/.test(dist));
  ok('标题栏禁用触摸滚动，手指拖动不会被页面抢走',
    /#ftk-head\{[^}]*touch-action:none/.test(dist));
}

rawLog('\n=== C. 指针事件与指针捕获 ===');
{
  ok('按下时做指针捕获', /setPointerCapture\(drag\.id\)/.test(dist));
  ok('松手时释放指针捕获', /releasePointerCapture\(capId\)/.test(dist));
  ok('指针取消也要结束拖动', /addEventListener\('pointercancel', onUp\)/.test(dist));
  ok('丢失捕获也要结束拖动', /addEventListener\('lostpointercapture', onUp\)/.test(dist));
  ok('多指触摸只认第一根手指', /e\.isPrimary === false/.test(dist));
  ok('重复按下不会重置拖动起点', /function onDown\(e\) \{\s*if \(drag\) return;/.test(dist));
  ok('指针移动/松开同时挂在面板和文档上',
    /box\.addEventListener\('pointermove', onMove\)/.test(dist) &&
    /d\.addEventListener\('pointermove', onMove, true\)/.test(dist));
}

rawLog('\n=== D. 视口变化 / 失焦保护 ===');
{
  ok('窗口 resize 时重新夹回可视区', /addEventListener\('resize', function \(\) \{ refit\(\); \}\)/.test(dist));
  ok('窗口失焦时清掉拖动状态', /addEventListener\('blur', onUp\)/.test(dist));
  ok('夹取时至少留 120px 面板可见（面板更矮就全留）',
    /Math\.min\(bh, 120\)/.test(dist) && /H - keep - 8/.test(dist));
}

rawLog('\n=== E. 原有交互不能被拖动吃掉 ===');
{
  ok('按钮/输入框/日志区/折叠键仍然不当作拖动手柄',
    /var SKIP = 'button,input,select,textarea,a,label,#ftk-log,\.ftk-min'/.test(dist));
  ok('折叠按钮仍然存在', /class="ftk-min"/.test(dist));
  ok('折叠后重新算高度', /this\.textContent = collapsed \? '＋' : '－';\s*refit\(\);/.test(dist));
}

rawLog('\n----------------------------------------');
rawLog((fail ? '\u274c' : '\u2705') + ' v134 结果：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
