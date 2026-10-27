/* ============================================================================
 *  v135.test.js —— 刷完自动停止 + 自动翻页总上限（v1.3.5）
 *
 *  这次修的是「会不会死循环」：
 *    A. 找不到下一个任务点时，不只写日志，而是真的关掉总开关；
 *    B. 自动翻页有 500 次硬上限，平台把「下一节」做成循环也一定会停；
 *    C. 「重置」会把这个计数一起清零；
 *    D. 顺手清掉三个确认没用的常量（K_MAX / BTN / FIND_MEDIA_SEC）。
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
const pipeSrc = fs.readFileSync(path.join(SRC, 'pipeline.js'), 'utf8');

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

console.log('\n=== A. 版本 / 构建产物 ===');
{
  ok('@version 是 1.3.12', /@version\s+1\.3\.12/.test(dist));
  ok('var VERSION 同步到 1.3.12', /var VERSION = '1\.3\.12'/.test(dist));
  ok('描述不再承诺「不需要买 key」这种绝对话', /可选 DeepSeek AI 兜底/.test(dist));
}

console.log('\n=== B. 刷完自动停，而不是只写日志 ===');
{
  ok('main 里有 finishPipeline', /function finishPipeline\(msg, kind\)/.test(mainSrc));
  ok('自动结束会关总开关（stopLocal 第二个参数走安静模式）',
    /stopLocal\(msg, true\)/.test(mainSrc));
  ok('自动结束会把面板按钮切回「一键启动」', /p\.running\(false\)/.test(mainSrc));
  ok('自动结束会广播到所有框架停媒体',
    /ctlEach\('stop', \{ why: msg, quiet: true \}\)/.test(mainSrc));
  ok('找不到下一个时调用 finishPipeline', /finishPipeline\('流水线停下：'/.test(mainSrc));
  ok('只有确认刷完才用 ok 级别，其余用 warn',
    /_done \? 'ok' : 'warn'/.test(mainSrc));
  ok('手动停止仍然会显示「视频/音频已暂停（用户停止）」',
    /视频\/音频已暂停（用户停止）/.test(mainSrc));
}

console.log('\n=== C. 自动翻页硬上限 500 次 ===');
{
  ok('main 里有 navBudget', /function navBudget\(\)/.test(mainSrc));
  ok('达到上限会直接 finishPipeline', /超过安全上限/.test(mainSrc));
  ok('点「下一节」前扣一次预算', /if \(!navBudget\(\)\) \{\s*if \(XG\)/.test(mainSrc));
  ok('退回章节树前也扣一次预算', /if \(!navBudget\(\)\) return;[\s\S]{0,120}var ra = null/.test(mainSrc));
  ok('pipeline 导出 NAV_MAX = 500', /NAV_MAX = 500/.test(pipeSrc));
  ok('pipeline 导出 bumpNav', /bumpNav: bumpNav/.test(pipeSrc));
}

console.log('\n=== D. 重置会清掉翻页计数 ===');
{
  const env = parseHTML('<!doctype html><html><body></body></html>');
  def(env.window, 'location', { href: 'https://mooc1.chaoxing.com/mooc-ans/work/doWork' });
  if (!env.window.self) def(env.window, 'self', env.window);
  def(env.window, 'top', env.window);
  def(globalThis, '__ftkRoot', env.window);
  def(globalThis, 'window', env.window);
  def(globalThis, 'document', env.window.document);
  def(globalThis, 'sessionStorage', fakeStorage());
  def(globalThis, 'location', env.window.location);
  vm.runInThisContext(pipeSrc, { filename: 'pipeline.js' });
  const PL = env.window.FreeTikuPipeline;
  ok('PL.bumpNav 可用', PL && typeof PL.bumpNav === 'function');
  ok('NAV_MAX 是 500', PL && PL.NAV_MAX === 500);
  PL.bumpNav(); PL.bumpNav();
  ok('bumpNav 会累加', PL.navCount() === 2, '实际 ' + PL.navCount());
  PL.resetRound();
  ok('resetRound 把翻页计数清零', PL.navCount() === 0, '实际 ' + PL.navCount());
}

console.log('\n=== E. 清掉确认没用的常量 ===');
{
  ok('pipeline 里没有 K_MAX', !/\bK_MAX\b/.test(pipeSrc));
  ok('main 里没有 BTN 样式常量', !/\bvar BTN\b/.test(mainSrc));
  ok('video 里没有 FIND_MEDIA_SEC', !/\bFIND_MEDIA_SEC\b/.test(fs.readFileSync(path.join(SRC, 'video.js'), 'utf8')));
}

console.log('\n----------------------------------------');
console.log((fail ? '\u274c' : '\u2705') + ' v135 结果：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
