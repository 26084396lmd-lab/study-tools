/* v1.3.12 现场回归：同一页两个视频任务点必须按从上到下顺序播，不能互相抢。 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseHTML } = require('linkedom');

const SRC = path.join(__dirname, '..', 'src');
const VIDEO = fs.readFileSync(path.join(SRC, 'video.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');

let pass = 0, fail = 0;
const rawLog = console.log.bind(console);
function ok(name, cond, extra) {
  if (cond) { pass++; rawLog('  \u2713 ' + name); }
  else { fail++; rawLog('  \u2717 ' + name + (extra ? '   <<< ' + extra : '')); }
}
function def(obj, name, value) {
  try { Object.defineProperty(obj, name, { value: value, configurable: true, writable: true }); return true; }
  catch (e) { try { obj[name] = value; return true; } catch (e2) { return false; } }
}

function rect(top, left) {
  return { top: top || 0, left: left || 0, width: 300, height: 180,
    right: (left || 0) + 300, bottom: (top || 0) + 180 };
}
function patchWindow(win) {
  try {
    win.getComputedStyle = function (el) {
      return { display: (el && el.style && el.style.display) || 'block', visibility: 'visible' };
    };
  } catch (e) { /* ... */ }
}

/* linkedom 的 window 是 Proxy：多个场景一起用时，frameElement 会串到
   最后一个 iframe 上。这里用普通对象当「框架视图」，只给 video.js 看
   它需要的 frameElement/document/location。 */
function frameView(win, doc, frameElement) {
  return {
    document: doc,
    location: win && win.location,
    top: win && win.top,
    parent: win && win.parent,
    frameElement: frameElement,
    getComputedStyle: function (el) {
      return { display: (el && el.style && el.style.display) || 'block', visibility: 'visible' };
    }
  };
}

/* 造一个顶层页 + 两个同源视频子框架。linkedom 不会接 contentWindow，
   所以用 FreeTikuX.frames 的假返回值把三份文档交给 video.js。 */
function scene() {
  const topEnv = parseHTML('<!doctype html><html><body></body></html>');
  const topWin = topEnv.window, topDoc = topEnv.document;
  patchWindow(topWin);
  const topView = frameView(topWin, topDoc, null);
  def(topDoc, 'defaultView', topView);

  const boxes = [];
  const frames = [{ win: topView, doc: topDoc }];

  for (let i = 0; i < 2; i++) {
    const box = topDoc.createElement('div');
    box.className = 'ans-attach-ct';
    box.getBoundingClientRect = function () { return rect(i === 0 ? 100 : 400, 0); };
    topDoc.body.appendChild(box);
    boxes.push(box);

    const iframe = topDoc.createElement('iframe');
    iframe.getBoundingClientRect = function () { return rect(i === 0 ? 100 : 400, 0); };
    box.appendChild(iframe);

    const child = parseHTML('<!doctype html><html><body><video></video></body></html>');
    const childWin = child.window, childDoc = child.document;
    const view = frameView(childWin, childDoc, iframe);
    def(childDoc, 'defaultView', view);

    frames.push({ win: view, doc: childDoc });
  }

  def(globalThis, '__ftkRoot', topWin);
  def(globalThis, 'window', topWin);
  def(globalThis, 'document', topDoc);
  vm.runInThisContext(VIDEO, { filename: 'video.js' });
  const VK = topWin.FreeTikuVideo;

  /* 只替换 frames()；其余 API 不参与这个测试。 */
  topWin.FreeTikuX = {
    frames: function () { return frames; }
  };

  return { topWin, topDoc, boxes, frames, VK };
}

rawLog('\n=== A. 两个视频任务点：按 DOM 位置从上到下排 ===');
{
  const s = scene();
  const v1 = s.frames[1].doc.querySelector('video');
  const v2 = s.frames[2].doc.querySelector('video');
  const list = s.VK.orderedTasks();
  ok('排出了两个未完成任务点', list.length === 2, 'n=' + list.length);
  ok('上面的视频排第一', list[0] && list[0].media === v1);
  ok('下面的视频排第二', list[1] && list[1].media === v2);
  ok('上面那个才允许开播', s.VK.isFirstUnfinished(s.frames[1].win, v1) === true);
  ok('下面那个必须等着', s.VK.isFirstUnfinished(s.frames[2].win, v2) === false);
}

rawLog('\n=== B. 上面的变绿后，自动轮到下面 ===');
{
  const s = scene();
  const v1 = s.frames[1].doc.querySelector('video');
  const v2 = s.frames[2].doc.querySelector('video');
  s.boxes[0].classList.add('ans-job-finished');
  const list = s.VK.orderedTasks();
  ok('已完成的任务点不再排进来', list.length === 1 && list[0].media === v2, 'n=' + list.length);
  ok('上面的已完成，不能再开播', s.VK.isFirstUnfinished(s.frames[1].win, v1) === false);
  ok('现在轮到下面的视频', s.VK.isFirstUnfinished(s.frames[2].win, v2) === true);
  s.boxes[1].classList.add('ans-job-finished');
  ok('两个都完成后没有待办媒体', s.VK.firstUnfinishedTask() === null);
}

rawLog('\n=== C. 同一行按从左到右；隐藏的旧 iframe 不算 ===');
{
  const s = scene();
  s.boxes[0].getBoundingClientRect = function () { return rect(100, 0); };
  s.boxes[1].getBoundingClientRect = function () { return rect(100, 500); };
  const list = s.VK.orderedTasks();
  ok('同一行时左边的排第一', list.length === 2 && list[0].media === s.frames[1].doc.querySelector('video'));

  const hidden = scene();
  hidden.frames[1].win.frameElement.getBoundingClientRect = function () {
    return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
  };
  const hlist = hidden.VK.orderedTasks();
  ok('隐藏的旧视频不参与排序', hlist.length === 1 &&
    hlist[0].media === hidden.frames[2].doc.querySelector('video'), 'n=' + hlist.length);
}

rawLog('\n=== D. 同一个任务点框里重复出现视频，只算一个 ===');
{
  const s = scene();
  const extra = s.frames[1].doc.createElement('video');
  s.frames[1].doc.body.appendChild(extra);
  const list = s.VK.orderedTasks();
  ok('同一任务点只保留一个', list.length === 2, 'n=' + list.length);
}

rawLog('\n=== E. 主流程确实用了顺序闸门 ===');
{
  ok('startVideo 里先判断是不是最上面的任务点', /isFirstUnfinished\(root, media\)/.test(MAIN));
  ok('startVideo 被拦下时不会继续开驱动', /这个先等着[\s\S]{0,120}return;/.test(MAIN));
  ok('上一个视频完成后先叫下一个媒体任务点', /startNextMediaTask\('上一个视频完成'\)/.test(MAIN));
  ok('顺序广播只叫媒体，不顺手启动测验', /ctlEach\('start', \{ mediaOnly: true \}\)/.test(MAIN));
  ok('boot 里完成态也会检查还有没有下一个视频', /_more[\s\S]{0,200}startNextMediaTask/.test(MAIN));
  ok('视频日志会标出第几个任务点', /（第 ' \+ \(_i \+ 1\) \+ '\/' \+ _all\.length \+ ' 个）/.test(MAIN));
}

rawLog('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
