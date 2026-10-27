/* ============================================================================
 *  main.js —— 调度：把 core（题库引擎）+ chaoxing（页面适配）+ panel（界面）串起来
 * ==========================================================================*/
(function (root) {
  'use strict';

  var C = root.FreeTikuCore, CX = root.FreeTikuChaoxing, Panel = root.FreeTikuPanel, PL = root.FreeTikuPipeline, VK = root.FreeTikuVideo;
  if (!C || !CX || !Panel) {
    /* 模块没挂上绝不能静悄悄退出 —— 必须把原因报回桌面那个黑窗口，
       否则「脚本没被注入」和「注入了但中途失败」在用户眼里长得一模一样。 */
    var _missing = 'C=' + (!!C) + ' CX=' + (!!CX) + ' Panel=' + (!!Panel);
    try { root.__ftkStuck = 'modules-missing ' + _missing; } catch (e) { /* ... */ }
    try { if (typeof root.__ftkBeacon === 'function') root.__ftkBeacon('modules-missing', _missing); }
    catch (e) { /* ... */ }
    console.error('[免费题库] 模块没加载全，脚本构建有问题：' + _missing);
    return;
  }

  var K_SET = 'ftk_settings_v1', K_CACHE = 'ftk_cache_v1';

  /* ----------------------------------------------------------- 设置持久化 */
  function gmGet(k, d) {
    try { return (typeof GM_getValue === 'function') ? GM_getValue(k, d) : JSON.parse(localStorage.getItem(k)) || d; }
    catch (e) { return d; }
  }
  function gmSet(k, v) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(k, v);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { /* 存不下就算了 */ }
  }

  var savedSettings = gmGet(K_SET, {});
  if (!savedSettings || typeof savedSettings !== 'object' || Object.prototype.toString.call(savedSettings) === '[object Array]') savedSettings = {};
  var settings = Object.assign({ auto: false, guess: false, overwrite: false, baidu: true, icodef: true, ai: true, verifyAi: true, logDetail: false, pipe: false, minHit: 80, video: true, rate: 2, mediaWait: 8 }, savedSettings);
  var panel = null, stopFlag = false, running = false, panelSig = '', lastPageKey = '';
  var cmdPolled = false, traceN = 0;
  /* sessionStorage 不可用时（沙箱/隐私模式/测试环境）的内存兜底：
     不能让 isPaused() 永远返回 true，否则点了启动也什么都不干。 */
  var runArmed = false;

  /* 「启动 / 停止」必须存在 sessionStorage 里。交卷/重做会让 iframe 整个重新加载，
     脚本重新注入，内存里的标记就归零了 —— 这正是「点停止没用」的原因。
     同一个标签页里同源框架共用 sessionStorage，正好当这个总开关。
     v1.3.1 起语义改成「一键启动」：默认**什么都没启动**（不答题、不播视频），
     用户点一次「▶ 一键启动」才打开 K_RUN，点「■ 全部停止」关掉。 */
  var K_RUN = 'ftk_run_v1', K_PAUSED = 'ftk_paused';

  function isRunning() {
    try { return sessionStorage.getItem(K_RUN) === '1' || runArmed; }
    catch (e) { return runArmed; }
  }
  /* 启动：总开关打开，顺手清掉老版本留下的「暂停」标记 */
  function armRun() {
    runArmed = true;
    try { sessionStorage.setItem(K_RUN, '1'); sessionStorage.removeItem(K_PAUSED); }
    catch (e) { /* 存不下就只当这一次有效 */ }
    stopFlag = false;
  }
  /* 停止：总开关关掉，并写上「暂停」标记 —— 老代码里那些 isPaused() 判据照样生效 */
  function disarmRun() {
    runArmed = false;
    try { sessionStorage.removeItem(K_RUN); sessionStorage.setItem(K_PAUSED, '1'); }
    catch (e) { /* 存不下就只当这一次有效 */ }
    stopFlag = true;
  }
  /* 没启动 == 暂停：所有「要不要自动干活」的判断都从这里走，一处收口 */
  function isPaused() {
    try {
      if (sessionStorage.getItem(K_PAUSED) === '1') return true;
      return sessionStorage.getItem(K_RUN) !== '1';
    } catch (e) { return !runArmed; }
  }
  function setPaused(b) { if (b) disarmRun(); else armRun(); }

  /* 真正把这一层的媒体停下来。
     以前「停止」只写暂停标记，video.js 的看门狗和 pause 监听还会把视频按回播放；
     而且面板常在最外层，视频在子框架里，只调本层 VK.stop 根本够不着。
     现在让每一层都走这个函数（ctlEach 广播），并且顺手放开 playbackRate，
     用户手动点播放/暂停/调倍速都不会再被脚本抢回去。 */
  /* 自动交卷/翻页时，学习通可能在 click 里同步弹原生 confirm/alert。
     原生模态会冻结整个标签页：面板停止、拖动、定时器全部停摆，看起来就是
     「页面卡死」。这里只在这一次点击期间静默掉它，点完立刻恢复页面原函数。 */
  function fireClickSafe(el) {
    /* 篡改猴有 @grant 时 root 是沙箱 window，页面弹窗用的是 unsafeWindow；
       两个都要压住，否则原生 confirm 照样会冻结标签页。 */
    var wins = [];
    try { wins.push(root); } catch (e0) { /* ... */ }
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow !== root) wins.push(unsafeWindow);
    } catch (e1) { /* ... */ }
    var saved = [];
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      var rec = { w: w, confirm: null, alert: null, c: false, a: false };
      try { rec.confirm = w.confirm; w.confirm = function () { return true; }; rec.c = true; } catch (e2) { /* ... */ }
      try { rec.alert = w.alert; w.alert = function () { }; rec.a = true; } catch (e3) { /* ... */ }
      saved.push(rec);
    }
    try {
      return CX.fireClick(el);
    } finally {
      for (var j = 0; j < saved.length; j++) {
        var s = saved[j];
        if (s.c) { try { s.w.confirm = s.confirm; } catch (e4) { /* ... */ } }
        if (s.a) { try { s.w.alert = s.alert; } catch (e5) { /* ... */ } }
      }
    }
  }

  function stopLocal(why, quiet) {
    var had = false;
    try { had = !!videoStarted; } catch (e0) { /* ... */ }
    setPaused(true);
    videoStarted = false;
    try { if (VK && VK.stop) VK.stop(why || '用户停止'); } catch (e1) { /* ... */ }
    try {
      var ms = document.querySelectorAll('video, audio');
      for (var i = 0; i < ms.length; i++) {
        try { if (VK && VK.unlockRate) VK.unlockRate(ms[i]); } catch (e2) { /* ... */ }
        try { ms[i].pause(); } catch (e3) { /* ... */ }
      }
    } catch (e4) { /* ... */ }
    try {
      if (had && !quiet && panel && panel.log) {
        panel.log('视频/音频已暂停（用户停止）。', 'dim');
      }
    } catch (e5) { /* ... */ }
  }

  /* 这份测验的稳定身份：结果页和作答页地址里都有 workId / jobid，
     拿它当钥匙；地址每次跳转都变一点也不会让「重做过一次」的判断失效。 */
  function workIdOf(u) {
    u = String(u || '');
    var m = /[?&](?:workId|jobid|jobId)=([^&#]+)/.exec(u);
    if (m) return 'w' + m[1];
    return u.replace(/[?#].*$/, '');
  }

  /* 没及格时要清掉桥那边的答题缓存：不清的话重做用的还是同一批错答案。 */
  function forgetCache(why) {
    try {
      transport({
        url: BRIDGE + '/forget', method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}'
      }).then(function () { pipeLog('已清掉桥那边的答题缓存（' + why + '），重做会重新查。'); })
        .catch(function () { /* 清不掉也不影响这一次作答 */ });
    } catch (e) { /* ... */ }
  }
  var topAdv = null;            // 本框架（最外层）安装出来的课程树服务

  /* 最外层框架没有面板，流水线的日志先存在这里，点左下角徽标能看到 */
  var trickle = [];
  function pipeLog(msg, kind) {
    trickle.push(msg);
    if (trickle.length > 60) trickle.shift();
    try { console.log('[免费题库/流水线] ' + msg); } catch (e) { /* ... */ }
    try { if (panel) panel.log(msg, kind); } catch (e) { /* ... */ }
  }

  /* ------------------------------------------------------------- 网络传输 */
  function transport(o) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        // 没有 GM API（比如直接用浏览器打开）就退回 fetch，百度源会因为 CORS 失败
        fetch(o.url, { method: o.method, headers: o.headers || {}, body: o.body })
          .then(function (r) { return r.text(); }).then(resolve).catch(reject);
        return;
      }
      GM_xmlhttpRequest({
        method: o.method || 'GET',
        url: o.url,
        headers: o.headers || {},
        data: o.body,
        timeout: o.timeout || 60000,
        onload: function (r) {
          if (r.status >= 200 && r.status < 400) resolve(r.responseText);
          else reject(new Error('HTTP ' + r.status));
        },
        ontimeout: function () { reject(new Error('超时')); },
        onerror: function () { reject(new Error('网络错误')); }
      });
    });
  }

  /* ------------------------------------------------------------ 缓存持久化 */
  var cache = gmGet(K_CACHE, {});
  var cacheCount = 0;
  function saveCache() {
    if (++cacheCount % 5) return;
    var keys = Object.keys(cache);
    if (keys.length > 1200) {                       // 别把 GM 存储撑爆
      keys.slice(0, keys.length - 900).forEach(function (k) { delete cache[k]; });
    }
    gmSet(K_CACHE, cache);
  }

  function makeSearcher() {
    var srcs = [];
    if (settings.baidu !== false) srcs.push('baidu');
    if (settings.icodef !== false) srcs.push('icodef');
    if (settings.ai !== false) srcs.push('ai');   // AI 永远排最后：百度搜不到才花钱
    if (!srcs.length) srcs = ['baidu'];
    return C.makeSearcher({
      transport: transport,
      sources: srcs,
      cache: cache,
      minInterval: 900,        // 温柔点，别把公益接口打冒烟
      maxRetries: 2,
      backoff: 2000,
      log: function (m) { if (panel) panel.detail(m); },
      onCache: saveCache
    });
  }

  /* 图片公式题：把题干/选项里的公式图整理成有序列表，交给桥的视觉接口。
     顺序必须和卷面一致：先题干，再按选项 A/B/C/D 排；桥会把每张图
     标成「题干 / 选项A」，模型读出来的公式才能对回正确选项。 */
  function visionImages(q) {
    var out = [], seen = {};
    function add(url, where, label) {
      url = String(url || '').trim();
      if (!url || seen[url]) return;
      seen[url] = 1;
      out.push({ url: url, where: where, label: label });
    }
    (q.stemImages || []).forEach(function (u) { add(u, 'stem', '题干'); });
    (q.options || []).forEach(function (o) {
      (o.images || []).forEach(function (u) { add(u, 'option', o.letter); });
    });
    return out.slice(0, 12);
  }

  async function askVision(q) {
    var images = visionImages(q);
    if (!images.length) return null;
    var opts = (q.options || []).map(function (o) { return o.text; });
    var letters = (q.options || []).map(function (o) { return o.letter; });
    var raw;
    try {
      raw = await transport(C.aiRequest(q.stem, opts, q.type, images, letters));
    } catch (e) {
      panel.log('视觉接口请求失败：' + ((e && e.message) || e), 'err');
      return null;
    }
    var parsed = null, why = '';
    try {
      parsed = C.parseAi(raw, function (m) { why = String(m || ''); });
    } catch (e2) {
      why = (e2 && e2.message) || String(e2);
    }
    if (!parsed || (!parsed.texts.length && !parsed.letters.length)) {
      if (why) panel.log('视觉识别没有结果：' + why, 'warn');
      return null;
    }
    var resp = C.buildResponse(
      { question: q.stem, options: opts, type: q.type },
      parsed.texts, parsed.letters
    );
    if (!resp || !resp.answer || !resp.answer.bestAnswer.length) return null;
    resp.source = 'AI视觉';
    return resp;
  }

  /* --------------------------------------------------------------- 主流程 */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 学习通的题干/选项里有一部分字被换成了「假字」（页面上照样显示正常，
  // 源码里读出来是乱码）。解密在本地桥里做 —— 那边有 fontTools 和字形表。
  // 这里只负责：把文字和页面里的字体一起送过去，再把还原后的文字填回题目。
  async function decodeQuestions(questions, panel) {
    var font = '';
    try { font = CX.fontData ? CX.fontData() : ''; } catch (e) { font = ''; }
    if (!font) {
      panel.log('本页没发现加密字体（#cxSecretStyle），按原文查。', 'dim');
      return 0;
    }
    var texts = [];
    questions.forEach(function (q) {
      texts.push(q.stem || '');
      (q.options || []).forEach(function (o) { texts.push(o.text || ''); });
    });
    panel.log('发现加密字体（' + Math.round(font.length / 1024) + ' KB），正在还原文字…');
    var raw;
    try {
      raw = await transport({
        url: BRIDGE + '/decode',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: texts, font: font })
      });
    } catch (e) {
      panel.log('还原失败（桥没连上？）：' + (e && e.message) + '　→ 按乱码原文查', 'warn');
      return 0;
    }
    var res = null;
    try { res = JSON.parse(raw); } catch (e) { res = null; }
    if (!res || !res.ok || !res.texts || res.texts.length !== texts.length) {
      panel.log('还原失败：' + ((res && res.error) || '返回格式不对') + '　→ 按乱码原文查', 'warn');
      return 0;
    }
    var k = 0;
    questions.forEach(function (q) {
      q.stem = res.texts[k++];
      (q.options || []).forEach(function (o) { o.text = res.texts[k++]; });
    });
    if (!res.changed) {
      panel.log('还原了 0 个字：字体拿到了，但字形表对不上，题干仍是乱码，多半查不到。', 'err');
      return 0;
    }
    panel.log('已还原 ' + res.changed + ' 个加密字（' + (res.note || '') + '）。', 'ok');
    panel.detail('还原后第 1 题：' + questions[0].stem);
    return res.changed;
  }

  async function run() {
    if (running) return;
    armRun();                  // 点「一键启动」→ 打开总开关
    idleDone = {}; emptyDone = {};   // 新一轮重新判断空页，别被上一轮记住的 URL 挡住
    /* 可能是被面板按钮「派发」过来的，此时本框架还没拿过面板对象 */
    panel = ensurePanel();
    if (!panel) return;
    running = true; stopFlag = false;
    if (panel.running) panel.running(true);
    if (panel.clear) panel.clear();

    var failed = false;
    try {
      await runBody();
    } catch (e) {
      failed = true;
      /* 答题过程中炸了也要说一声：这里不 catch 的话，
         run() 的 promise 没人接，就变成 unhandled rejection 了。 */
      try {
        panel.log('答题过程中出错了：' + ((e && e.message) || e), 'err');
        panel.status('出错了，看日志最后一行');
      } catch (e2) { /* ... */ }
      console.error('[免费题库] run() 出错', e);
    } finally {
      /* 不管是正常结束、还是中途抛了异常，按钮状态都必须回到「空闲」。
         否则「开始答题」会被永久禁用 —— 就是「点了没反应」的死因之一。
         异常退出时顺手关总开关；否则按钮会停在「全部停止」，用户没法重试。 */
      running = false;
      if (failed) {
        try { disarmRun(); } catch (eD) { /* ... */ }
      }
      /* 按钮状态跟着「总开关」走，不跟这一帧的 run() 走：
         流水线跳到下一节时总开关还开着，按钮必须继续显示「全部停止」。 */
      try { if (panel && panel.running) panel.running(isRunning()); } catch (e9) { /* ... */ }
    }
  }

  async function runBody() {
    var kind = CX.pageKind();
    if (kind === 'exam') {
      panel.status('这是考试页面');
      panel.log('检测到考试页面。考试风控很严（切屏检测、移动验证码、服务端加密），本脚本不支持，已退出。', 'err');
      running = false; panel.running(isRunning());
      return;
    }

    /* 结果页上 `.TiMu` 仍然在，用户误点「一键启动」时，旧逻辑会把已经
       全对的题再答一遍。这里在入口处再拦一次，和 boot 的结果页判断互为
       双保险。 */
    var _rs = null;
    try { _rs = CX.resultState ? CX.resultState() : null; } catch (eR) { _rs = null; }
    if (_rs) {
      panel.status(_rs === 'fail' ? '这一页已经批改：没及格，不会自动重做' : '这一页已经批改：已通过');
      panel.log('这一页是结果页，不再重复作答。' +
                '（要重做请自己点页面上的「重做」，或点面板上的「重做」。）', 'warn');
      running = false; panel.running(isRunning());
      return;
    }

    var questions = CX.extractQuestions();
    if (!questions.length) {
      panel.status('没找到题目');
      panel.log('本页没解析到题目（.TiMu / .singleQuesId 都没命中）。请在章节测验页面点击「▶ 一键启动」。', 'warn');
      running = false; panel.running(isRunning());
      return;
    }

    // 先还原被字体加密的文字，否则拿乱码去查题库是查不到的
    await decodeQuestions(questions, panel);

    var searcher = makeSearcher({ verifyAi: settings.verifyAi !== false && settings.ai !== false });
    panel.log('共 ' + questions.length + ' 题，数据源：' + (settings.baidu !== false ? '百度教育 ' : '') + (settings.icodef !== false ? 'GO题 ' : '') + (settings.ai !== false ? 'AI兜底' : '') + '。开始。');

    var hit = 0, miss = 0, skipped = 0, imageFail = 0, imageVisionHit = 0;
    for (var i = 0; i < questions.length; i++) {
      if (stopFlag || isPaused()) { panel.log('已手动停止。', 'warn'); break; }
      var q = questions[i];
      panel.progress(i, questions.length, hit);

      var tag = '[' + (i + 1) + '] ' + (q.type === 'multiple' ? '多选 ' : q.type === 'judgement' ? '判断 ' : q.type === 'completion' ? '填空 ' : '单选 ');
      if (q.answered && !settings.overwrite) {
        /* 已有答案的题既不算命中也不算未命中：它不参与命中率分母。
           以前分母一律是 questions.length，于是「都答好了」也会被拖到门槛以下，不交卷。 */
        skipped++;
        panel.log(tag + '已有答案，跳过（可勾「覆盖已填答案」）', 'dim');
        panel.detail('题干：' + q.stem);
        continue;
      }

      if (q.imageOnly || q.blindImage) {
        /* 纯图片选项，或「波的频率为［式］」这种关键公式藏在图片里的题。
           v1.3.11 起视觉识别成功后按普通题处理：计入命中，命中率够就自动交卷。
           识别失败仍然不猜、不填空白，并在收尾时停下来等人工处理。 */
        var _imgWhy = q.imageOnly ? '选项是图片/公式' : '题干或选项里有图片公式';
        panel.log(tag + '⚠ ' + _imgWhy + '，正在用视觉模型识别图片…', 'warn');
        panel.detail('题干：' + q.stem);
        var vresp = null;
        if (settings.ai === false) {
          imageFail++;
          panel.log(tag + '　AI 兜底已关闭，读不了图片公式；已跳过，不乱填。', 'warn');
        } else {
          vresp = await askVision(q);
        }
        if (stopFlag || isPaused()) {
          panel.log('已手动停止，图片题的识别结果不再填入。', 'warn');
          break;
        }
        if (vresp) {
          var vres = CX.apply(q, vresp, settings);
          if (vres.applied) {
            hit++; imageVisionHit++;
            panel.log(tag + '✅ 视觉识别并填写：' + vresp.answer.answerKeyText + '　' +
                      (vres.detail || vresp.answer.answerText) +
                      '　（来源 AI视觉；和普通题一样计入自动交卷）', 'ok');
          } else {
            imageFail++;
            miss++;
            panel.log(tag + '⚠ 视觉模型读出了答案，但没定位到卷面选项：' + vres.how, 'warn');
          }
        } else {
          imageFail++;
          miss++;
          panel.log(tag + '⚠ 视觉模型也没读出这道题的公式，已跳过不乱填。', 'warn');
        }
        await sleep(350);
        continue;
      }

      var resp = null;
      try {
        resp = await searcher.queryOnce({
          question: q.stem,
          options: q.options.map(function (o) { return o.text; }),
          type: q.type
        });
      } catch (e) {
        panel.log(tag + '查询异常：' + (e && e.message), 'err');
      }

      if (!resp || !resp.answer || !resp.answer.bestAnswer.length) {
        miss++;
        var why = '';
        try {
          var ms = searcher.miss();
          if (ms && ms.length) why = '　→ ' + ms.join('；');
        } catch (e2) { /* 诊断信息拿不到就算了 */ }
        panel.log(tag + '没搜到答案' + why, 'warn');
        panel.log(tag + '　题干：' + String(q.stem).slice(0, 50) + '　选项：' +
          q.options.map(function (o) {
            return o.letter + ':' + String(o.text).slice(0, 14);
          }).join(' / '), 'dim');
        panel.detail('题干：' + q.stem);
        if (settings.guess) {
          var rnd = q.options.length ? q.options[Math.floor(Math.random() * q.options.length)] : null;
          if (rnd) {
            CX.apply(q, { answer: { answerKeyText: rnd.letter, bestAnswer: [rnd.text] } }, settings);
            panel.log('   → 已随机蒙：' + rnd.letter + '、' + rnd.text, 'dim');
          }
        }
        await sleep(400);
        continue;
      }

      /* 用户可能在等网络请求时点了「全部停止」。拿到结果后先看一眼总开关，
         不要继续往页面上填，更不要自动交卷。 */
      if (stopFlag || isPaused()) {
        panel.log('已手动停止，这次查询结果不再填入。', 'warn');
        break;
      }

      var res = CX.apply(q, resp, settings);
      if (res.applied) {
        hit++;
        panel.log(tag + '✅ ' + resp.answer.answerKeyText + '　' + (res.detail || resp.answer.answerText) +
                   '　（来源 ' + (resp.source || '缓存') + (resp.fromCache ? '/缓存' : '') + '）', 'ok');
      } else {
        miss++;
        panel.log(tag + '⚠ 搜到了但没填上：' + res.how + '　答案=' + resp.answer.answerText, 'warn');
        panel.log(tag + '　选项：' + q.options.map(function (o) {
          return o.letter + ':' + String(o.text).slice(0, 14);
        }).join(' / '), 'dim');
      }
      panel.detail('题干：' + q.stem);
      await sleep(600);
    }

    panel.progress(questions.length, questions.length, hit);
    panel.log('—— 结束：命中 ' + hit + '，未命中 ' + miss + (skipped ? '，已填过跳过 ' + skipped : '') +
              '，共 ' + questions.length + ' ——', hit ? 'ok' : 'warn');

    /* 命中率只看「真正要我们作答的题」：跳过的题不该把分母撑大 */
    var total = questions.length - skipped;
    var rate = total > 0 ? Math.round(hit / total * 100) : 0;
    var need = (settings.minHit == null ? 80 : settings.minHit);

    /* 全是「已有答案，跳过」时要说人话，不然用户只会觉得「点了没反应」 */
    if (questions.length && hit === 0 && miss === 0) {
      panel.status('这 ' + questions.length + ' 题都已经填过了');
      panel.log('这 ' + questions.length + ' 题页面上都已经有答案了，我没有动它们。' +
                (settings.overwrite ? '' : '想重来一遍：勾上「覆盖已填答案」，或点面板上的「重做」。'), 'warn');
    }

    if (imageFail) {
      /* 识别成功的图片题和普通题一样参与自动交卷；只有真正没识别出来、
         页面上还是空白的图片题才拦下，避免把空白答案交上去。 */
      panel.log('有 ' + imageFail + ' 题图片公式没识别出来，已停下不乱填。' +
                (imageVisionHit ? '另外 ' + imageVisionHit + ' 题已识别并填好。' : ''), 'err');
      panel.status('图片公式没识别出来，已停下等你手动处理');
      /* 自动流程确实已经停了，按钮要回到「▶ 一键启动」，否则用户会以为
         它还在后台跑（也方便手动补完后重新开始）。 */
      try { disarmRun(); } catch (eI) { /* ... */ }
    } else if (settings.pipe && (stopFlag || isPaused())) {
      /* 用户按过停止：命中率再高也不许自动交卷（以前这里不看 stopFlag） */
      panel.log('已暂停，不自动交卷。填好的答案都还在页面上。', 'warn');
      panel.status('已暂停，没有自动交卷');
    } else if (settings.pipe) {
      /* 流水线：命中率够就交卷，交完自动切到下一个章节测验 */
      if (rate >= need) {
        panel.log('命中率 ' + rate + '% ≥ 门槛 ' + need + '%，直接交卷。', 'warn');
        var clicked = await submitAndConfirm();
        if (clicked && await waitSubmitted(9000)) {
          panel.log('这一页已经交上去了，自动切下一个。', 'ok');
          await sleep(900);
          var r = PL ? PL.advance({ log: pipeLog }) : null;
          if (r && !r.ok) panel.status('流水线停下：' + (r.why || '没有下一个了'));
        } else if (!clicked) {
          panel.log('没交上，流水线不再往下切（避免把没提交的题跳过去）。', 'err');
          panel.status('没交上，已停下');
        } else {
          panel.log('点了提交、也点过确认框，但没看出交上去的样子。流水线停在这里，避免把没交的题跳过去。', 'err');
          panel.status('不确定交上没有，已停下');
        }
      } else {
        panel.log('命中率 ' + rate + '% 低于门槛 ' + need + '%，只填不交。流水线停在这里，等你手动处理。', 'err');
        panel.status('命中率不足，已停下等你手动处理');
      }
    } else if (settings.auto && hit > 0 && !stopFlag && !isPaused()) {
      panel.log('直接交卷……', 'warn');
      await submitAndConfirm();
    } else if (hit > 0) {
      panel.status('答完了。核对无误后自己点「交卷」，或去页面上提交。');
    }

  }

  /* 交上去没有？只能靠现场痕迹判断，所以保守一点：拿不准就算「不知道」 */
  function checkSubmitted() {
    try {
      var st = CX.resultState && CX.resultState();
      if (st) return true;                       // 已经变成成绩/结果页了
    } catch (e) { /* ... */ }
    try {
      var btn = CX.findSubmit();
      if (!btn) return true;                     // 提交按钮消失了，基本就是交上去了
    } catch (e) { /* ... */ }
    try {
      if (CX.extractQuestions().length === 0 && /成绩|得分|已完成|提交成功|我的答案/.test(document.body.textContent || '')) return true;
    } catch (e) { /* ... */ }
    return false;
  }

  /* 点提交 + 点掉「确认提交？」。确认框可能晚半秒才出来、可能挂在外层文档上、
     也可能连着弹两层，所以这里循环多试几次，而不是只试一次。 */
  async function submitAndConfirm() {
    var btn = CX.findSubmit();
    if (!btn) {
      panel.log('没找到提交按钮，请自己在页面上点提交。', 'warn');
      return false;
    }
    panel.log('点击提交：' + (CX.txt(btn) || btn.value || '(按钮)'), 'warn');
    fireClickSafe(btn);

    var rounds = 0;
    for (var i = 0; i < 12; i++) {
      await sleep(500);
      if (CX.confirmDialog()) {
        rounds++;
        panel.log('已点掉「确认提交」（第 ' + ((i + 1) * 0.5).toFixed(1) + ' 秒）。', 'ok');
        for (var j = 0; j < 4; j++) {              // 有的版式会连弹两层
          await sleep(400);
          if (!CX.confirmDialog()) break;
          rounds++;
          panel.log('又点掉一层确认框。', 'ok');
        }
        break;
      }
      if (checkSubmitted()) return true;           // 不需要确认，直接就上去了
    }
    if (!rounds) {
      panel.log('没看到「确认提交」框（可能不需要确认，也可能它在我们没权限访问的框架里）。', 'dim');
    }
    return true;
  }

  /* 交上去没有？页面可能整页刷新、也可能过几秒才变样，所以多等一会儿 */
  async function waitSubmitted(ms) {
    var waited = 0;
    while (waited < ms) {
      if (checkSubmitted()) return true;
      await sleep(600);
      waited += 600;
    }
    return checkSubmitted();
  }

  /* 面板上那个红色「交卷」按钮走这里（手动路径，先问一句） */
  async function doSubmit() {
    panel = ensurePanel();
    if (!panel) return false;
    if (!settings.pipe && !confirm('确定要提交这份答题吗？提交后通常不能改。')) return false;
    var ok = await submitAndConfirm();
    if (ok) {
      await sleep(2500);
      if (checkSubmitted()) panel.log('已交上去了。', 'ok');
      else panel.log('点了提交，但没看出交上去的样子；请自己在页面上确认一下。', 'warn');
    }
    return ok;
  }

  /* ====================== 常驻徽标 + 自检（证明脚本到底有没有在跑） ====================== */
  var VERSION = '1.3.12';
  try { root.__ftkVersion = VERSION; } catch (eVer) { /* ... */ }
  var BRIDGE = 'http://127.0.0.1:8060';
  var MONO = 'font:12px/1.6 ui-monospace,Consolas,monospace;';

  function isTop() { try { return root.top === root.self; } catch (e) { return false; } }

  function el(tag, css, text) {
    var d = document.createElement(tag);
    if (css) d.setAttribute('style', css);
    if (text !== undefined && text !== null) d.textContent = text;
    return d;
  }

  /* 递归扫同源框架，数每个框架里的题目容器 .TiMu / .singleQuesId */
  function scanFrames() {
    var out = [];
    function walk(w, depth) {
      var doc = null;
      try { doc = w.document; } catch (e) { return; }
      if (!doc) return;
      var url = '(读不到地址)';
      try { url = String(w.location.href); } catch (e) { /* 读不到就算了 */ }
      var n = -1;
      try { n = doc.querySelectorAll('div.TiMu, div.singleQuesId').length; } catch (e) { /* 同上 */ }
      out.push({ depth: depth, url: url, n: n });
      if (depth >= 3) return;
      var fr;
      try { fr = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
      for (var i = 0; i < fr.length; i++) {
        var src = '';
        try { src = String(fr[i].src || ''); } catch (e) { /* 同上 */ }
        var cw = null;
        try { cw = fr[i].contentWindow; } catch (e) { cw = null; }
        if (!cw) { out.push({ depth: depth + 1, url: src || '(空框架)', n: -2 }); continue; }
        var ok = true;
        try { void cw.document; } catch (e) { ok = false; }
        if (!ok) { out.push({ depth: depth + 1, url: src || '(跨域框架)', n: -2 }); continue; }
        walk(cw, depth + 1);
      }
    }
    try { walk(root, 0); } catch (e) { /* 扫不动就返回已扫到的 */ }
    return out;
  }

  /* 结果页上的「重做」入口 */
  function findRework() {
    var ns = document.querySelectorAll('a, button, span, div, input[type=button], input[type=submit]');
    for (var i = 0; i < ns.length; i++) {
      /* 面板本身的按钮就叫「重做」，不能把它当成页面上的重做入口，
         否则 onRework -> findRework -> 点自己 -> onRework 同步递归，页面直接卡死。 */
      try { if (ns[i].closest && ns[i].closest('#ftk-panel,#ftk-badge,#ftk-xframe')) continue; } catch (e0) { /* ... */ }
      var t = String(ns[i].textContent || ns[i].value || '').replace(/\s+/g, '');
      if (!t || t.length > 8) continue;
      if (t === '重做' || t === '重新做' || t === '再做一次' || t === '重新答题' || t === '重做此题') return ns[i];
    }
    return null;
  }

  function pingBridge(cb) {
    if (typeof GM_xmlhttpRequest !== 'function') { cb('无法探测（当前没有 GM API）'); return; }
    GM_xmlhttpRequest({
      method: 'GET', url: BRIDGE + '/health', timeout: 4000,
      onload: function (r) { cb(r.status === 200 ? '正常（HTTP 200）' : '异常，HTTP ' + r.status); },
      ontimeout: function () { cb('无响应 —— 桌面上的「启动免费题库.bat」可能没在跑'); },
      onerror: function () { cb('连不上 127.0.0.1:8060 —— 服务没启动'); }
    });
  }

  /* 往桌面那个黑窗口回一行「脚本已连上」。
     1.0.4 起改成调 beacon 模块统一发（那个模块排在所有模块最前面、几乎不会失败），
     这样即便 core/panel/chaoxing 挂了，也一定有一行回执能到黑窗口。 */
  var reported = false;
  function reportBoot() {
    if (reported) return;
    reported = true;
    root.__ftkReady = true;                       /* 告诉 beacon：我走到这一步了，别报 STUCK */
    var q = 0, kind = '?';
    try { q = CX.extractQuestions().length; } catch (e) { /* ... */ }
    try { kind = CX.pageKind(); } catch (e) { /* ... */ }
    try {
      if (typeof root.__ftkBeacon === 'function') {
        root.__ftkBeacon('ok', 'ver=' + VERSION + ' kind=' + kind + ' q=' + q);
      }
    } catch (e) { /* 报不上就算了，不影响答题 */ }
  }

  /* ============ 跨框架单例与通信：靠 DOM 节点，不靠 window 上的自定义属性 ============
     学习通一页会套好几层同源 iframe（外层课程页 + 题目框 + 视频框），每层都跑一遍脚本。
     两个坑必须一起解决：
       ① 徽标/面板只能有一份 —— 全页面统一建在「最外层能渲染的那份文档」里；
       ② 面板按钮要落到「真正有题的那一层」—— 否则你在没有题目那层点「开始答题」，
          调用的是那一层自己的 run()，它会回一句「没找到题目」，看起来就像按钮坏了。

     ⚠ 不能再拿 window 上的自定义属性当跨框架通道（1.1.0~1.1.4 的错就在这）。
     篡改猴带 @grant 时脚本里的 window 是**沙箱对象**，而 root.top 拿到的是
     **真实页面 window**：在外层往沙箱 window 写 __ftkPanel，子框架去真实 window 上读，
     永远读不到 —— 子框架于是把日志塞进一个永远不 flush 的转发器，用户看到的就是
     「面板不显示做题过程」。
     同源 iframe 之间唯一可靠的共享内存是 DOM 节点：大家拿到的是同一个顶层 document，
     元素上的 expando 也是同一份。所以统一走 xframe.js（root.FreeTikuX）。 */

  function XF() { return root.FreeTikuX || null; }

  /* 本框架自己有没有活干（有题目，或有视频/音频任务点） */
  /* 这一层有没有「还没做完的活」。已经完成的任务点不算 —— 否则页面明明做完了，
     脚本还觉得自己有活，就不会往下翻（用户报过：暂无内容的页面上一直卡着）。 */
  /* 这一层检测到的媒体，到底是不是「本节的任务点」？
     不能只看 document 里有没有 <video>/<audio>：课程外层页可能藏着提示音/
     背景音，旧逻辑把它当成任务点，点「一键启动」后本层就 return，真正的
     视频子框架根本收不到 start（用户 2026-10-22 的现场日志）。
     认任务点的顺序：
       ① 媒体/iframe 父级链上有 .ans-attach-ct、.ans-job-finished 等容器；
       ② 确实在 ananas 视频/音频模块里的页面；
       ③ 页面里有播放器结构（#reader / .video-js / .vjs-tech）。
     三者都认不出就当成杂音，不启动。 */
  function mediaOwnedBy(win, v) {
    try {
      if (!v || !v.media) return false;
      var bx = (VK && VK.mediaTaskBox) ? VK.mediaTaskBox(win || root, v.media) : null;
      if (bx) {
        if (VK.isFinished && VK.isFinished(bx)) return false;
        /* 媒体自己的祖先链和 iframe 父级链有时不是同一层；再看一眼
           taskBox，避免绿色视频被当成「还没做完」反复拦翻页。 */
        var tb = (VK.taskBox) ? VK.taskBox(win || root) : null;
        if (tb && VK.isFinished && VK.isFinished(tb)) return false;
        return true;
      }
      var u = '';
      try { u = String((win && win.location && win.location.href) || location.href); } catch (eU) { u = ''; }
      if (/\/ananas\/modules\/(video|audio)\//.test(u)) return true;
      /* 再看媒体元素自己是不是在播放器结构里（#reader / .video-js / .vjs-tech）。
         不要查整个 document —— 顶层课程壳里可能藏着一个模板播放器，
         那会把同页的提示音也误认成任务媒体。 */
      try {
        var n = v.media;
        for (var i = 0; n && i < 8; i++, n = n.parentElement) {
          var c = ' ' + String(n.className || '') + ' ';
          if (n.id === 'reader' || /video-js|vjs-tech/.test(c)) return true;
        }
      } catch (eP) { /* ... */ }
      return false;
    } catch (e) { return false; }
  }

  /* 这个媒体所在的任务点是不是已经绿了。
     mediaOwnedBy() 对已完成任务点返回 false（避免重复播放），所以不能拿它
     判断「已完成」；否则绿色视频会被当成「这一层没活」，既不播也不翻页，
     用户看到的就是视频绿了、页面卡住。 */
  function mediaTaskFinished(win, v) {
    try {
      if (!VK || !v || !v.media) return false;
      var w = win || root;
      var bx = VK.mediaTaskBox ? VK.mediaTaskBox(w, v.media) : null;
      if (bx && VK.isFinished && VK.isFinished(bx)) return true;
      var tb = VK.taskBox ? VK.taskBox(w) : null;
      if (tb && VK.isFinished && VK.isFinished(tb)) return true;
      /* 不再看整篇文档里有没有绿标：一个页面可能同时装着多个任务点，
         别的任务点绿了，不代表当前这个视频已经完成。 */
      return false;
    } catch (e) { return false; }
  }

  function mediaStillTodo(win, doc) {
    try {
      if (!VK) return false;
      var v = VK.detect(doc || (win && win.document) || document);
      if (!v) return false;
      return mediaOwnedBy(win || root, v);
    } catch (e) { return false; }
  }

  function selfDocVisible() {
    try {
      /* 不把 document.hidden 当隐藏：切到别的标签页/窗口时，脚本仍应继续
         刷课；这里只判断 DOM 上这个 iframe 是否 display:none / 零尺寸。 */
      var fe = root.frameElement;
      if (fe && !isShown(fe)) return false;      // 自己挂在隐藏的旧 iframe 里
    } catch (e) { /* 跨域读不到就按可见处理 */ }
    return true;
  }

  function localWork() {
    /* 结果页哪怕还有 .TiMu，也不能认成「可作答」；否则点一下启动就把
       已经全对的题又重做一遍。 */
    try { if (CX.resultState && CX.resultState()) return false; } catch (eR) { /* ... */ }
    if (!selfDocVisible()) return false;
    var qs = [];
    try { qs = CX.extractQuestions(); } catch (e) { qs = []; }
    if (qs.length) {
      var list = [];
      try { list = document.querySelectorAll('.TiMu, .singleQuesId, .Zy_TItle'); } catch (eL) { list = []; }
      /* 有排版引擎时只认看得见的题。隐藏 iframe 里上一节的旧题不能
         让「一键启动」又跑一遍，也不能让空页永远不翻。 */
      if (list && list.length) {
        /* 测试环境/极老浏览器没有排版引擎，所有 rect 都是 0；
           这种环境不能把题判成「隐藏」，否则按钮永远不干活。 */
        var layout = false;
        try {
          var br = document.body && document.body.getBoundingClientRect();
          layout = !!(br && br.width > 0 && br.height > 0);
        } catch (eB) { layout = false; }
        if (!layout) return true;
        for (var i = 0; i < list.length; i++) if (isShown(list[i])) return true;
        return false;
      }
      return true;
    }
    if (mediaStillTodo(root, document)) return true;
    return false;
  }

  /* 拿不到面板时先顶着的「转发器」：日志先攒着，等真正的面板出现再补进去。 */
  function panelForwarder() {
    var buf = [], bound = null, tries = 0;
    function flush() {
      if (!bound || !bound.log) return;
      for (var i = 0; i < buf.length; i++) bound.log(buf[i][0], buf[i][1]);
      buf.length = 0;
    }
    function target() {
      var X = XF();
      var p = X ? X.get('panel') : (root.__ftkPanel || null);
      if (p && p !== bound && p !== fwd) { bound = p; flush(); }
      return bound;
    }
    function say(m, k) { var p = target(); if (p && p.log) p.log(m, k); else buf.push([m, k]); }
    var fwd = {
      el: null, node: null, forwarder: true,
      log: say, detail: say,
      clear: function () { var p = target(); if (p && p.clear) p.clear(); },
      status: function (m) { var p = target(); if (p && p.status) p.status(m); },
      progress: function (a, b, c) { var p = target(); if (p && p.progress) p.progress(a, b, c); },
      running: function (b) { var p = target(); if (p && p.running) p.running(b); },
      toast: function () { /* 没面板就别弹 */ },
      settings: settings,
      values: function () { return settings; },
      setVisible: function () { var p = target(); if (p && p.setVisible) p.setVisible(true); },
      isVisible: function () { return false; },
      isAlive: function () {
        var p = target();
        return !!(p && p.isAlive ? p.isAlive() : (p && p.el && p.el.isConnected));
      },
      __forwarder: true
    };
    /* 面板可能晚一步才被别层建出来，盯着点；盯 60 秒还没等到就算了 */
    try {
      var iv = setInterval(function () {
        tries++; target();
        if (bound || tries > 120) clearInterval(iv);
      }, 500);
    } catch (e) { /* ... */ }
    return fwd;
  }

  /* 面板单例：谁先要谁建，但一定建在「最外层能渲染的那份文档」里。
     这样不管题目在哪一层，用户看到的永远是同一个、位置也对的面板。 */
  function usablePanel(p) {
    if (!p) return false;
    try {
      /* 转发器本身没有 DOM，真正的目标还活着就继续用 */
      if (p.__forwarder) return !p.isAlive || !!p.isAlive();
      if (!p.el || !p.el.isConnected) return false;
      if (p.isAlive && !p.isAlive()) return false;
      return true;
    } catch (e) { return false; }
  }

  function ensurePanel() {
    /* 本地缓存的 panel 可能属于已经销毁的答题 iframe：DOM 还在，
       但按钮/拖动监听器已经成了僵尸。先验活，死了就清掉重建。 */
    if (panel) {
      if (usablePanel(panel)) return panel;
      try {
        if (panel.el && panel.el.parentNode) panel.el.parentNode.removeChild(panel.el);
      } catch (eP) { /* ... */ }
      panel = null;
    }
    var X = XF();
    if (!X) { panel = panelForwarder(); return panel; }   // 老环境（或测试没加载 xframe）

    var have = X.get('panel');
    if (have) {
      if (!usablePanel(have)) {
        try {
          if (have.el && have.el.parentNode) have.el.parentNode.removeChild(have.el);
        } catch (eH) { /* ... */ }
        try { X.set('panel', null); } catch (eH2) { /* ... */ }
        have = null;
      }
    }
    if (have) { panel = have; return panel; }

    if (!X.claim('panel')) {                             // 别层正在建 / 刚建好
      panel = X.get('panel') || panelForwarder();
      return panel;
    }

    var doc = X.home();
    if (!doc) { X.release('panel'); panel = panelForwarder(); return panel; }

    /* 旧版本或重复注入可能在同一文档里留下多余面板，动手前先清干净 */
    try {
      var old = doc.querySelectorAll('#ftk-panel');
      for (var i = 0; i < old.length; i++) {
        if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
      }
    } catch (e0) { /* ... */ }

    var api = null;
    try {
      api = Panel.create({
        doc: doc,
        settings: settings,
        isRunning: isRunning,
        onSettings: function (s) { gmSet(K_SET, s); },
        /* 按钮不绑「本框架的 run」—— 本框架可能压根没题目。
           统一派发给登记表里那一层真正有活的框架。 */
        onStart: function () {
          trace('cmd', { cmd: 'run', mine: localWork(), tree: hasWorkAnywhere() });
          /* 一键启动：先把总开关打开（sessionStorage，跨页面重载有效），
             再决定这一页该干什么。视频页没有题目，不能走 run()。 */
          armRun();
          if (panel && panel.running) panel.running(true);
          if (panel && panel.status) panel.status('运行中：正在处理这一页…');

          /* ⚠ 广播必须排在「本层有活」前面。
             面板通常住在课程外层，这一层可能有一个隐藏的提示音/背景音，
             startHere() 会返回 true；旧代码于是直接 return，真正的视频
             子框架永远收不到 start（用户 2026-10-22 的现场日志）。
             ctlEach 不跳过自己，所以本层也会被调用一次，不需要提前启动。 */
          var n = 0;
          try { n = (XF() && XF().ctlEach ? XF().ctlEach('start') : 0) || 0; } catch (eC) { n = 0; }
          if (n > 0) {
            panel.log('已通知 ' + n + ' 个框架开始干活。', 'dim');
            if (panel.status) panel.status('运行中：已通知 ' + n + ' 层干活');
            /* 绿色视频会认领 start，但只负责「准备下一节」；如果翻页锁
               正好被旧 iframe 占着，本次启动就可能没有下文。这里补一次
               空闲检查：真有视频在播/题在做它会自己等，没活才会翻页。 */
            scheduleIdleAdvance('启动后等待媒体/题目', 1800);
            return;
          }

          /* 没有登记表（旧环境 / 测试）时才在本层兜底 */
          if (startHere()) return;
          if (dispatch('run')) return;
          if (sendCmd('start')) {
            panel.log('已把「开始」转给下面有媒体/题目的那一层。', 'dim');
            /* 命令槽是异步的：对方可能已经在处理，也可能这一层根本没有活。
               再排一次空闲检查，让它自己判断「有视频在播/有题在做」还是
               「视频已经绿了/没活」——否则绿色任务点会永远停在待命。 */
            scheduleIdleAdvance('启动后没有层报告有活', 1200);
            return;
          }
          panel.log('这一页没找到可作答的题目，也没有可播放的媒体（整棵树也没有）。', 'warn');
          panel.status('没有可做的题');
          scheduleIdleAdvance('点了开始，但这一页没题也没媒体', 300);
        },
        onStop: function () {
          /* 「停止」不管有没有在跑都要有回执：它同时是「暂停流水线」的总开关。
             必须广播到每一层：面板通常住在最外层，视频在子 iframe 里，
             只停本层 = 视频照播（用户 2026-10-21 的截图就是这个问题）。
             任何一层/任何一个控制器抛异常，都不能让按钮卡在「全部停止」上。 */
          try { trace('cmd', { cmd: 'stop' }); } catch (eT) { /* ... */ }
          try { stopLocal('用户停止'); } catch (eS) { /* ... */ }
          try { if (panel && panel.running) panel.running(false); } catch (eR) { /* ... */ }
          var n = 0;
          try { n = (XF() && XF().ctlEach ? XF().ctlEach('stop') : 0) || 0; } catch (eC) { n = 0; }
          /* 不再用 n 挡住兜底：有的旧框架 stop() 只会 return true，实际没停；
             命令槽再广播一次，让真正在跑的那一层一定收到。 */
          try { sendCmd('stop'); } catch (eCmd) { /* ... */ }
          try { if (panel && panel.status) panel.status('已全部停止'); } catch (eP) { /* ... */ }
          try {
            if (panel && panel.log) {
              panel.log('已全部停止：这一页不会再自动答题、不会播视频，也不会自动往下翻。点「▶ 一键启动」继续。', 'ok');
            }
          } catch (eL) { /* ... */ }
        },
        onSubmit: function () {
          if (localWork()) { doSubmit(); return; }
          if (!dispatch('submit')) panel.log('这一页没有可交的卷。', 'warn');
        },
        onDiag: runDiag,
        onRework: function () {
          var rw = findRework();
          if (!rw) { panel.log('这一页没找到「重做」按钮。', 'warn'); return; }
          panel.log('点页面上的「重做」。', 'ok');
          try { fireClickSafe(rw); } catch (e) { /* 点不动就算了 */ }
        },
        onReset: function () {
          if (!PL) { panel.log('流水线模块没加载（脚本版本太旧？）。', 'err'); return; }
          PL.resetRound();
          idleDone = {}; emptyDone = {};
          panel.log('流水线轮数、空页判断和「已试过」的记录都清掉了。', 'ok');
        }
      });
    } catch (e1) { api = null; }
    X.release('panel');

    if (!api) { panel = panelForwarder(); return panel; }

    panel = api;
    /* 面板一建出来就按总开关显示按钮状态（默认是「▶ 一键启动」） */
    try { api.running(isRunning()); } catch (eR) { /* ... */ }
    panelMine = true;
    X.set('panel', panel);
    try { if (panel.node) panel.node.__ftkObj = panel; } catch (e2) { /* ... */ }

    /* 本框架没题目、整棵树也没题目时给一句人话（面板可能是被本框架代建的） */
    try {
      if (!localWork() && !X.ctlHasWork()) {
        panel.status('等待题目');
        panel.detail('这一页本框架没解析到题目；如果题目在下面的 iframe 里，日志会由那一层写进来。');
      }
    } catch (e3) { /* ... */ }
    return panel;
  }

  /* 徽标点一下：第一次点顺手把面板建出来并显示，之后每次在显示/隐藏之间切 */
  function togglePanel() {
    var had = !!(panel || (XF() && XF().get('panel')));
    var p = ensurePanel();
    if (!p) return;
    try {
      if (!had) { if (p.setVisible) p.setVisible(true); return; }
      if (typeof p.isVisible === 'function' && p.isVisible()) { p.setVisible(false); return; }
      if (p.setVisible) p.setVisible(true);
    } catch (e) { /* ... */ }
  }

  /* 面板按钮 -> 真正有活的那一层（xframe 的 ctlDispatch 绝不会派回自己） */
  function dispatch(cmd, arg) {
    var X = XF();
    if (!X) {
      if (cmd === 'run') { run(); return true; }
      if (cmd === 'start') { return startHere(); }
      if (cmd === 'stop') { stopLocal('用户停止'); return true; }
      return false;
    }
    return X.ctlDispatch(cmd, arg);
  }

  /* 兜底通道：命令写进跨框架登记表，有活的那一层轮询到就自己执行。
     跨框架「直接调函数」万一不灵，按钮也还能用。 */
  function sendCmd(cmd, arg) {
    var X = XF();
    if (!X || !X.cmdSend) return false;
    try { return !!X.cmdSend(cmd, arg); } catch (e) { return false; }
  }
  function hasWorkAnywhere() {
    var X = XF();
    try { return X ? !!X.ctlHasWork() : localWork(); } catch (e) { return localWork(); }
  }
  var cmdSeen = 0;
  function installCmdPoller() {
    if (cmdPolled) return;
    cmdPolled = true;
    setInterval(function () {
      var X = XF();
      if (!X || !X.cmdRecv) return;
      var c = null;
      try { c = X.cmdRecv(); } catch (e) { c = null; }
      if (!c || c.n === cmdSeen) return;
      cmdSeen = c.n;
      var cmd = c.cmd;
      /* 领活之前先判断这事该不该我干：没题的层不领 run/submit，免得又点空 */
      if ((cmd === 'run' || cmd === 'submit') && !localWork()) return;
      var _mfin = false;
      try {
        var _mv = VK && settings.video !== false ? VK.detect(document) : null;
        _mfin = !!(_mv && mediaTaskFinished(root, _mv));
      } catch (eMF) { _mfin = false; }
      if (cmd === 'start' && (isPaused() || (!localWork() && !_mfin))) return;
      if (cmd === 'clear' && !panel) return;
      try { X.cmdTake(); } catch (e2) { /* ... */ }
      if (cmd === 'run') { if (!running) run(); }
      else if (cmd === 'start') { startHere(); }
      else if (cmd === 'stop') { stopLocal('用户停止'); }
      else if (cmd === 'submit') { if (!running) doSubmit(); }
      else if (cmd === 'clear') { if (panel && panel.clear) panel.clear(); }
    }, 400);
  }

  /* 现场信息写进桥的日志（bridge_requests.log）。只发小数据，失败绝不影响主流程。 */
  function trace(kind, data) {
    if (traceN++ > 120) return;
    try {
      transport({
        url: BRIDGE + '/trace', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: kind, data: data })
      }).then(function () { }, function () { });
    } catch (e) { /* ... */ }
  }

  /* 每一层都登记「我能干什么」。hasWork/busy 用函数，这样状态一直是新的。 */
  function registerCtl() {
    var X = XF();
    if (!X) return;
    X.ctlRegister({
      hasWork: function () { return localWork(); },
      busy: function () { return running; },
      run: function () { run(); },
      /* 面板按钮「一键启动」的落点：媒体优先（视频框架不能走 run，那样只会报「没找到题目」） */
      start: function (arg) { return startHere(arg); },
      hasMedia: function () {
        try {
          var v = VK && VK.detect(document);
          return !!(v && mediaOwnedBy(root, v));
        } catch (e) { return false; }
      },
      stop: function (arg) {
        stopLocal((arg && arg.why) || '用户停止', !!(arg && arg.quiet));
        return true;
      },
      submit: function () { doSubmit(); }
    }, root);
  }

  /* 整棵树里还有没有活 —— 判断「这一页是不是真没事干了」。
     必须只看**看得见**的题和媒体：学习通切 tab 后会把上一页 iframe 留在
     DOM 里 display:none，旧题会被旧逻辑当成「还有活」，绿色视频和空页
     于是永远不往下翻。 */
  function workInTree() {
    try { return visibleWorkInDoc(root, 0); } catch (e) { return localWork(); }
  }

  /* 页面上的题/视频是不是「看得见」。学习通切 tab 时常常把上一页的 iframe
     留在 DOM 里只是 display:none；workInTree 会把隐藏的旧题也算成「有活」，
     结果空页面永远不往下走。这里只认可见的框架和元素。 */
  function isShown(el) {
    try {
      if (!el) return false;
      try {
        var _w = el.ownerDocument && el.ownerDocument.defaultView;
        var _cs = _w && _w.getComputedStyle ? _w.getComputedStyle(el, null) : null;
        if (_cs && (_cs.display === 'none' || _cs.visibility === 'hidden')) return false;
      } catch (eS) { /* 样式读不到就继续用排版信息判断 */ }
      if (!el.getBoundingClientRect) return true;    // 没有排版引擎时保守放行
      var r = el.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) return true;
      if (el.getClientRects) {
        var rects = el.getClientRects();
        for (var i = 0; rects && i < rects.length; i++) {
          var rr = rects[i];
          if (rr && rr.width > 0 && rr.height > 0) return true;
        }
      }
      return false;
    } catch (e) { return true; }
  }

  function visibleWorkInDoc(w, depth) {
    if (depth > 3) return false;
    var d = null;
    try { d = w.document; } catch (e0) { return false; }
    if (!d) return false;
    var i, list;
    try { list = d.querySelectorAll('.TiMu, .singleQuesId, .Zy_TItle'); } catch (e1) { list = []; }
    for (i = 0; i < list.length; i++) if (isShown(list[i])) return true;
    try { list = d.querySelectorAll('video, audio'); } catch (e2) { list = []; }
    for (i = 0; i < list.length; i++) {
      if (!isShown(list[i])) continue;
      if (mediaOwnedBy(w, { kind: list[i].tagName === 'AUDIO' ? 'audio' : 'video', media: list[i] })) return true;
    }
    try { list = d.querySelectorAll('iframe, frame'); } catch (e3) { list = []; }
    for (i = 0; i < list.length; i++) {
      if (!isShown(list[i])) continue;
      var cw = null;
      try { cw = list[i].contentWindow; } catch (e4) { cw = null; }
      if (cw && visibleWorkInDoc(cw, depth + 1)) return true;
    }
    return false;
  }

  function visibleWorkInTree() {
    try { return visibleWorkInDoc(root, 0); } catch (e) { return localWork(); }
  }

  /* 闭环缺口：空的 / 已经做完的章节页，没人干活就自己往下走。
     流水线模式下才做，而且整页只准一个框架来推（拿 xframe 的锁）。 */
  var idleDone = {};
  var emptyDone = {};
  /* 把整个框架树（深度 3、上限 40 个）都数一遍。视频任务点在兄弟 iframe 里，
     只数本框 + 最外层会漏掉，结果「视频还在放」也照样点「下一节」。 */
  function allDocs() {
    var out = [];
    try {
      var X = XF();
      var list = (X && X.frames) ? X.frames(null, 3) : null;
      if (list && list.length) {
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].doc) out.push(list[i].doc);
        }
      }
    } catch (e) { }
    if (!out.length) out.push(document);
    return out;
  }

  function docIsVisible(d) {
    try {
      if (!d) return false;
      var w = d.defaultView;
      /* 自己这一层也要看 frameElement；以前只查 w !== root，导致当前
         框架被隐藏时仍然把自己算成可见。 */
      var fe = w && w.frameElement;
      if (fe && !isShown(fe)) return false;
      return true;
    } catch (e) { return false; }
  }

  function docUnfinished(d) {
    var n = 0;
    /* 学习通切 tab 后会把上一页 iframe 留在 DOM 里（display:none）。
       隐藏 iframe 里的旧任务点不能拦着当前页翻页；只看当前可见的。 */
    if (!docIsVisible(d)) return 0;
    var icons = (d && d.querySelectorAll) ? d.querySelectorAll('.ans-job-icon') : [];
    for (var j = 0; j < icons.length; j++) {
      try { if (!isShown(icons[j])) continue; } catch (eVis) { /* ... */ }
      var p = icons[j], done = false, k = 0;
      /* 完成标记可能在更外层，且新版用 .icon_Completed；只爬 6 层会
         把已完成视频误算成未完成任务点，goNext 永远不放行。 */
      while (p && k++ < 12) {
        if (p.classList && (p.classList.contains('ans-job-finished') || p.classList.contains('icon_Completed'))) {
          done = true; break;
        }
        p = p.parentElement;
      }
      if (!done) {
        try {
          if (icons[j].closest && icons[j].closest('.ans-job-finished,.icon_Completed')) done = true;
        } catch (eD) { /* ... */ }
      }
      if (!done) n++;
    }
    return n;
  }

  function unfinishedPoints() {
    var n = 0, i, ds;
    try {
      ds = allDocs();
      for (i = 0; i < ds.length; i++) n += docUnfinished(ds[i]);
    } catch (e) {
      try { n += docUnfinished(document); } catch (e2) { }
    }
    return n;
  }

  /* 有没有还没放完的媒体（本框 + 任何子框架）。有就不许离开这一节。 */
  /* 这份文档里的任务点是不是已经绿了（`.ans-job-finished`）。
     学习通经常把**已完成**的播放器留在页面上，有时还停在半路；这时再拿
     「video 没播完」当「这一节还有活」，整章就永远卡在这一页。 */
  function docTaskDone(d) {
    try {
      var box = d.querySelector('.ans-job-finished, .icon_Completed');
      /* 隐藏旧页里的绿色标记不能当成当前页已完成，否则会跳过当前页
         还没播完的视频。 */
      if (box && isShown(box)) return true;
    } catch (e) { /* 不是所有框架都有这些 class */ }
    return false;
  }

  function mediaUnfinished() {
    var frames;
    try {
      var XM = XF();
      frames = (XM && XM.frames) ? XM.frames(null, 3) : null;
    } catch (e0) { frames = null; }
    if (!frames || !frames.length) frames = [{ win: root, doc: document }];
    for (var i = 0; i < frames.length; i++) {
      var d = frames[i] && frames[i].doc;
      if (!d || !d.querySelectorAll) continue;
      if (!docIsVisible(d)) continue;             // 隐藏旧 iframe 不拦翻页
      /* 不能因为这份文档里「有一个」任务点绿了，就跳过文档里其它还没
         播完的视频。每个媒体由 mediaOwnedBy 自己判断所属任务点。 */
      var v;
      try { v = d.querySelectorAll('video, audio'); } catch (e2) { v = []; }
      for (var j = 0; j < v.length; j++) {
        var m = v[j];
        /* 只算任务点里的媒体：顶层课程壳的提示音/背景音没播完，
           不能把整章卡在「视频未完成」上。 */
        if (!mediaOwnedBy(frames[i].win || root, { kind: m.tagName === 'AUDIO' ? 'audio' : 'video', media: m })) continue;
        var dur = Number(m.duration);
        if (!dur || !isFinite(dur) || dur <= 0) continue;   // 还没拿到时长 / 直播流，不算
        if (m.ended) continue;
        if (Number(m.currentTime) >= dur * 0.95) continue;
        return true;
      }
    }
    return false;
  }

  function mediaRunning() {
    try { if (VK && VK.status && VK.status().running) return true; } catch (e) { }
    try {
      var X = XF();
      var t = X && X.topWin && X.topWin();
      var V2 = t && t.FreeTikuVideo;
      if (V2 && V2.status && V2.status().running) return true;
    } catch (e2) { }
    return false;
  }

  function scheduleIdleAdvance(why, delay) {
    if (!settings.pipe) return;
    if (!selfDocVisible()) return;
    if (isPaused()) {
      /* 别让人以为「空页面卡住了」——其实是自己按过停止 */
      var X0 = XF();
      var p0 = panel || (X0 && X0.get && X0.get('panel')) || null;
      var h0 = String(location.href);
      if (p0 && p0.log && !idleDone['paused:' + h0]) {
        idleDone['paused:' + h0] = 1;
        p0.log('（' + why + '）现在是暂停状态，不自动往下翻。点「▶ 一键启动」继续。', 'warn');
      }
      return;
    }
    var X = XF();
    var wait = delay || ((X && X.isTop()) ? 3500 : 2500);
    setTimeout(function () {
      try {
        if (stopFlag || isPaused() || !selfDocVisible()) return;
        var here = String(location.href);
        var gotIdle = false;
        if (idleDone[here]) return;
        if (X && X.ctlBusy() > 0) return;              // 有人正在做题，别抢
        if (workInTree()) {                            // 这页还有活
          if (mediaRunning()) return;                  // 媒体真的在播：等它
          /* 当前层看不到子 iframe 里的 VK.status() 时，mediaRunning()
             会是 false；但媒体其实还在播。这时不能让外层等 8 秒后去点
             「下一节」，否则视频会被整页导航打断，看起来就是一闪一闪。 */
          var _mu = false;
          try { _mu = mediaUnfinished(); } catch (eMU) { _mu = false; }
          if (_mu) {
            if (!idleDone['mediawait:' + here]) {
              idleDone['mediawait:' + here] = 1;
              var _pm = panel || (X && X.get && X.get('panel')) || null;
              if (_pm && _pm.log) _pm.log('（' + why + '）视频还在播，等它自己播完再翻。', 'dim');
            }
            return;
          }
          if (!idleDone['grace:' + here]) {            // 有任务点但没人在播 -> 再等 8 秒
            idleDone['grace:' + here] = 1;
            var _p2 = panel || (X && X.get && X.get('panel')) || null;
            if (_p2 && _p2.log) _p2.log('（' + why + '）这页有任务点但没在播，再等 8 秒。', 'dim');
            setTimeout(function () { if (!isPaused()) goNext(why, true); }, 8000);
            return;
          }
          /* 宽限也过了：不再干等，往下走 */
        }
        /* 刚翻到测验页、题目 iframe 还没渲染出 .TiMu 时，workInTree() 是
           false；这里必须再等一下，否则会把整道测验当成空页跳过去。 */
        if (!idlePageHint() && activeTabText() && pageMayBeWork()) {
          if (!idleDone['workwait:' + here]) {
            idleDone['workwait:' + here] = 1;
            var _pw = panel || (X && X.get && X.get('panel')) || null;
            if (_pw && _pw.log) _pw.log('（' + why + '）翻到测验页了，等题目加载完再答。', 'dim');
          }
          return;
        }
        /* 等到确实要翻页时才抢锁，别把锁抱在 8 秒宽限期里。
           旧实现锁 15 秒 + 释放定时器 8 秒，一旦 iframe 导航，锁会
           留到新页面，绿色视频就卡在「准备下一节」不动。 */
        var XI = X || XF();
        if (XI && !XI.claim('idleAdvance', 4000)) {
          setTimeout(function () {
            if (!isPaused()) scheduleIdleAdvance(why, 1000);
          }, 1800);
          return;
        }
        gotIdle = true;
        idleDone[here] = 1;
        /* 面板可能是别的框架建的（我是子框架时自己没有面板对象），
           从跨框架登记表里借一个来写，别让这句话消失在空气里。 */
        var _p = panel || (X && X.get && X.get('panel')) || null;
        if (_p && _p.log) _p.log('（' + why + '）这一页没有可做的事，往下走。', 'dim');
        goNext(why, true);
      } finally {
        if (X && gotIdle) setTimeout(function () { X.release('idleAdvance'); }, 600);
      }
    }, wait);
  }

  /* --------------------------------------------------- 左下角那块「免费题库」 */
  function makeBadge() {
    if (badgeMade) return;
    var X = XF();
    if (!X) return;

    if (X.get('badge')) { badgeMade = true; return; }  // 别的框架已经建了
    var d = X.home();
    if (!d) { if (badgeTries++ < 20) setTimeout(makeBadge, 500); return; }
    if (!X.claim('badge')) return;                     // 别的框架在建，别抢

    var host = d.body;
    if (!host) {
      var de = d.documentElement;
      host = (de && de.tagName === 'HTML' && !de.querySelector('frameset')) ? de : null;
    }
    if (!host) {
      X.release('badge');
      if (badgeTries++ < 20) setTimeout(makeBadge, 500);
      return;
    }
    badgeMade = true;

    /* 重复注入可能在同一个文档里留下好几个，先清掉 */
    try {
      var old = d.querySelectorAll('#ftk-badge');
      for (var i = 0; i < old.length; i++) {
        if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
      }
    } catch (e0) { /* ... */ }

    var b = d.createElement('div');
    /* DeepSeek 风的胶囊徒标：深蓝玻璃底 + 蓝鲸 + 辉光。仍然带 免费题库 四个字 */
    b.setAttribute('style', MONO +
      'position:fixed;left:14px;bottom:14px;z-index:2147483001;display:flex;align-items:center;gap:7px;' +
      'background:linear-gradient(135deg,rgba(21,29,54,.96),rgba(10,14,28,.98));color:#DCE6FF;' +
      'padding:5px 12px 5px 8px;border-radius:999px;border:1px solid rgba(93,135,255,.42);' +
      'box-shadow:0 4px 18px rgba(3,8,25,.55),0 0 22px rgba(77,107,254,.30);' +
      'cursor:pointer;user-select:none;font-weight:600;letter-spacing:.4px;' +
      '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);');
    try {
      b.innerHTML = ((Panel && Panel.WHALE) ? Panel.WHALE : '') + '<span>免费题库</span>';
    } catch (eB) { b.textContent = '●  免费题库'; }
    if (!String(b.textContent || '').replace(/\s/g, '')) b.textContent = '●  免费题库';
    b.id = 'ftk-badge';
    b.title = '点一下：显示 / 隐藏「免费题库助手」面板（v' + VERSION + '）。按住可以拖走。';

    var sx = 0, sy = 0, ox = 0, oy = 0, moving = false, dragged = false;
    b.onmousedown = function (e) {
      var r = b.getBoundingClientRect();
      if (!b.style.left) b.style.left = r.left + 'px';
      if (!b.style.top) b.style.top = r.top + 'px';
      b.style.bottom = 'auto';
      sx = e.clientX; sy = e.clientY;
      ox = parseFloat(b.style.left) || r.left;
      oy = parseFloat(b.style.top) || r.top;
      moving = true; dragged = false;
      try { e.preventDefault(); } catch (e0) { /* ... */ }
    };
    d.addEventListener('mousemove', function (e) {
      if (!moving) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragged && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) dragged = true;
      if (!dragged) return;
      var vw = d.defaultView || root;
      var W = vw.innerWidth || 1000, H = vw.innerHeight || 700;
      b.style.left = Math.max(0, Math.min(W - 90, ox + dx)) + 'px';
      b.style.top = Math.max(0, Math.min(H - 30, oy + dy)) + 'px';
    });
    d.addEventListener('mouseup', function () { moving = false; });
    b.onclick = function () { if (dragged) { dragged = false; return; } togglePanel(); };

    host.appendChild(b);
    X.set('badge', b);
  }

  var badgeMade = false, badgeTries = 0, dragged = false;
  var panelMine = false;          // 这个面板是不是本框架亲手建的（是才由我负责拆）

  /* 诊断：只读，不点任何东西。把「这一页有哪些框架/章节/任务点」摊开给用户看，
     这样流水线点错了、或者它说「没有下一个了」，都能一眼看出到底读到了什么。 */
  function runDiag() {
    var p = ensurePanel();
    if (!p) return;

    pingBridge(function (msg) { if (panel) panel.log('题库服务：' + msg, 'dim'); });
    try {
      var fr = scanFrames(), tot = 0, k;
      for (k = 0; k < fr.length; k++) if (fr[k].n > 0) tot += fr[k].n;
      p.log('框架扫描：' + fr.length + ' 个框架，共 ' + tot + ' 个题目容器。', 'dim');
      for (k = 0; k < fr.length; k++) {
        var f = fr[k];
        p.log('  ' + (f.depth ? '└ ' : '') + (f.n === -2 ? '跨域读不到' : f.n + ' 个') + '　'
          + String(f.url).slice(0, 72), 'dim');
      }
      if (trickle.length) {
        p.log('流水线最近日志：', 'dim');
        for (k = Math.max(0, trickle.length - 8); k < trickle.length; k++) p.log('  · ' + trickle[k], 'dim');
      }
    } catch (e) { /* 扫描失败不影响后面的章节诊断 */ }

    if (!PL) { p.log('流水线模块没加载（脚本版本太旧？），诊断用不了。', 'err'); return; }
    var t = PL.topWin();
    var ax = null;
    try { ax = (XF() && XF().get('advance')) || (t && t.__ftkAdvance) || null; } catch (e) { ax = null; }
    var s, where;
    if (ax && ax.scan) { s = ax.scan(); where = '最外层课程页'; }
    else { s = PL.scan(); where = (t ? '最外层页面（但这层没装服务）' : '本框架'); }
    p.log('—— 诊断（只读，没有点任何东西）· 读的是' + where + ' ——', 'warn');
    PL.report(s).split('\n').forEach(function (l) { p.log(l, 'dim'); });
    var nx = PL.pickNext(s);
    if (nx && nx.what === 'stuck') p.log('→ 流水线卡住了：' + nx.why, 'err');
    else if (nx) p.log('→ 流水线下一个会点：' + (nx.what === 'task' ? '任务点 ' : '章节 ') + nx.desc, 'ok');
    else p.log('→ 流水线认为这里没有可点的下一个（没有未完成的章节测验了，或都被试过一轮了）。', 'warn');
    p.log('—— 诊断结束 ——', 'warn');
  }

  /* --------------------------------------------------------------- 引导 */
  var BOOT_MAX_TRIES = 20;                              // 最多等 20 秒
  var bootTries = 0;
  var videoStarted = false;                             // 这一帧的视频驱动器只开一次
  var mediaWaitLogged = false;                          // 多个视频任务点：只提示一次「先做上面的」
  var mediaNextLogged = false;                          // 多个视频任务点：只提示一次「轮到下一个」

  /* 这页「本来就像」测验页吗？题目是异步塞进来的时候，靠它决定要不要有耐心等。 */
  function looksLikeWorkUrl() {
    return /\/work\/|doWork|workId=|addStudentWork|studentWork|selectWork/i
      .test(String(location.href));
  }

  /* 这一页是不是正在加载一道测验？不能只看 visibleWorkInTree()：
     题目 iframe 刚插进来、.TiMu 还没渲染时它是 false，空页检查如果
     立刻再点一次「下一节」，就会把刚翻到的测验跳过去。 */
  function pageMayBeWork() {
    try {
      if (looksLikeWorkUrl()) return true;
      var fr = document.querySelectorAll('iframe, frame');
      for (var i = 0; i < fr.length; i++) {
        if (!isShown(fr[i])) continue;
        var src = '';
        try { src = String(fr[i].src || fr[i].getAttribute('src') || ''); } catch (eS) { src = ''; }
        if (/\/work\/|workId=|doWork|addStudentWork|studentWork|selectWork|ananas\/modules\/work/i.test(src)) return true;
        try {
          var cd = fr[i].contentDocument;
          if (cd && (cd.querySelector('.TiMu, .singleQuesId') || /\/work\/|doWork|workId=/i.test(String(cd.location.href)))) return true;
        } catch (eD) { /* 跨域/还没加载 */ }
      }
    } catch (e) { /* ... */ }
    return false;
  }

  /* 在最外层 + 所有同源子框架里找「下一节」按钮。
     为什么要爬框架树：视频跑在它自己的 iframe 里，而那个「下一节」
     可能长在视频自己的页面上，也可能长在隔壁那个测验 iframe 里。 */
  /* 框架树扫描有点贵（goNext 一轮要跑三趟）。同一个地址 1.2 秒内只扫一次，
     结果直接复用 —— 翻页按钮不会在 1.2 秒内变位置，重复扫纯属浪费。 */
  var nbMemo = null;
  function findNextBtnInTree() {
    var _k = 'nb:' + String(location.href), _now = Date.now();
    if (nbMemo && nbMemo.k === _k && (_now - nbMemo.at) < 1200) return nbMemo.v;
    var found = null;
    function walk(w, depth) {
      if (found || depth > 3) return;
      var doc = null;
      try { doc = w.document; } catch (e) { return; }
      if (!doc) return;
      try { found = CX.findNextPageBtn(doc, w); } catch (e) { found = null; }
      if (found) return;
      var fr;
      try { fr = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
      for (var i = 0; i < fr.length; i++) {
        var cw = null;
        try { cw = fr[i].contentWindow; } catch (e2) { cw = null; }
        if (!cw) continue;
        try { void cw.document; walk(cw, depth + 1); } catch (e3) { /* 跳域就跳过 */ }
        if (found) return;
      }
    }
    var tw = null;
    try { tw = PL.topWin(); } catch (e) { tw = null; }
    walk(tw || root, 0);
    nbMemo = { k: _k, at: _now, v: found };
    return found;
  }

  /* 往下走：先点页面上那个「下一节」，没有才退回课程树。
     实测（用户截图）：章节测验页底部就有「上一节 / 下一节」；
     它可能在本框架，也可能挂在最外层课程页上——两边都找一遍。 */
  /* 本框架能拿到的课程树服务：顶层是自己装的，子框架从 xframe 登记表里取 */
  function localAdvance() {
    if (topAdv && typeof topAdv.next === 'function') return topAdv;
    var X = XF();
    if (X) {
      var a = X.get('advance');
      if (a && typeof a.next === 'function') return a;
    }
    return null;
  }

  /* 自动流程真正结束：关总开关、停媒体、把面板切回「一键启动」。
     只用于「确认没有下一步」/「达到安全上限」；用户手动停止走 onStop。 */
  function finishPipeline(msg, kind) {
    var X = XF();
    var p = panel;
    if (!p) { try { p = X && X.get && X.get('panel'); } catch (e0) { p = null; } }
    var logged = false;
    try { if (p && p.log) { p.log(msg, kind || 'ok'); logged = true; } } catch (e1) { /* ... */ }
    if (!logged) { try { pipeLog(msg, kind || 'ok'); } catch (e2) { /* ... */ } }
    try { stopLocal(msg, true); } catch (e3) { /* ... */ }
    /* 视频可能还在别的 iframe 里，顺手广播一次安静停止，避免它继续播。 */
    try { if (X && X.ctlEach) X.ctlEach('stop', { why: msg, quiet: true }); } catch (e4) { /* ... */ }
    try { if (p && p.status) p.status('已自动停止'); } catch (e5) { /* ... */ }
    try { if (p && p.running) p.running(false); } catch (e6) { /* ... */ }
  }

  /* 翻页总次数兜底。正常课程几百个任务点也到不了 500；
     平台要是把「下一节」做成无限循环，这里保证一定停得下来。 */
  function navBudget() {
    if (!PL || !PL.bumpNav) return true;
    var n = PL.bumpNav();
    var max = PL.NAV_MAX || 500;
    if (n <= max) return true;
    finishPipeline('自动翻页已经 ' + n + ' 次，超过安全上限 ' + max +
      '，先停下防止死循环。确认课程还没刷完，就点面板上的「重置」再继续。', 'err');
    return false;
  }

  /* 当前选中的任务点标签。学习通换 tab 时常常只改这里和 URL，
     页面不会重新加载；只盯 qsig（题目）会漏掉「扩展阅读 / 暂无内容」这种空页。 */
  function activeTabText() {
    try {
      var e = document.querySelector('.tabtags .current, .tabtags .active, .tabtags .on, ' +
        '#prev_tab .prev_ul li.current, #prev_tab .prev_ul li.active, #prev_tab .prev_ul li.on');
      return e ? String(e.textContent || '').replace(/\s+/g, '') : '';
    } catch (e) { return ''; }
  }

  /* 判断「整页是不是换了一节」。不能只用 qsig：空页/阅读页没有题目，
     qsig 永远是空串，旧 rebootstrap 于是永远不再 boot，页面就卡死。 */
  function pageKey() {
    var bits = [];
    try { bits.push(String(location.href)); } catch (e0) { /* ... */ }
    bits.push(activeTabText());
    try {
      var c = document.getElementById('curChapterId');
      bits.push(c ? String(c.value || c.getAttribute('value') || '') : '');
    } catch (e1) { bits.push(''); }
    try { bits.push(String(document.title || '')); } catch (e2) { /* ... */ }
    return bits.join('|');
  }

  /* 学习通没有题、视频又是「暂无内容」的页面：给日志一句人话，
     也方便点击前判断这页是不是本来就没活。 */
  function idlePageHint() {
    try {
      if (CX.pageKind && CX.pageKind() === 'work') return '';
      if (localWork()) return '';
      var tab = activeTabText();
      if (/扩展阅读|拓展阅读|课外阅读/.test(tab)) return '扩展阅读页';
      var b = document.body;
      var t = b ? (b.innerText || b.textContent || '') : '';
      /* 面板日志里可能残留上一页的「暂无内容」，不能拿它当本页正文。 */
      try {
        var pe = document.getElementById('ftk-panel');
        var pt = pe ? (pe.innerText || pe.textContent || '') : '';
        if (pt) t = t.replace(pt, '');
      } catch (ePT) { /* ... */ }
      if (/暂无内容|暂无任务点/.test(t)) return '空页（暂无内容）';
    } catch (e) { /* ... */ }
    return '';
  }

  /* 页面真的换了，旧的「这一页已经翻过 / 等过多久」记录就不该继续拦着。
     只清当前 URL 的键，不碰其它框架正在用的锁。 */
  function resetPageIdle() {
    var h = '';
    try { h = String(location.href); } catch (e) { return; }
    ['', 'grace:', 'paused:', 'goWait:', 'goRetry:', 'nextTry:', 'left:', 'media:', 'mediawait:', 'noMove:', 'workwait:']
      .forEach(function (p) { delete idleDone[p + h]; });
  }

  /* 页面有没有真的动：只看课程页自己的信号，绝不把面板日志算进去。
     学习通有些「下一节」是空壳按钮 / 点完只换个空白 tab，URL 都不变；
     以前点完就 return，于是永远停在那页。 */
  function pageFingerprint() {
    var bits = [];
    try { bits.push(String(location.href)); } catch (e0) { /* ... */ }
    function selText(sel) {
      try {
        var e = document.querySelector(sel);
        return e ? String(e.textContent || '').replace(/\s+/g, '') : '';
      } catch (e1) { return ''; }
    }
    bits.push(activeTabText());
    bits.push(selText('h3.currents, h4.currents, h5.currents, .posCatalog_active'));
    try {
      var c = document.getElementById('curChapterId');
      bits.push(c ? String(c.value || c.getAttribute('value') || '') : '');
    } catch (e2) { bits.push(''); }
    try { bits.push('q' + document.querySelectorAll('.TiMu').length); } catch (e3) { /* ... */ }
    try { bits.push('v' + document.querySelectorAll('video,audio').length); } catch (e4) { /* ... */ }
    try { bits.push('f' + document.querySelectorAll('iframe').length); } catch (e5) { /* ... */ }
    return bits.join('|');
  }

  var navSeq = 0;

  /* 翻页动作之后验一下：还是空页就继续走。学习通有些「下一节」会把人带到
     一个「暂无内容」的 tab（URL 都不变），点完就没人再叫 goNext，于是卡死。 */
  function scheduleEmptyCheck(before, seq, why, delay) {
    setTimeout(function () {
      try {
        if (isPaused()) return;
        var now = '';
        try { now = pageFingerprint(); } catch (eN) { now = ''; }
        var moved = !!now && now !== before;
        /* 点了「下一节」但页面纹丝不动：可能按钮是空壳、点击被旧 iframe
           吞了，或者学习通还没加载完。不能因为 visibleWorkInTree() 还
           看得到旧内容就直接躺平；补点两次，再交给章节树兜底。 */
        if (!moved) {
          if (seq !== navSeq) return;              // 已经有新的翻页动作在跑
          var rk = 'noMove:' + String(location.href);
          var rn = idleDone[rk] || 0;
          if (rn >= 2) {
            finishPipeline('点了「下一节」几次，页面都没有动，先停下。' +
              '确认课程没刷完，就点面板上的「重置」再试。', 'warn');
            return;
          }
          idleDone[rk] = rn + 1;
          pipeLog('（' + why + '）点了「下一节」，页面还没动，再试一次。', 'warn');
          setTimeout(function () {
            try {
              if (isPaused()) return;
              if (pageFingerprint() !== before) return;   // 延迟期间已经翻过去了
              goNext('翻页没反应，再试', true);
            } catch (eR) { /* ... */ }
          }, 1200);
          return;
        }
        if (seq !== navSeq) return;
        var empty = false;
        try { empty = !visibleWorkInTree(); } catch (e0) { empty = false; }
        if (!empty) return;
        /* 刚翻到的测验 iframe 可能还没渲染出 .TiMu；这时不能再点一次，
           否则会把整道测验跳过去。等它自己的 boot 跑完。 */
        if (!idlePageHint() && activeTabText() && pageMayBeWork()) {
          pipeLog('（' + why + '）翻到测验页了，先等题目加载完再答。', 'dim');
          return;
        }
        var key = '';
        try { key = now; } catch (eK) { key = ''; }
        if (key && emptyDone[key]) {
          finishPipeline('这一页一直是空页（「暂无内容」），自动翻页也没有反应，先停下。' +
            '确认课程没刷完，就点面板上的「重置」再试。', 'warn');
          return;
        }
        if (key) emptyDone[key] = 1;
        pipeLog('（' + why + '）翻过去还是个空页，继续找下一个。', 'warn');
        goNext('空页，继续往下', true);
      } catch (e2) { /* ... */ }
    }, delay || 3000);
  }

  /* 「下一节」的锁只需要挡住同时点击。旧框架导航后，释放定时器会跟着
     整个 realm 消失；如果这次点击没把页面带走，别的框架不能只留一句
     「已经在翻页了」就永远不动。这里做几次有限重试，等锁过期后继续。 */
  function retryGoNext(why, preferAdvance, here) {
    var key = 'goRetry:' + String(here || location.href);
    var n = idleDone[key] || 0;
    if (n >= 5) return;
    idleDone[key] = n + 1;
    setTimeout(function () {
      if (!isPaused()) goNext(why, preferAdvance);
    }, 1800);
  }

  function goNext(why, preferAdvance) {
    if (!PL) return;
    if (!selfDocVisible()) return;          // 隐藏的旧 iframe 不许翻页
    if (isPaused()) { pipeLog('已暂停，不自动往下翻。'); return; }
    var _seq = ++navSeq;
    /* 本章还有任务点没做完：先做它们，绝不点「下一节」——那一定会弹出
       「当前章节还有任务点未完成」。真卡不动了（连续 3 次）才放行，
       那时弹窗由 pipeline 里的兜底去点「去学习」。 */
    var _left = unfinishedPoints();
    var _media = false;
    try { _media = mediaUnfinished(); } catch (eM) { _media = false; }
    if (_media) {
      /* 媒体真的还没播完：先不放行，放行 = 学习通马上弹「还有任务点未完成」。
         但**不能无限等**：播放器卡死、资源加载失败、隐藏 iframe 里留着上一节的
         视频，都会让这一页永远不动。「连续几次没进展就放行」由面板上的
         「视频卡住放行」控制（默认 8 次），这里不再写死。 */
      var _mw = parseInt(settings.mediaWait, 10);
      if (isNaN(_mw)) _mw = 8;
      _mw = Math.max(1, Math.min(60, _mw));
      var _mk = 'media:' + String(location.href);
      idleDone[_mk] = (idleDone[_mk] || 0) + 1;
      if (idleDone[_mk] <= _mw) {
        if (idleDone[_mk] === 1) {
          pipeLog('这一节还有视频/音频没播完（或播放器没上报完成），先不点「下一节」。');
        }
        return;
      }
      pipeLog('视频/音频播放器连续 ' + _mw + ' 次没有进展（多半是卡住了，不是「视频没播完」），先放行往下翻。');
    }
    if (_left > 0) {
      var _k = 'left:' + String(location.href);
      idleDone[_k] = (idleDone[_k] || 0) + 1;
      if (idleDone[_k] <= 5) {
        if (idleDone[_k] === 1) {
          pipeLog('本章还有 ' + _left + ' 个任务点没做完，先做它们，不往下翻。');
        }
        /* 不在这里重跑 boot：本页的媒体驱动器自己跑着，它做完会再叫 goNext。
           重跑 boot 会跟倒计时互相点火，把测试和标签页都拖死。 */
        return;
      }
      pipeLog('本章还有 ' + _left + ' 个任务点，试了 5 次没进展，交给兜底往下翻。');
    }
    var here = String(location.href);

    /* 先点页面上那个「下一节 / 下一页」：它是学习通自己的顺序，就是本节里的下一个
       任务点。以前先问 pickNext（按章节树跳），结果会在 5-3 和 6-2 之间来回蹦
       —— 用户原话：「应该让他点下一页而不是下一章」。 */
    var nb = null;
    try { nb = findNextBtnInTree(); } catch (e) { nb = null; }
    /* 点过一次不等于点成功了。锁冲突/弹窗/网络慢都可能让第一次点击
       没有带走页面；允许同一个按钮再补点一次，之后才退回章节树。
       （锁冲突本身由 retryGoNext 处理，这里不能无限补点，否则真跳两节。） */
    var _ntKey = 'nextTry:' + here;
    var _nt = idleDone[_ntKey] || 0;
    if (nb && (!PL.triedBefore('nextbtn:' + here) || _nt < 2)) {
      /* 两个框架同时走到这里会各点一次「下一节」—— 一下跳过两个任务点。
         跨框架抢一把锁，抢不到就等一会儿重试，不能直接躺平。 */
      var XG = XF();
      if (XG && !XG.claim('goNext', 5000)) {
        if (!idleDone['goWait:' + here]) {
          idleDone['goWait:' + here] = 1;
          pipeLog('（' + why + '）别的框架已经在翻页了，等它一下再试。');
        }
        retryGoNext(why, preferAdvance, here);
        return;
      }
      if (!navBudget()) {
        if (XG) { try { XG.release('goNext'); } catch (eN) { /* ... */ } }
        return;
      }
      try {
        idleDone[_ntKey] = _nt + 1;
        PL.markTried('nextbtn:' + here);
        pipeLog('（' + why + '）点页面上的「下一节」，按学习通自己的顺序往下走。');
        var _before = pageFingerprint();
        fireClickSafe(nb);
        /* 空页面/空壳按钮：点完页面没变，或者只是换到一个「暂无内容」的 tab，
           都不能 return 等死。3 秒后验一次，还是空页就继续走。 */
        scheduleEmptyCheck(_before, _seq, why, 3000);
      } finally {
        /* 「任务点未完成」的提示是 AJAX 之后才出现的，点完立刻查一次根本查不到。
           1.5 秒和 3.5 秒各补一刀（pipeline 里那条兜底也还在）。 */
        try {
          if (PL && PL.dismissUnfinished) {
            setTimeout(function () { try { PL.dismissUnfinished({ log: pipeLog }); } catch (e1) { } }, 1500);
            setTimeout(function () { try { PL.dismissUnfinished({ log: pipeLog }); } catch (e2) { } }, 3500);
          }
        } catch (e3) { /* 没有兜底就算了 */ }
        /* 锁只挡同时点击；1.2 秒足够，释放太晚会把空页重试也一起堵死。 */
        if (XG) setTimeout(function () { try { XG.release('goNext'); } catch (e4) { } }, 1200);
      }
      return;
    }

    /* 按钮没有（或者这一页的按钮已经点过了）才退回章节树。 */
    if (!navBudget()) return;
    var ra = null;
    var _beforeTree = pageFingerprint();
    var a = localAdvance();
    if (a) { try { ra = a.next({ allowChapter: true }); } catch (eA) { ra = null; } }
    else { ra = PL.advance({ log: pipeLog }); }
    if (ra && ra.ok) {
      scheduleEmptyCheck(_beforeTree, _seq, '章节树', 4000);
      return;
    }
    var _why = (ra && ra.why) ||
      (preferAdvance ? '这一页没有可点的「下一节」，本节也没有待办任务点了。' : '没有下一个了');
    var _done = _why.indexOf('没有找到还没完成的章节测验') >= 0;
    finishPipeline('流水线停下：' + _why, _done ? 'ok' : 'warn');
  }

  /* 视频驱动器：只开一次，「一键启动」和 boot 都从这里进。
     以前视频死活在 boot 里，页面一打开就自己播 —— 用户要的是「点启动才开始」。 */
  /* 这一层要干的活：有媒体就先起播，有题就答题。
     「一键启动」广播到每层时都走这里，谁认领谁返回 true。
     mediaOnly=true 时只认媒体，不去启动下面的测验（轮到下一个视频时用）。 */
  function startHere() {
    /* 用户已经按了「全部停止」就不要再被延迟广播/别的框架拉起来 */
    if (isPaused()) return false;
    /* 隐藏的旧 iframe 不能认领「一键启动」：否则上一节已经做完的题/视频
       会被重新跑一遍，ctlEach 还会报「通知了 4 个框架」。 */
    if (!selfDocVisible()) return false;
    var mediaOnly = !!(arguments[0] && arguments[0].mediaOnly);
    var v = null;
    try { v = (VK && settings.video !== false) ? VK.detect(document) : null; } catch (e) { v = null; }
    if (v && startHereMedia(v, mediaOnly)) return true;
    if (mediaOnly) return false;
    if (localWork()) { run(); return true; }
    return false;
  }

  /* 媒体任务点这一支单独放：startHere 保持短小，仍然是「先媒体、后题目」。
     mediaOnly=true 时只处理媒体，不去启动下面的测验（轮到下一个视频时用）。 */
  function startHereMedia(v, mediaOnly) {
    if (!mediaOwnedBy(root, v)) {
      /* 已完成任务点：不重播，但必须由这一层主动把「已完成」告诉流程，
         否则 ctlEach 会认为没人接 start，外层就停在待命状态。 */
      if (mediaTaskFinished(root, v)) {
        ensurePanel();
        var _more = null;
        try { _more = (VK && VK.firstUnfinishedTask) ? VK.firstUnfinishedTask() : null; } catch (eM) { _more = null; }
        if (_more) {
          /* 这一页还有别的视频没做完：别急着点「下一节」，按顺序交给下一个。 */
          if (panel) panel.status('这个视频任务点已完成，按从上到下顺序继续下一个…');
          if (!mediaOnly) {
            setTimeout(function () {
              if (!isPaused()) startNextMediaTask('上一个视频已完成');
            }, 300);
          }
          return true;
        }
        if (panel) panel.status('视频任务点已完成，准备下一节…');
        scheduleIdleAdvance('视频任务点已完成', 500);
        return true;
      }
      /* 本层有媒体，但不是任务点（典型：课程外壳里的提示音/背景音）。
         不要在这里 return true，否则真正有视频的子框架又收不到广播。 */
      try { trace('media-skip', { url: String(location.href), kind: v.kind }); } catch (eT) { }
      return false;
    }
    startVideo(v);
    return true;
  }

  /* 这个任务点是不是已经有人在驱动了（标记挂在媒体元素上，跨脚本实例共享）。 */
  function mediaDriverRunning(task) {
    try {
      return !!(task && task.media && task.media.__ftkStartRun && task.media.__ftkStartRun.running);
    } catch (e) { return false; }
  }

  /* 上一个视频做完后，按顺序叫下一个。只广播给「媒体」，
     不会顺手把下面的测验也开跑；找不到下一个就返回 false，让调用方去翻页。 */
  function startNextMediaTask(why, tries) {
    if (!settings.pipe || isPaused()) return false;
    var first = null;
    try { first = (VK && VK.firstUnfinishedTask) ? VK.firstUnfinishedTask() : null; } catch (eF) { first = null; }
    if (!first) return false;
    if (mediaDriverRunning(first)) return true;
    var X = XF();
    if (!X || !X.ctlEach) return false;
    if (!mediaNextLogged) {
      mediaNextLogged = true;
      var _p = panel || (X.get && X.get('panel')) || null;
      if (_p && _p.log) _p.log('（' + (why || '继续') + '）按从上到下顺序，继续下一个视频/音频任务点。', 'dim');
    }
    try { X.ctlEach('start', { mediaOnly: true }); } catch (eC) { /* ... */ }
    if (mediaDriverRunning(first)) return true;
    /* 下一层的 iframe 可能还没加载完/还没登记控制器；等它一下，
       但不要因此去点「下一节」，否则学习通又会弹「任务点未完成」。 */
    var n = tries || 0;
    if (n < 10) {
      setTimeout(function () {
        if (isPaused() || !selfDocVisible()) return;
        var now = null;
        try { now = (VK && VK.firstUnfinishedTask) ? VK.firstUnfinishedTask() : null; } catch (eN) { now = null; }
        if (!now || mediaDriverRunning(now)) return;
        startNextMediaTask(why, n + 1);
      }, 1200);
    }
    return true;
  }

  function startVideo(vid) {
    /* 同一个视频元素只允许一个驱动。学习通切 tab / 重复注入时，同一页可能
       同时存在好几份脚本，三层框架都收到 start 就会各开一个 drive：倍速锁
       互相覆盖、暂停监听互相抢、弹题每 2 秒被三份脚本各藏一次，用户看到的
       就是「视频一直闪」。标记挂在媒体元素上，同一文档里的多个实例共享。 */
    var media = vid && vid.media;
    /* 同页多个视频/音频任务点时，只允许最上面那个开播。不能只挡 startHere：
       boot() 也会直接调到这里，旧版因此会在两个视频之间来回抢暂停。 */
    try {
      if (media && VK && VK.isFirstUnfinished && !VK.isFirstUnfinished(root, media)) {
        ensurePanel();
        if (panel && !mediaWaitLogged) {
          mediaWaitLogged = true;
          var _first = null;
          try { _first = VK.firstUnfinishedTask ? VK.firstUnfinishedTask() : null; } catch (eFirst) { _first = null; }
          panel.log('这一页有多个视频/音频任务点，按从上到下顺序先做最上面的' +
            (_first ? '；这个先等着' : '') + '。', 'dim');
        }
        return;
      }
    } catch (eTurn) { /* 顺序判断失败就按旧逻辑走，不能因此不播 */ }
    mediaWaitLogged = false;
    var mark = null;
    function releaseMark() {
      try { if (media && media.__ftkStartRun === mark) delete media.__ftkStartRun; } catch (e) { }
    }
    try {
      if (media) {
        if (media.__ftkStartRun && media.__ftkStartRun.running) {
          if (panel && panel.log) panel.log('这个视频已经有驱动在跑，不重复启动。', 'dim');
          return;
        }
        mark = media.__ftkStartRun = { running: true, at: Date.now() };
      }
    } catch (eMark) { mark = null; }

    ensurePanel();
    if (!panel) { releaseMark(); return; }
    if (videoStarted) {
      /* 上一轮驱动器已经结束（视频放完/失败/被停止）时，闩锁要放开，
         否则用户再点「一键启动」永远进不来，视频停在 0:01 不动。 */
      var _vs = null;
      try { _vs = VK.status ? VK.status() : null; } catch (eVS) { _vs = null; }
      if (_vs && _vs.running) { releaseMark(); return; }   // 真的还在跑，等它自己报结果
      videoStarted = false;
    }
    videoStarted = true;
    var kindName = (vid && vid.kind === 'audio') ? '音频' : '视频';
    var seq = '';
    try {
      var _all = (VK && VK.orderedTasks) ? VK.orderedTasks() : null;
      if (_all && _all.length > 1) {
        for (var _i = 0; _i < _all.length; _i++) {
          if (_all[_i].media === media) { seq = '（第 ' + (_i + 1) + '/' + _all.length + ' 个）'; break; }
        }
      }
    } catch (eSeq) { /* ... */ }
    try { trace('media-start', { url: String(location.href), kind: (vid && vid.kind) || '?' }); } catch (e0) { }
    panel.log('这一页是' + kindName + '任务点' + seq + '，开始自动播放（' + settings.rate + 'x）。');
    if (!settings.pipe) panel.log('（提示：没开流水线模式，播完不会自动往下翻）', 'dim');
    try {
      VK.drive(document, {
        rate: settings.rate,
        log: function (m, k) { panel.log(m, k); pipeLog(m, k); }
      }).then(function (r) {
        releaseMark();
        /* 没做成（找不到任务点、资源没加载、重播次数用尽）要放开一次性闩锁，
           否则用户再点「一键启动」也不会重试。 */
        if (!r || !r.done) videoStarted = false;
        if (!settings.pipe) return;
        if (isPaused()) return;                     // 中途按了停止就不再往下翻
        setTimeout(function () {
          if (isPaused()) return;
          /* 这一页还有第二个/第三个视频：先按顺序播它，别点「下一节」。
             学习通同一时间只允许一个播放器，提前翻页会弹「任务点未完成」。 */
          if (r && r.done && startNextMediaTask('上一个视频完成')) return;
          goNext(r && r.done ? '视频看完了' : '视频没做成');
        }, 1200);
      }, function (eV) {
        releaseMark();
        videoStarted = false;
        panel.log('视频驱动器出错：' + ((eV && eV.message) || eV), 'err');
      });
    } catch (eV) {
      releaseMark();
      videoStarted = false;
      panel.log('视频驱动器出错：' + ((eV && eV.message) || eV), 'err');
    }
  }

  function boot() {
    /* 隐藏的旧 iframe 不参与任何自动答题/视频/翻页。学习通切 tab 时
       会把上一页留在 DOM 里，旧版 boot 仍会在里面自动跑，用户看到的就是
       「已经全对的题又做了一遍」。等它重新可见时 rebootstrap 会再进来。 */
    if (!selfDocVisible()) return;
    /* 记住这次 boot 对应的是哪一节。rebootstrap 之后靠它识别
       「URL/任务点标签换了、但 qsig 还是空」的空页切换。 */
    try { lastPageKey = pageKey(); } catch (ePK) { lastPageKey = ''; }
    makeBadge();                                 // 顶层框架常驻徽标：证明脚本活着

    /* 交卷/翻页后旧 iframe 可能已经销毁，面板 DOM 还挂在外层。
       新页面即使没题、没视频，也要先把僵尸面板换掉，否则用户一旦
       停在空页/已完成的视频页，停止和拖动就再也点不动了。 */
    try {
      var X0 = XF();
      var haveP = X0 && X0.get ? X0.get('panel') : null;
      if ((haveP && !usablePanel(haveP)) || (panel && panel.el && !usablePanel(panel))) {
        ensurePanel();
      }
    } catch (ePA) { /* ... */ }

    /* 最外层那个课程页（studentstudy）没有题目，但「下一节」的按钮全在它手里。
       所以在这里挂一个服务，供里面答题的框架调用。 */
    var isTop = XF() ? XF().isTop() : !(PL && PL.topWin());
    if (PL && isTop) {
      try { topAdv = PL.installAdvance({ log: pipeLog, version: VERSION }); } catch (e) { /* ... */ }
    }
    registerCtl();
    installCmdPoller();

    var kind = CX.pageKind();
    var st = CX.resultState ? CX.resultState() : null;
    /* 视频页/空页也要记住指纹。否则面板建出来后，rebootstrap 每 3 秒
       看到 sig !== '' 就重复 boot，日志被清、按钮被抢，像是页面卡死。 */
    try { panelSig = qsig(); } catch (eSig0) { panelSig = ''; }

    /* ① 已批改的结果页：绝不能再答一遍。
       上一版就是在这里出的事——结果页上 `.TiMu` 还在，被当成答题页重做了一遍。 */
    if (st) {
      /* 结果页也要记住当前指纹。否则 rebootstrap 每 3 秒看到 sig !== ''，
         就会把面板反复拆掉重建：用户点停止/拖动正好落在重建间隙，
         表现就是「按钮和拖动全死了」。 */
      try { panelSig = qsig(); } catch (eSig) { panelSig = ''; }
      if (!settings.pipe) {
        ensurePanel();
        panel.log('这一页已经批改过了（' + (st === 'fail' ? '没及格' : '已通过') + '），不再重复作答。', 'warn');
        panel.status('已批改，无需作答');
        return;
      }
      if (st === 'fail') {
        if (isPaused()) {
          ensurePanel();
          panel.log('已暂停：这一页没及格，但不会自动重做。想重做就点页面上那个「重做」。', 'warn');
          panel.status('已暂停');
          return;
        }
        var wid = workIdOf(location.href);
        var done = PL.reworkCount ? PL.reworkCount() : 0;
        if (PL.triedBefore('rework:' + wid) || done >= 6) {
          panelBootLog('这份测验重做过还是没及格（或重做次数已达上限），先记下来跳过，别原地打转。');
          if (PL.markFailed) PL.markFailed(wid);
        } else {
          PL.markTried('rework:' + wid);
          if (PL.bumpRework) PL.bumpRework();
          /* 关键：先清缓存，否则重做用的还是同一批错答案 -> 永远不及格 */
          forgetCache('刚才那份没及格');
          var rw = CX.findRework();
          if (rw) {
            panelBootLog('没及格。已清掉答题缓存（不再用旧的错答案），重做一次。');
            fireClickSafe(rw);
            setTimeout(boot, 2500);
            return;
          }
          panelBootLog('没及格，但页面上找不到「重做」按钮，先往下走。');
          if (PL.markFailed) PL.markFailed(wid);
        }
      } else {
        panelBootLog('这一页已经批改完了，切下一个。');
      }
      setTimeout(function () { goNext('交完了'); }, 1200);
      return;
    }

    /* ①.5 视频 / 音频任务点：自动播放 + 倍速 + 播完往下翻。
       必须放在「不是测验页就往下翻」之前——否则视频会被直接跳过去。 */
    var vid = null;
    if (VK && settings.video !== false) {
      try { vid = VK.detect(document); } catch (e) { vid = null; }
      /* 只认任务点媒体：顶层课程壳里的提示音/背景音不是这一节要播的东西。 */
      if (vid && !mediaOwnedBy(root, vid)) {
        /* 已完成的任务点不是「没活」，而是「这节已经做完了」。
           旧逻辑把 vid 置空后直接落到「不是测验页」的 idle 分支，但
           idle 又因为这一层没有可做的活而被锁/提前返回，视频绿了也不翻页。 */
        if (mediaTaskFinished(root, vid)) {
          ensurePanel();
          var _more = null;
          try { _more = (VK && VK.firstUnfinishedTask) ? VK.firstUnfinishedTask() : null; } catch (eM) { _more = null; }
          if (isPaused()) {
            if (panel) {
              panel.status(_more ? '待命：上面的视频已完成，点「▶ 一键启动」继续下一个'
                                 : '待命：视频任务点已完成，点「▶ 一键启动」继续下一节');
              panel.log('这一页的视频任务点已经绿了，脚本不会重播；启动后自动按顺序继续。', 'dim');
            }
            return;
          }
          if (_more) {
            /* 这一页还有别的视频没做完：按顺序继续，不要点「下一节」。 */
            if (panel) panel.status('这个视频任务点已完成，按从上到下顺序继续下一个…');
            setTimeout(function () {
              if (!isPaused()) startNextMediaTask('上一个视频已完成');
            }, 300);
            return;
          }
          if (panel) panel.status('视频任务点已完成，准备下一节…');
          scheduleIdleAdvance('视频任务点已完成', 700);
          return;
        }
        try { trace('media-skip', { url: String(location.href), kind: vid.kind, at: 'boot' }); } catch (eS) { }
        vid = null;
      }
    }
    if (vid) {
      if (isPaused()) {
        /* v1.3.1：默认就是「没启动」，不再自动播了。
           用户原话：「现在遇到视频时还是自动播放，我想的是点一下启动」。 */
        ensurePanel();
        panel.status('待命：点「▶ 一键启动」开始播放这个' + (vid.kind === 'audio' ? '音频' : '视频'));
        panel.log('这一页是' + (vid.kind === 'audio' ? '音频' : '视频') + '任务点。点「▶ 一键启动」才开始。', 'dim');
        return;
      }
      startVideo(vid);
      return;
    }

    if (kind !== 'work') {
      // 只在测验/作业页露面；题目还没渲染出来时耐心等一下
      if (looksLikeWorkUrl() && bootTries++ < BOOT_MAX_TRIES) { setTimeout(boot, 1000); return; }
      /* ② 不是测验页（视频/文档/PPT/空页）：流水线模式下继续往下翻，直到碰到测验。
           最外层课程页自己不翻——它只提供服务，翻页由里面那个框架发起，免得两边一起点。
           「扩展阅读」「暂无内容」这类页面没有题目也没有视频，要直接当空页处理，
           不能因为旧 iframe 里还留着上一节的内容就停在这里。 */
      var _idleWhy = '';
      try { _idleWhy = idlePageHint(); } catch (eIH) { _idleWhy = ''; }
      if (_idleWhy) {
        try {
          var _ip = ensurePanel();
          if (_ip) {
            if (_ip.status) _ip.status(_idleWhy + '：准备下一节…');
            if (_ip.log) _ip.log('识别到' + _idleWhy + '，这一页没有要做的题/视频，自动点「下一节」。', 'dim');
          }
        } catch (eIP) { /* ... */ }
      }
      scheduleIdleAdvance(_idleWhy || '这一页不是测验', _idleWhy ? 500 : 800);
      return;
    }

    var qs = CX.extractQuestions();
    if (!qs.length) {
      // 有 .TiMu 但一题都没解出来（可能还在加载）-> 再等等；真没有就往下翻
      if (bootTries++ < BOOT_MAX_TRIES) { setTimeout(boot, 1000); return; }
      scheduleIdleAdvance('这一页没有题目', 800);
      return;
    }

    ensurePanel();

    /* 把这一页真正解析出来的题干/选项，以及一道题的原始 HTML 写进桥的日志。
       公式题答不出来时，只能靠这个看清楚 DOM 里到底是什么。 */
    try {
      trace('questions', {
        n: qs.length,
        items: qs.slice(0, 8).map(function (q) {
          return {
            t: String(q.stem || '').slice(0, 140),
            o: (q.options || []).map(function (o) { return String(o.text || '').slice(0, 60); })
          };
        })
      });
      var _tm = document.querySelector('.TiMu') || document.querySelector('.singleQuesId');
      if (_tm) trace('dom', { html: String(_tm.outerHTML || '').slice(0, 1800) });
    } catch (e7) { /* ... */ }

    panel.log('检测到测验页，共 ' + qs.length + ' 题。' + (settings.pipe ? '流水线模式：自动开答。' : '点「开始答题」即可。'), 'ok');
    panel.status('待命中：' + qs.length + ' 题');
    console.log('[免费题库] 已就绪，题目数：' + qs.length);
    panelSig = qsig();

    if (settings.pipe) {
      if (isPaused()) {
        panel.status('已暂停');
        panel.log('已暂停。点「开始答题」才继续。', 'dim');
        return;
      }
      setTimeout(function () {
        if (running || isPaused()) return;
        if (!selfDocVisible() || !localWork()) return;   // 这期间切走了/被隐藏了
        panel.log('流水线模式：自动开始答题。', 'ok');
        run();
      }, 2000);
    }
  }

  /* 结果页上没有面板，这句话只能进徽标的弹窗和日志缓冲 */
  function panelBootLog(msg) {
    pipeLog(msg, 'ok');
    var p = ensurePanel();
    if (p && p.log) p.log(msg, 'ok');
  }

  /* ============ AJAX 换章节兜底：学习通点侧边栏不会重新加载页面 ============ */
  /* 题目 qid 集合的指纹，用来判断「题目换了一批」 */
  function qsig() {
    try {
      return CX.extractQuestions().map(function (q) { return q.qid; }).join(',');
    } catch (e) { return ''; }
  }

  var lastBoot = 0;
  function rebootstrap() {
    var now = Date.now();
    if (now - lastBoot < 900) return;      // 页面动态元素很多，防抖
    lastBoot = now;
    try { makeBadge(); } catch (e) { /* 徽标尽力而为 */ }

    /* 先验活：旧答题 iframe 交卷/翻页后，面板 DOM 可能还在，但按钮监听器
       已经跟着旧 realm 死掉了。这种情况必须让 ensurePanel 重建，不能复用。 */
    if (panel && !usablePanel(panel)) panel = null;
    try {
      var XR = XF();
      var hp = XR && XR.get ? XR.get('panel') : null;
      if (hp && !usablePanel(hp)) ensurePanel();   // 本地没有 panel 时也能替换僵尸
    } catch (eP) { /* ... */ }
    /* 学习通切任务点/换 tab 是 AJAX：URL 和「当前任务点」会变，但页面
       不重新加载。以前只盯 qsig，空页/扩展阅读页没有题目（qsig=''），
       面板又已经存在，于是这里直接 return —— 页面就永远停在「暂无内容」。
       先按 pageKey 判断整页有没有换，换了就重新 boot 一次。 */
    var pk = '';
    try { pk = pageKey(); } catch (ePK) { pk = ''; }
    if (pk && pk !== lastPageKey) {
      if (!selfDocVisible()) return;
      lastPageKey = pk;
      resetPageIdle();
      bootTries = 0;
      boot();
      return;
    }

    var sig = qsig();
    if (panel && sig && sig !== panelSig) {
      /* 换章节/换题了：保留同一个面板实例和事件监听器，只刷新内容并重新
         boot 一次。旧实现会 removeChild 再重建，点击落在重建间隙就丢事件，
         用户看到的就是「停止/拖动/其他按钮全没反应」。 */
      panelSig = sig;
      try { if (panel.clear) panel.clear(); } catch (eC) { /* ... */ }
      try { if (panel.status) panel.status('检测到新题目，准备中…'); } catch (eS) { /* ... */ }
      bootTries = 0;
      boot();
      return;
    }
    if (panel || !sig) return;
    bootTries = 0;
    boot();
  }

  function watchAjax() {
    try {
      var mo = new MutationObserver(rebootstrap);
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { /* 没有 MutationObserver 就算了 */ }
    ['pushState', 'replaceState'].forEach(function (m) {
      try {
        var orig = root.history && root.history[m];
        if (typeof orig === 'function') {
          root.history[m] = function () { var r = orig.apply(this, arguments); rebootstrap(); return r; };
        }
      } catch (e) { /* 改不动就算了 */ }
    });
    try { root.addEventListener('popstate', rebootstrap); } catch (e) { /* ... */ }
    try { setInterval(rebootstrap, 3000); } catch (e) { /* ... */ }
  }

  function startup() {
    setTimeout(boot, 800);
    setTimeout(registerCtl, 1200);      // 题目是异步塞进来的，晚点再登记一次
    setTimeout(registerCtl, 4000);
    setTimeout(watchAjax, 2500);
    setTimeout(reportBoot, 1600);       // 给桌面那个黑窗口回一行，证明脚本真的跑了
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startup);
  else startup();
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot
   : (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window));