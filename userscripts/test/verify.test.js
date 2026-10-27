/* ============================================================================
 *  verify.test.js —— AI 交叉验证（v1.1.6）
 *
 *  用户实测：一道「振幅变两倍、总能量变几倍」的单选题，题库（百度）给
 *  「四分之一」，正确答案是「四倍」—— 题库把别的课里长得像的那道题匹配进来了。
 *  于是 v1.1.6 加了交叉验证：题库命中了也再问一次 AI，两边不一致就按 AI 的填。
 *
 *  这一份盯着：
 *    A. 不一致 -> 采用 AI，并且缓存里存的也必须是 AI 的答案
 *    B. 一致   -> 保持题库的来源标记
 *    C. AI 没答上来 -> 沿用题库的（不冒风险）
 *    D. 关掉开关 -> 一次 AI 都不问
 *    E. 本来就是 AI 给的答案 -> 不会再多问一次 AI
 * ==========================================================================*/
'use strict';

const path = require('path');
const C = require(path.join(__dirname, '..', 'src', 'core.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '   ' + extra : '')); }
}

const QUESTION = '一弹簧振子作简谐振动，如果简谐振动振幅增加为原来的两倍，则它的总能量变为原来的';
const OPTIONS = ['二分之一', '两倍', '四倍', '四分之一'];

/* 假传输层：GO题(src) 和 桥的 /ai/ask 各回一份可配置的答案 */
function makeTransport(cfg) {
  const calls = { src: 0, ai: 0, urls: [] };
  function transport(o) {
    calls.urls.push(o.url);
    if (o.url.indexOf('/ai/ask') >= 0) {
      calls.ai++;
      const body = JSON.stringify({ question: JSON.parse(o.body).question,
                                    options: JSON.parse(o.body).options });
      const ans = typeof cfg.ai === 'function' ? cfg.ai(body) : cfg.ai;
      if (ans === null || ans === undefined) {
        return Promise.resolve(JSON.stringify({ ok: false, error: '模拟 AI 失败' }));
      }
      return Promise.resolve(JSON.stringify({ ok: true, answers: ans }));
    }
    calls.src++;
    const good = typeof cfg.src === 'function' ? cfg.src() : cfg.src;
    if (good === null) return Promise.resolve(JSON.stringify({ code: -1, data: '' }));
    return Promise.resolve(JSON.stringify({ code: 1, data: good }));
  }
  return { transport: transport, calls: calls };
}

function searcher(cfg, extra) {
  const t = makeTransport(cfg);
  const logs = [];
  const opts = Object.assign({
    transport: t.transport,
    sources: ['icodef'],
    minInterval: 0,
    maxRetries: 0,
    log: function (m) { logs.push(String(m)); }
  }, extra || {});
  return { s: C.makeSearcher(opts), calls: t.calls, logs: logs };
}

function ask(s) {
  return s.queryOnce({ question: QUESTION, options: OPTIONS, type: 'single' });
}

(async function () {
  console.log('\n=== A. 题库和 AI 不一致 -> 采用 AI ===');
  {
    const r = searcher({ src: '四分之一', ai: ['四倍'] }, { verifyAi: true });
    const resp = await ask(r.s);
    ok('题目拿到了答案', !!resp && resp.answer.bestAnswer.length === 1,
       JSON.stringify(resp && resp.answer));
    ok('采用 AI 的「四倍」（题库给的是错的「四分之一」）',
       resp && resp.answer.bestAnswer[0] === '四倍',
       JSON.stringify(resp && resp.answer.bestAnswer));
    ok('选项字母也跟着是 C（四倍）', resp && resp.answer.answerKeyText === 'C',
       resp && resp.answer.answerKeyText);
    ok('来源标记成 ai', resp && resp.source === 'ai', resp && resp.source);
    ok('说清了不一致（日志里能看见）',
       r.logs.some(function (l) { return l.indexOf('不一致') >= 0 && l.indexOf('AI') >= 0; }),
       r.logs.join(' | '));
    ok('问了 1 次题库 + 1 次 AI', r.calls.src === 1 && r.calls.ai === 1,
       JSON.stringify(r.calls));

    /* 缓存里存的必须是最终答案，否则同一页再查一次又会用错的 */
    const again = await ask(r.s);
    ok('再查一次：走缓存', !!again && again.fromCache === true);
    ok('缓存里也是 AI 的答案「四倍」',
       again && again.answer.bestAnswer[0] === '四倍',
       JSON.stringify(again && again.answer.bestAnswer));
    ok('缓存命中时不再重复请求', r.calls.src === 1 && r.calls.ai === 1,
       JSON.stringify(r.calls));
  }

  console.log('\n=== B. 两边一致 -> 保持题库的来源 ===');
  {
    const r = searcher({ src: '四倍', ai: ['四倍'] }, { verifyAi: true });
    const resp = await ask(r.s);
    ok('用的是「四倍」', resp && resp.answer.bestAnswer[0] === '四倍',
       JSON.stringify(resp && resp.answer.bestAnswer));
    ok('来源仍是 icodef（没有被改写成 ai）', resp && resp.source === 'icodef',
       resp && resp.source);
    ok('日志说「一致」', r.logs.some(function (l) { return l.indexOf('一致') >= 0; }),
       r.logs.join(' | '));
  }

  console.log('\n=== C. AI 没答上来 -> 沿用题库的（不冒风险） ===');
  {
    const r = searcher({ src: '四倍', ai: null }, { verifyAi: true });
    const resp = await ask(r.s);
    ok('仍然有答案「四倍」', resp && resp.answer.bestAnswer[0] === '四倍',
       JSON.stringify(resp && resp.answer.bestAnswer));
    ok('来源是 icodef', resp && resp.source === 'icodef', resp && resp.source);
    ok('日志说了 AI 没给答案',
       r.logs.some(function (l) { return /AI 校验.*没给出答案/.test(l); }),
       r.logs.join(' | '));
  }

  console.log('\n=== D. 关掉「AI 校验答案」-> 一次 AI 都不问 ===');
  {
    const r = searcher({ src: '四分之一', ai: ['四倍'] }, { verifyAi: false });
    const resp = await ask(r.s);
    ok('保持题库的答案「四分之一」', resp && resp.answer.bestAnswer[0] === '四分之一',
       JSON.stringify(resp && resp.answer.bestAnswer));
    ok('一次 AI 请求都没有', r.calls.ai === 0, JSON.stringify(r.calls));
  }

  console.log('\n=== E. 答案本来就是 AI 给的 -> 不再多问一次 ===');
  {
    const r = searcher({ src: null, ai: ['四倍'] }, { verifyAi: true, sources: ['ai'] });
    const resp = await ask(r.s);
    ok('拿到了 AI 的答案', resp && resp.answer.bestAnswer[0] === '四倍',
       JSON.stringify(resp && resp.answer.bestAnswer));
    ok('只问了 1 次 AI（没有自己跟自己校验）', r.calls.ai === 1, JSON.stringify(r.calls));
  }

  console.log('\n' + '='.repeat(58));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(58));
  process.exit(fail ? 1 : 0);
})();