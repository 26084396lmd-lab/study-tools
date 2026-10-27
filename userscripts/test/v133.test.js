/* ============================================================================
 *  v133.test.js —— 点「一键启动」后，视频子框架必须收到 start（v1.3.3）
 *
 *  用户实测（2026-10-22）：面板日志反复说「发现一个音频」，可见的视频却
 *  停在 0:01。桥日志里 trace('cmd', {cmd:'run', mine:true, tree:true}) 说明
 *  面板所在层 localWork() 为真。根因是 onStart 在本层 startHere() 返回 true
 *  后直接 return，ctlEach('start') 根本没执行。
 *
 *  这一版同时收紧「什么媒体才算任务点」：顶层课程壳的提示音/背景音不算。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist', '\u5b66\u4e60\u901a\u514d\u8d39\u9898\u5e93\u52a9\u624b.user.js');

let pass = 0, fail = 0;
const rawLog = console.log.bind(console);
function ok(name, cond, extra) {
  if (cond) { pass++; rawLog('  \u2713 ' + name); }
  else { fail++; rawLog('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}

const dist = fs.readFileSync(DIST, 'utf8');
const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const video = fs.readFileSync(path.join(SRC, 'video.js'), 'utf8');

rawLog('\n=== A. 启动：先广播，再本层兜底 ===');
{
  ok('版本号是 1.3.12', /@version\s+1\.3\.12/.test(dist));
  const iOnStart = dist.indexOf('onStart: function');
  const iBroadcast = dist.indexOf("ctlEach('start')", iOnStart);
  const iLocalFallback = dist.indexOf('if (startHere()) return;', iOnStart);
  ok('onStart 里能找到广播', iOnStart >= 0 && iBroadcast > iOnStart);
  ok('广播排在「本层 startHere」之前', iBroadcast > 0 && iLocalFallback > iBroadcast,
    'broadcast=' + iBroadcast + ' local=' + iLocalFallback);
  ok('不再有「本层有活就提前 return」的旧结构',
    !/if \(startHere\(\)\) return;\s*\n\s*var n = 0;/.test(dist));
  ok('没有登记表时仍保留本层兜底', /if \(n > 0\)[\s\S]{0,1500}if \(startHere\(\)\) return;/.test(dist));
  ok('兜底命令改成 start，不再用 run 启动视频', /sendCmd\('start'\)/.test(dist));
  ok('命令轮询认识 start', /cmd === 'start'/.test(dist) && /startHere\(\);/.test(dist));
  ok('sessionStorage 不可用时仍能判断「已启动」', /var runArmed = false/.test(main) && /return !runArmed/.test(main));
}

rawLog('\n=== B. 媒体归属：只认任务点，不认顶层提示音 ===');
{
  ok('video.js 有 isTaskBox', /function isTaskBox\(el\)/.test(video));
  ok('video.js 有 mediaTaskBox', /function mediaTaskBox\(win, media\)/.test(video));
  ok('video.js 导出了这两个判断', /isTaskBox: isTaskBox, mediaTaskBox: mediaTaskBox/.test(video));
  ok('main.js 有 mediaOwnedBy', /function mediaOwnedBy\(win, v\)/.test(main));
  ok('startHere 用 mediaOwnedBy 过滤本层媒体', /if \(!mediaOwnedBy\(root, v\)\)/.test(main));
  ok('boot 也过滤顶层非任务媒体', /if \(vid && !mediaOwnedBy\(root, vid\)\)/.test(main));
  ok('hasMedia 不再只看 detect', /var v = VK && VK.detect\(document\);[\s\S]{0,120}mediaOwnedBy\(root, v\)/.test(main));
  ok('mediaStillTodo 用 mediaOwnedBy', /function mediaStillTodo\(win, doc\)[\s\S]{0,500}mediaOwnedBy\(win \|\| root, v\)/.test(main));
  ok('mediaUnfinished 只数任务点媒体', /mediaOwnedBy\(frames\[i\]\.win \|\| root, \{ kind:/.test(main));
  ok('媒体没做成时放开 videoStarted 闩锁', /if \(!r \|\| !r\.done\) videoStarted = false;/.test(main));
}

rawLog('\n=== C. 音频不再误报倍速菜单 ===');
{
  ok('只有 video 才检查倍速菜单', /found\.kind === 'video' && rateDisabled\(doc\)/.test(video));
  ok('音频不会走「倍速菜单去掉了」分支', !/if \(rate > 1 && rateDisabled\(doc\)\)/.test(video));
}

rawLog('\n================  v133.test.js  ' + pass + ' 通过 / ' + fail + ' 失败  ================');
process.exit(fail ? 1 : 0);
