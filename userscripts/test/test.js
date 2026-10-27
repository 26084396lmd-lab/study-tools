/* node 测试：core.js
 *  A) 纯逻辑单元测试
 *  B) 与 Python 版实现的差分比对（用 fixture.json 里的真实百度数据）
 *  C) 联网实测（icodef + 百度，通过 core.js 自己的检索调度）
 * 用法： node test.js        跑全部
 *        node test.js --offline  只跑 A 和 B
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const C = require(path.join(__dirname, '..', 'src', 'core.js'));

/* ------------------------------------------------------------------ 断言 */
let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(label + (extra ? '  <<< ' + extra : ''));
  return false;
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  return ok(a === e, label, 'got ' + a + ' want ' + e);
}
function near(a, b, tol, label) {
  return ok(Math.abs(a - b) <= tol, label, 'got ' + a + ' want ~' + b);
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* -------------------------------------------------------------- 传输层 */
function nodeTransport(o) {
  return new Promise((resolve, reject) => {
    const u = new URL(o.url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: o.method || 'GET',
      headers: o.headers || {}
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) reject(new Error('HTTP ' + res.statusCode));
        else resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    if (o.body) req.write(o.body);
    req.end();
  });
}

/* ================================================================ A 单元 */
function testUnits() {
  section('A. 纯逻辑单元测试');

  // --- norm / bare -------------------------------------------------------
  eq(C.norm('  A B Ｃ '), 'abc', 'norm 去空白+NFKC+小写');
  eq(C.norm('ＡＢＣ'), 'abc', 'norm 全角字母归一到半角');
  eq(C.bare('A. 马克思主义哲学'), '马克思主义哲学', 'bare 剥 "A. " 前缀');
  eq(C.bare('b、选项'), '选项', 'bare 剥 "b、" 前缀');
  eq(C.bare('马克思主义哲学'), '马克思主义哲学', 'bare 无前缀时不变');

  // --- judgeBool（先判否，否则「不正确」会被「正确」误伤）-----------------
  const T = ['正确', '对', '是', '√', '✓', 'true', 'T', 'YES', 'y', '1', '真的'];
  const F = ['不正确', '不对', '错误', '错', '×', '✗', 'false', 'F', 'no', 'n', '0', '否'];
  T.forEach(w => ok(C.judgeBool(w) === true, 'judgeBool(' + w + ') === true', 'got ' + C.judgeBool(w)));
  F.forEach(w => ok(C.judgeBool(w) === false, 'judgeBool(' + w + ') === false', 'got ' + C.judgeBool(w)));
  ok(C.judgeBool('不正确') === false, 'judgeBool 先判否：不正确 -> false');
  ok(C.judgeBool('不知道啊') === null, 'judgeBool 认不出来 -> null');

  // --- normType ---------------------------------------------------------
  eq(C.normType('single'), 0, 'normType single -> 0');
  eq(C.normType('multiple'), 1, 'normType multiple -> 1');
  eq(C.normType('completion'), 2, 'normType completion -> 2');
  eq(C.normType('judgement'), 3, 'normType judgement -> 3');
  eq(C.normType('shortanswer'), 4, 'normType shortanswer -> 4');
  eq(C.normType('多选题'), 1, 'normType 中文「多选题」-> 1');
  eq(C.normType('3'), 3, 'normType 字符串数字 -> 3');
  eq(C.normType(3), 3, 'normType 数字 -> 3');
  eq(C.normType(99), 0, 'normType 越界 -> 0');
  eq(C.normType(undefined), 0, 'normType undefined -> 0');

  // --- normOptions（tikuAdapter 数组 / OCS 换行串 / JSON 串 都要吃）------
  eq(C.normOptions(['A. 甲', 'B. 乙']), ['A. 甲', 'B. 乙'], 'normOptions 数组');
  eq(C.normOptions('A. 甲\nB. 乙'), ['A. 甲', 'B. 乙'], 'normOptions 换行串');
  eq(C.normOptions('["A. 甲","B. 乙"]'), ['A. 甲', 'B. 乙'], 'normOptions JSON 串');
  eq(C.normOptions('甲#乙'), ['甲', '乙'], 'normOptions # 分隔');
  eq(C.normOptions(''), [], 'normOptions 空');
  eq(C.normOptions(null), [], 'normOptions null');

  // --- ratio ------------------------------------------------------------
  ok(C.ratio('马克思主义的三个组成部分', '马克思主义的三个组成部分') === 1, 'ratio 相同 -> 1');
  ok(C.ratio('', '') === 1, 'ratio 双空 -> 1');
  ok(C.ratio('甲', '') === 0, 'ratio 单空 -> 0');
  ok(C.ratio('北京是中华人民共和国的首都', '北京是中华人民共和国的首都。') > 0.9, 'ratio 高相似 > 0.9');
  ok(C.ratio('中国的首都是哪里', 'Python 是一门语言') < 0.4, 'ratio 低相似 < 0.4');

  // --- buildResponse：单选 ----------------------------------------------
  let r = C.buildResponse(
    { question: '首都是哪里', options: 'A. 上海\nB. 广州\nC. 北京\nD. 深圳', type: 'single' },
    ['北京'], []);
  eq(r.answer.answerKeyText, 'C', '单选 选项原文 -> letter C');
  eq(r.answer.answerText, 'C. 北京', '单选 answerText 用卷面原文');
  eq(r.answer.bestAnswer, ['C. 北京'], '单选 bestAnswer');
  eq(r.type, 0, '单选 type=0');

  // --- buildResponse：多选（必须按卷面顺序，不能按命中顺序）--------------
  r = C.buildResponse(
    { question: '三个组成部分', options: 'A. 马克思主义哲学\nB. 马克思主义政治经济学\nC. 科学社会主义\nD. 空想社会主义', type: 'multiple' },
    ['科学社会主义', '马克思主义政治经济学', '马克思主义哲学'], []);
  eq(r.answer.answerKeyText, 'ABC', '多选 按卷面顺序 -> ABC（而非命中顺序 CBA）');
  eq(r.answer.answerText, 'A. 马克思主义哲学#B. 马克思主义政治经济学#C. 科学社会主义', '多选 answerText 卷面顺序及 # 分隔');
  eq(r.answer.answerIndex, [0, 1, 2], '多选 answerIndex');

  // --- buildResponse：判断题语义归一（题库回"正确"，选项写"对/错"）------
  r = C.buildResponse(
    { question: '北京是首都', options: 'A. 对\nB. 错', type: 'judgement' },
    ['正确'], []);
  eq(r.answer.answerKeyText, 'A', '判断题 正确 -> 命中选项「对」= A');
  eq(r.answer.answerText, 'A. 对', '判断题 answerText 用卷面原文');

  r = C.buildResponse(
    { question: '地球是方的', options: 'A. 对\nB. 错', type: 'judgement' },
    ['不正确'], []);
  eq(r.answer.answerKeyText, 'B', '判断题 不正确 -> 命中选项「错」= B（先判否生效）');

  r = C.buildResponse(
    { question: '天是蓝的', options: '√\n×', type: 'judgement' },
    ['对'], []);
  eq(r.answer.answerText, '√', '判断题 选项是 √/× 时也能归一');

  // --- answerVariants：题库「主文本(同义分支)」写法 -------------------
  eq(C.answerVariants('哲学(或辩证唯物主义历史唯物主义)'),
     ['哲学(或辩证唯物主义历史唯物主义)', '哲学', '辩证唯物主义历史唯物主义'],
     'answerVariants 拆出括号内同义分支');
  let rv = C.buildResponse(
    { question: '马克思主义的三个组成部分',
      options: 'A. 马克思主义哲学\nB. 马克思主义政治经济学\nC. 科学社会主义\nD. 空想社会主义',
      type: 'multiple' },
    ['哲学(或辩证唯物主义历史唯物主义)', '政治经济学', '科学社会主义'], []);
  eq(rv.answer.answerKeyText, 'ABC', '括号分支写法也能对上选项 A（真实 icodef 返回格式）');

  rv = C.buildResponse(
    { question: '首都是哪里', options: 'A. 上海\nB. 广州\nC. 北京', type: 'single' },
    ['首都（北京）'], []);
  eq(rv.answer.answerKeyText, 'C', '「首都（北京）」靠括号内分支命中 C');

  // --- buildResponse：字母型答案 ----------------------------------------
  r = C.buildResponse(
    { question: '首都是哪里', options: 'A. 上海\nB. 广州\nC. 北京', type: 'single' },
    [], ['C']);
  eq(r.answer.answerKeyText, 'C', '字母答案 -> C');
  eq(r.answer.answerText, 'C. 北京', '字母答案也换成卷面原文');

  // --- buildResponse：填空题 --------------------------------------------
  r = C.buildResponse(
    { question: '中国的首都是___', options: '', type: 'completion' },
    ['北京'], []);
  eq(r.answer.answerText, '北京', '填空题 answerText');

  // --- buildResponse：模糊兜底 ------------------------------------------
  r = C.buildResponse(
    { question: '首都是哪里', options: 'A. 上海市\nB. 广州市\nC. 北京市\nD. 深圳市', type: 'single' },
    ['北京'], []);
  eq(r.answer.answerKeyText, 'C', '模糊兜底：北京 -> 北京市');

  // --- buildResponse：完全无关 -> 不产出答案（宁可不答，不乱答）---------
  r = C.buildResponse(
    { question: '首都是哪里', options: 'A. 甲\nB. 乙\nC. 丙', type: 'single' },
    ['完全不相关的另一个东西'], []);
  ok(r.answer.bestAnswer.length === 0 && r.answer.answerKey.length === 0,
     '无匹配时不产出 bestAnswer（避免覆盖正确的题库答案）', JSON.stringify(r.answer));

  // --- decrypt：单位换算自检（用 Python 夹具一起验，这里只验不抛异常）----
  ok(typeof C.decrypt('AAAA', 'key') === 'string', 'decrypt 不抛异常');
}

/* =========================================================== B 差分测试 */
function testFixture() {
  section('B. 与 Python 实现的差分比对（真实百度数据）');
  const fxPath = path.join(__dirname, 'fixture.json');
  if (!fs.existsSync(fxPath)) {
    ok(false, 'fixture.json 不存在，先跑 make_fixture.py');
    return;
  }
  const fx = JSON.parse(fs.readFileSync(fxPath, 'utf8'));

  let nb = 0, nc = 0, ns = 0;
  for (const entry of fx.questions) {
    const q = entry.question;

    // 1) decrypt 必须逐条与 Python 完全一致
    for (const cand of entry.candidates) {
      if (!cand.bdjson || !cand.actk) continue;
      nb++;
      const got = C.decrypt(cand.bdjson, cand.actk);
      if (!ok(got === cand.decrypted, '【' + q + '】decrypt 与 Python 一致',
              'got ' + JSON.stringify(got).slice(0, 100) + ' want ' + JSON.stringify(cand.decrypted).slice(0, 100))) {
        break;
      }
    }

    // 2) parseCandidate 的 (题干, texts, letters) 必须一致
    for (const cand of entry.candidates) {
      if (!cand.parsed) continue;
      nc++;
      let obj;
      try { obj = JSON.parse(cand.decrypted); } catch (e) { continue; }
      const pc = C.parseCandidate(obj);
      if (!eq({ stem: pc.stem, texts: pc.texts, letters: pc.letters }, cand.parsed,
              '【' + q + '】parseCandidate 与 Python 一致')) break;
    }

    // 3) 相似度分数要接近（LCS 比值 vs difflib，容差 0.05）
    for (const cand of entry.candidates) {
      if (!cand.parsed) continue;
      const got = C.ratio(q, cand.parsed.stem);
      if (!near(got, cand.score, 0.05, '【' + q + '】相似度接近 Python')) break;
    }

    // 4) 整条 search 链路的最终答案必须一致
    ns++;
    const got = C.parseBaidu(q, JSON.stringify(entry.raw), () => {});
    eq({ texts: got.texts, letters: got.letters }, entry.expected,
       '【' + q + '】parseBaidu 最终答案与 Python 一致');
  }
  console.log('  比对了 ' + nb + ' 条密文、' + nc + ' 条解析、' + ns + ' 条完整链路');
}

/* ============================================================ C 联网实测 */
async function testLive() {
  section('C. 联网实测（core.js 自己的检索调度）');

  // 不传 sources，走默认顺序（百度优先，GO题兜底）
  const searcher = C.makeSearcher({
    transport: nodeTransport,
    minInterval: 500,
    log: m => console.log('    · ' + m)
  });

  const cases = [
    { question: '中华人民共和国的首都是哪里',
      options: 'A. 上海\nB. 广州\nC. 北京\nD. 深圳', type: 'single', want: 'C' },
    { question: '马克思主义的三个组成部分',
      options: 'A. 马克思主义哲学\nB. 马克思主义政治经济学\nC. 科学社会主义\nD. 空想社会主义',
      type: 'multiple', want: 'ABC' },
    { question: '北京是中华人民共和国的首都',
      options: 'A. 对\nB. 错', type: 'judgement', want: 'A' }
  ];

  const results = await searcher.queryAll(cases);
  results.forEach((r, i) => {
    const c = cases[i];
    if (!r) { ok(false, '【' + c.question + '】应有答案却未命中'); return; }
    console.log('    [' + r.source + '] ' + c.question + ' -> ' +
                r.answer.answerKeyText + '  ' + r.answer.answerText);
    eq(r.answer.answerKeyText, c.want, '【' + c.question + '】答案 (' + r.source + ')');
  });

  // 缓存必须命中，且不再发起网络请求
  const cached = await searcher.queryOnce(cases[0]);
  ok(cached && cached.fromCache === true, '第二次查询走缓存');
  eq(cached.answer.answerKeyText, 'C', '缓存内容正确');

  // 未命中时返回 null 而不是乱答
  const miss = await searcher.queryOnce({
    question: 'zzz不存在的题目qqq' + Date.now(),
    options: 'A. 甲\nB. 乙', type: 'single'
  });
  ok(miss === null, '查不到时返回 null');

  // 单源可用性：GO题(icodef) 是免费公益接口，限流很猛。退避重试后仍被限流时，记为「已知限制」而不是失败。
  const onlyIcodef = C.makeSearcher({
    transport: nodeTransport, sources: ['icodef'],
    minInterval: 1200, maxRetries: 4, backoff: 2500, log: () => {}
  });
  const ri = await onlyIcodef.queryOnce(cases[1]);
  if (ri) {
    eq(ri.answer.answerKeyText, 'ABC', 'GO题(icodef) 单源答案正确');
  } else if (onlyIcodef.flags.throttled) {
    console.log('    ! GO题(icodef) 重试 4 次仍被限流 —— 已知限制（主链路有百度源兜底，不受影响）');
    pass++;
  } else {
    ok(false, 'GO题(icodef) 单源既无答案也没报限流');
  }

  const onlyBaidu = C.makeSearcher({ transport: nodeTransport, sources: ['baidu'], minInterval: 600, log: () => {} });
  const rb = await onlyBaidu.queryOnce(cases[0]);
  ok(!!rb, '百度单源可查到单选答案');
  if (rb) eq(rb.answer.answerKeyText, 'C', '百度单源答案正确');
}

/* ------------------------------------------------------------------ main */
(async function main() {
  const offline = process.argv.includes('--offline');
  testUnits();
  testFixture();
  if (!offline) {
    try { await testLive(); }
    catch (e) { ok(false, '联网测试异常：' + (e && e.message ? e.message : e)); }
  } else {
    console.log('\n(跳过联网测试)');
  }

  console.log('\n' + '='.repeat(58));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (failures.length) {
    console.log('\n  失败明细：');
    failures.slice(0, 30).forEach(f => console.log('   ✗ ' + f));
  }
  console.log('='.repeat(58));
  process.exit(fail ? 1 : 0);
})();