// ==UserScript==
// @name         学习小助手（无需 key）
// @name:zh-CN   学习小助手（无需 key）
// @namespace    local.free-tiku
// @version      1.3.47
// @description  学习通章节测验 / 作业自动搜题、自动填答案，视频与音频任务点自动播放（可调倍速），没有内容或已做过的页面自动往下翻。题库走百度教育 + GO题（完全免费），可选 DeepSeek AI 兜底；不需要自建服务器，也不上传你的账号信息。自动还原学习通的加密字体。
// @author       FreeTikuHelper contributors
// @license      GPL-3.0-or-later
// @copyright    2026 FreeTikuHelper contributors
// @match        *://*.chaoxing.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      easylearn.baidu.com
// @connect      q.icodef.com
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

/* eslint-disable */

/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 FreeTikuHelper contributors
 * This userscript is free software under the GNU GPL v3 or later.
 * See LICENSE and THIRD_PARTY_NOTICES.md in the source repository. */

(function () {
  'use strict';

  /* 所有模块共用的挂载对象。
     以前 core.js 挂到 globalThis、其余模块读 unsafeWindow —— 这两者在篡改猴沙箱里
     不一定是同一个对象，一旦不一致，main 就会「模块没挂上」直接 return：
     页面上没有徽标、黑窗口也没有任何回执，正是之前那个「怎么都没有」的样子。
     现在由本构建器统一提供一个，四个模块都挂到它上面。 */
  var __ftkRoot = (typeof window !== "undefined" ? window : globalThis);
  var __ftkStuck = "";

/* ======================== beacon.js ======================== */
/* ============================================================================
 *  beacon.js —— 只干一件事：告诉桌面那个黑窗口「脚本真的进来了」。
 *
 *  为什么单独放一个文件、还排在所有模块最前面：
 *    如果 main.js 因为「模块没挂上」而提前 return，页面和黑窗口都会毫无动静，
 *    根本分不清是「脚本没被注入」还是「注入了但中途失败」。
 *    这个信标只依赖 GM_xmlhttpRequest 和 location，几乎不可能失败，
 *    所以它报出来的那一行，就是「脚本确实在跑」的硬证据。
 *
 *  它挂在所有模块共用的那个对象上（__ftkRoot），所以即使 core/panel/chaoxing
 *  全都没挂上，main.js 仍然能通过 root.__ftkBeacon 把失败原因报回去。
 * ==========================================================================*/
(function (root) {
  'use strict';

  var BRIDGE_PING = 'http://127.0.0.1:8060/ping?';

  function frameKind() {
    try { return (root.top === root.self) ? 'top' : 'sub'; }
    catch (e) { return 'unknown'; }
  }

  function send(reason, info) {
    if (typeof GM_xmlhttpRequest !== 'function') return;   /* 不是油猴环境，没什么可报的 */
    var q = 'reason=' + encodeURIComponent(reason)
          + '&frame=' + frameKind()
          + '&body=' + (root.document && root.document.body ? 1 : 0)
          + '&url=' + encodeURIComponent(String((root.location && root.location.href) || '').slice(0, 160))
          + (info ? '&info=' + encodeURIComponent(info) : '');
    try {
      GM_xmlhttpRequest({
        method: 'GET', url: BRIDGE_PING + q, timeout: 5000,
        onload: function () { }, ontimeout: function () { }, onerror: function () { }
      });
    } catch (e) { /* 报信失败绝不能影响答题 */ }
  }

  root.__ftkBeacon = send;
  send('beacon');                       /* 一进来就报一次：证明「注入成功 + GM API 可用」 */

  setTimeout(function () {               /* 3 秒后 main 还没说 ok，说明中途卡住了 */
    if (!root.__ftkReady) send('beacon-stuck', root.__ftkStuck || 'unknown');
  }, 3000);
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot : window);

/* ======================== xframe.js ======================== */
/* ============================================================================
 *  xframe.js —— 同源 iframe 之间的「唯一通道」
 *
 *  为什么需要它（踩过的坑，别再改回去）：
 *    学习通一个页面里套了好几层同源 iframe。为了让整页只出现一份徽标/面板、
 *    并让「答题的那一层」和「外层课程页」能互相说话，1.1.0~1.1.4 用的是
 *    `window.__ftkPanel` / `window.__ftkAdvance` 这类自定义属性。
 *    但篡改猴带 @grant 时 window 是**沙箱对象**：
 *      · 在外层写 `window.__ftkPanel` —— 写进了外层沙箱，别的框架读不到；
 *      · 子框架里 `window.top` 拿到的是**真实页面 window**，读的是另一个对象。
 *    结果：子框架永远找不到外层的面板 → 日志被塞进一个永远不 flush 的转发器
 *    （用户看到「不显示做题过程」）；外层面板的按钮绑在外层自己的 run() 上，
 *    而外层没有题目（用户看到「点开始答题没反应」）。
 *
 *  可靠的做法：**用 DOM 节点当共享内存**。同源 iframe 之间
 *    `top.document.getElementById(id)` 拿到的是同一个元素，
 *    元素上的 expando 属性（`el.__ftk`）是跨框架可见的。
 * ==========================================================================*/
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.FreeTikuX = api;
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot
   : (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window),
   function (root) {
     'use strict';

     var REG_ID = 'ftk-xframe';
     var ID = 'f' + Math.floor(Math.random() * 1e9).toString(36) + '-' + Date.now().toString(36);

     function docOf(w) {
       try { return (w && w.document) || null; } catch (e) { return null; }
     }

     function isTop() {
       try { return root.top === root.self; } catch (e) { return false; }
     }

     /* 最外层那个 window（跨域拿不到就 null） */
     function topWin() {
       try {
         var t = root.top;
         if (t && t !== root) return t;
       } catch (e) { /* 跨域 */ }
       return null;
     }

     /* 最外层能读到的 document（跨域就 null） */
     function topDoc() {
       var t = topWin();
       var d = docOf(t);
       if (d) return d;
       if (isTop()) return root.document || null;      // 自己就是最外层
       return null;
     }

     /* 这个文档能不能承载我们塞进去的 UI？ */
     function canHost(d) {
       if (!d) return false;
       try {
         if (d.body) return true;
         var de = d.documentElement;
         return !!(de && de.tagName === 'HTML' && !de.querySelector('frameset'));
       } catch (e) { return false; }
     }

     /* 注册表节点：永远放在最外层文档里，这样每一层读到的都是同一份。
        （最外层是 frameset 时，documentElement 上挂个 div 也不会渲染，但读得到。） */
     function regNode() {
       var d = topDoc() || root.document;
       if (!d) return null;
       var el = null;
       try { el = d.getElementById(REG_ID); } catch (e) { el = null; }
       if (!el) {
         try {
           el = d.createElement('div');
           el.id = REG_ID;
           el.style.display = 'none';
           var host = d.body || d.documentElement;
           if (!host) return null;
           host.appendChild(el);
         } catch (e2) { return null; }
       }
       if (!el.__ftk) el.__ftk = { panel: null, badge: null, advance: null, ctls: {}, order: [], lock: {} };
       return el;
     }

     function reg() {
       var el = regNode();
       return el ? el.__ftk : null;
     }

     /* UI 该挂到哪个文档上：优先生在最外层；
        最外层是 frameset（塞不进去、也渲染不出来）时，让最先到的那个子框架顶上，只顶一个。 */
     function home() {
       var td = topDoc();
       if (canHost(td)) return td;
       var sd = root.document;
       if (canHost(sd)) {
         if (td) {
           var de = td.documentElement;
           if (de) {
             if (de.__ftkHome && de.__ftkHome !== ID) return null;   // 已经有别人顶了
             if (!de.__ftkHome) { try { de.__ftkHome = ID; } catch (e) { } }
           }
         }
         return sd;
       }
       return null;
     }

     /* ---- 共享存储 ---- */
     function get(k) {
       var r = reg();
       if (!r) return null;
       return r[k] === undefined ? null : r[k];
     }
     function set(k, v) {
       var r = reg();
       if (r) r[k] = v;
       return v;
     }
     /* 抢占式「我来建」：跨框架同步，抢不到说明别人在建或已经建好了 */
     var LOCK_TTL = 15000;                      // 锁的过期时间（毫秒）
     function claim(k, ttl) {
       var r = reg();
       if (!r) return true;                     // 拿不到注册表就自己干，别卡死
       if (r[k]) return false;
       var lk = r.lock[k];
       if (lk) {
         /* 老格式是一串 ID；新格式是 {id, at}。
            为什么要过期：点「下一节」之后 iframe 会整个导航，**释放锁的那个
            定时器跟着旧框架一起没了**，锁永远留着死掉的 ID，之后任何框架都
            抢不到 → 空页面再也不自动翻页，整章停在那里。 */
         var at = (lk && lk.at) || 0;
         var life = Number(ttl) > 0 ? Number(ttl) : LOCK_TTL;
         if (Date.now() - at < life) return false;
       }
       r.lock[k] = { id: ID, at: Date.now() };
       return true;
     }
     function release(k) {
       var r = reg();
       if (!r) return;
       var lk = r.lock[k];
       if (!lk) return;
       if (lk === ID || lk.id === ID) r.lock[k] = null;
     }

     /* ---- 命令槽：纯 DOM 数据的兜底通道 ----
        面板按钮正常走 ctlDispatch（跨框架直接调函数）。万一那条路断了
        （登记表里那层还没登记、或者函数调用被沙箱挡住），面板还能把命令
        写进这个槽，有活的框架轮询到就自己执行 —— 按钮不至于变成死键。 */
     function cmdSend(cmd, arg) {
       var r = reg();
       if (!r) return false;
       var o = r.cmd;
       if (!o) { o = { n: 0, cmd: '', arg: null, at: 0, by: '', taken: '' }; r.cmd = o; }
       o.n++;
       o.cmd = String(cmd || '');
       o.arg = (arg === undefined) ? null : arg;
       o.at = Date.now();
       o.by = ID;
       o.taken = '';
       return true;
     }
     function cmdRecv() {
       var r = reg();
       if (!r || !r.cmd || !r.cmd.cmd) return null;
       if (r.cmd.by === ID) return null;      // 自己发的不收
       if (r.cmd.taken) return null;          // 已经被别人领走了
       /* 返回快照：直接把登记表里那个活对象交出去的话，
          调用方拿着它的时候它还在被改写（序号会跟着变）。 */
       var o = r.cmd;
       return { n: o.n, cmd: o.cmd, arg: o.arg, at: o.at, by: o.by, taken: o.taken };
     }
     function cmdTake() {
       var r = reg();
       if (r && r.cmd) r.cmd.taken = ID;
     }

     /* ---- 控制器登记表：面板上的按钮要点到「真正有活干的那一层」 ---- */
     function ctlRegister(obj) {
       var r = reg();
       if (!r || !obj) return;
       obj.id = ID;
       obj.dead = false;
       /* 记下这个控制器属于哪个 window/document。同一个页面被重复注入时，
          旧实例不能继续收「开始/停止」，否则多层框架会各开一个视频驱动。 */
       obj.win = obj.win || root;
       try { obj.doc = obj.doc || docOf(root); } catch (eD0) { obj.doc = null; }
       for (var oldId in r.ctls) {
         var old = r.ctls[oldId];
         if (old && old !== obj && old.win && old.win === obj.win) old.dead = true;
       }
       r.ctls[ID] = obj;
       if (r.order.indexOf(ID) < 0) r.order.push(ID);
       try {
         root.addEventListener('pagehide', function () { obj.dead = true; });
       } catch (ePH) { /* 老环境没有 pagehide 就算了 */ }
     }
     function alive(c) {
       if (!c || c.dead) return false;
       try { if (c.win && c.win.closed) return false; } catch (eW) { /* 沙箱读不到 */ }
       /* iframe 导航后旧 window 的 document 已经换了，旧控制器不能再干活。 */
       try { if (c.doc && c.win && c.doc !== c.win.document) return false; } catch (eD) { /* ... */ }
       return true;
     }
     function ctlUpdate(patch) {
       var r = reg();
       if (!r || !r.ctls[ID] || !patch) return;
       for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) r.ctls[ID][k] = patch[k];
     }
     function hw(c) { return (typeof c.hasWork === 'function') ? !!c.hasWork() : !!c.hasWork; }
     function busyOf(c) { return (typeof c.busy === 'function') ? !!c.busy() : !!c.busy; }

     /* skipSelf=true 时绝不自选：否则面板上的按钮会被派回建面板的那一层，
        而那一层往往没题目 —— 就是「点了没反应」的死因。 */
     function ctlPick(want, skipSelf) {
       var r = reg();
       if (!r) return null;
       var best = null;
       for (var i = 0; i < r.order.length; i++) {
         var c = r.ctls[r.order[i]];
         if (!alive(c)) continue;
         if (skipSelf && c.id === ID) continue;
         if (hw(c)) return c;               // 有题的那一层优先
         if (!best) best = c;
       }
       return want === 'work' ? null : best;
     }
     function ctlDispatch(cmd, arg) {
       var c = null;
       try { c = ctlPick('any', true); } catch (e0) { c = null; }
       if (!c || typeof c[cmd] !== 'function') return false;
       try { c[cmd](arg); return true; } catch (e) { return false; }
     }
     /* 广播：每个登记过的框架都调一次，谁认领谁干活，返回认领的个数。
        面板住在最外层、视频和题目在子框架里时，「点启动」只能靠它 ——
        以前 ctlDispatch 只挑一个框架，而且优先挑「有活」的那个，
        结果把「开始」派给了视频框架的答题函数，视频一动不动。 */
     function ctlEach(cmd, arg) {
       var r = reg();
       if (!r) return 0;
       var n = 0;
       for (var i = 0; i < r.order.length; i++) {
         var c = r.ctls[r.order[i]];
         if (!alive(c) || typeof c[cmd] !== 'function') continue;
         try { if (c[cmd](arg)) n++; } catch (e) { /* 单个框架炸了不影响别人 */ }
       }
       return n;
     }
     function ctlBusy() {
       var r = reg();
       if (!r) return 0;
       var n = 0;
       for (var k in r.ctls) if (alive(r.ctls[k]) && busyOf(r.ctls[k])) n++;
       return n;
     }
     function ctlHasWork() { return !!ctlPick('work'); }

     /* ---- 遍历同源框架（诊断 / 判断「整棵树里还有没有活」用） ---- */
     function frames(fromWin, maxDepth) {
       var out = [], seen = 0;
       var start = fromWin || topWin() || root;
       function walk(w, d) {
         if (!w || d > (maxDepth == null ? 3 : maxDepth)) return;
         if (seen > 40) return;
         seen++;
         out.push({ win: w, doc: docOf(w) });
         var doc = docOf(w);
         if (!doc) return;
         var fr;
         try { fr = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
         for (var i = 0; i < fr.length; i++) {
           var cw = null;
           try { cw = fr[i].contentWindow; } catch (e2) { cw = null; }
           if (!cw) continue;
           try { void cw.document; walk(cw, d + 1); } catch (e3) { /* 跨域跳过 */ }
         }
       }
       walk(start, 0);
       return out;
     }

     return {
       ID: ID,
       REG_ID: REG_ID,
       isTop: isTop,
       topWin: topWin,
       topDoc: topDoc,
       canHost: canHost,
       home: home,
       regNode: regNode,
       get: get, set: set, claim: claim, release: release,
       cmdSend: cmdSend, cmdRecv: cmdRecv, cmdTake: cmdTake,
       ctlRegister: ctlRegister, ctlUpdate: ctlUpdate, ctlPick: ctlPick, ctlEach: ctlEach,
       ctlDispatch: ctlDispatch, ctlBusy: ctlBusy, ctlHasWork: ctlHasWork,
       frames: frames
     };
   });

/* ======================== core.js ======================== */
/* ============================================================================
 * FreeTikuCore —— 免费题库核心（零依赖纯逻辑 + 双源检索）
 * ----------------------------------------------------------------------------
 * 两个免费数据源，都不需要任何 token：
 *   1) 百度教育公开搜索  https://easylearn.baidu.com/edu-web-go/bgk/searchlist
 *      返回的 bdjson 是异或加密的，用 actk 当密钥解密（复刻 tikuAdapter 的
 *      internal/search/buguake.go）。字段结构是 {"t":"span","c":"文字"} 的嵌套树。
 *   2) GO题  https://q.icodef.com/wyn-nb?v=4   （POST form: question=...）
 *      返回 {code,data,msg}，data 里多选答案用 # 分隔。
 *
 * 本文件不做任何 DOM/网络假设：网络通过 transport(opts) 注入，
 * 所以同一份代码既能跑在油猴（GM_xmlhttpRequest）、也能跑在 node 里做单元测试。
 * ==========================================================================*/
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FreeTikuCore = api;
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var XOR_SEED = '34cab29ef956d78afd';
  var SIM_THRESHOLD = 0.8;
  var LETTERS = /^[A-Za-z](?:[\s,，、;；/|]?[A-Za-z])*$/;
  var OPT_PREFIX = /^[a-z][.、,，:：)）]\s*/;
  var CTRL = /[\x00-\x1f\x7f]+/g;

  /* ------------------------------------------------------------ 文本归一化 */

  function nfkc(s) {
    s = String(s == null ? '' : s);
    try { return s.normalize('NFKC'); } catch (e) { return s; }
  }

  // 去所有空白 + 转小写。NFKC 会把康熙部首、CJK 兼容汉字、全角字母拉回常规码位，
  // 这是 edu 题库与卷面文字能对上的前提（与 chaoxing 的 normalize_text 同思路）。
  // 公式题还常带反引号、$、LaTeX 反斜杠/花括号；不剥掉的话，题库和卷面
  // 明明是同一条式子也会因为写法不同而匹配失败。
  function norm(s) {
    s = nfkc(s)
      .replace(/[`$]/g, '')
      .replace(/\\[a-zA-Z]+/g, function (m) { return m.slice(1); })
      .replace(/[{}]/g, '')
      .replace(/\\[,;!]/g, '');
    return s.replace(/[\s\u3000]+/g, '').toLowerCase();
  }

  /* 把常见 LaTeX 写法转成卷面上更常见的普通符号。
     例：\frac{1}{2} -> 1/2，\log_{10} -> log10，\times -> ×。 */
  function latexPlain(s) {
    var greek = {
      alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ',
      lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ',
      omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π',
      Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω'
    };
    return String(s == null ? '' : s)
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
      .replace(/\\text\s*\{([^{}]*)\}/g, '$1')
      .replace(/\\left|\\right|\\,|\\;|\\!|\\quad|\\qquad/g, '')
      .replace(/\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|tau|phi|omega|Gamma|Delta|Theta|Lambda|Pi|Sigma|Phi|Omega)\b/g,
        function (m, n) { return greek[n] || n; })
      .replace(/\\times\b/g, '×').replace(/\\cdot\b/g, '·')
      .replace(/\\div\b/g, '÷').replace(/\\pm\b/g, '±')
      .replace(/\\le\b/g, '≤').replace(/\\ge\b/g, '≥')
      .replace(/\\neq\b/g, '≠').replace(/\\approx\b/g, '≈')
      .replace(/\\infty\b/g, '∞')
      .replace(/[_^]\s*\{([^{}]*)\}/g, '$1')
      .replace(/[_^]/g, '')
      .replace(/[{}]/g, '')
      .replace(/[`$]/g, '');
  }

  // 去掉选项的 "A." / "a、" 前缀后再归一：
  // chaoxing 传过来的选项是剥过前缀的，OCS 的 ${options} 是带前缀的，靠它对齐。
  function bare(s) {
    return norm(s).replace(OPT_PREFIX, '');
  }

  /* --------------------------------------------------------- 相似度（替代 difflib）
   * Python 用 difflib.SequenceMatcher.ratio() = 2M/T。这里用 LCS 长度当 M，
   * 阈值判定（0.8）下与 Python 结论一致，且是确定性的。
   */
  function lcsLen(a, b) {
    if (!a.length || !b.length) return 0;
    var n = a.length, m = b.length, i, j;
    var prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
    for (i = 1; i <= n; i++) {
      for (j = 1; j <= m; j++) {
        cur[j] = a.charCodeAt(i - 1) === b.charCodeAt(j - 1)
          ? prev[j - 1] + 1
          : (prev[j] > cur[j - 1] ? prev[j] : cur[j - 1]);
      }
      var t = prev; prev = cur; cur = t;
      cur.fill(0);
    }
    return prev[m];
  }

  function ratio(a, b) {
    a = norm(a); b = norm(b);
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    var n = a.length, m = b.length;
    if (n * m > 400000) {           // 超长文本退化成字符集合重叠，避免卡死
      var setB = {}, hit = 0, k;
      for (k = 0; k < m; k++) setB[b[k]] = 1;
      for (k = 0; k < n; k++) if (setB[a[k]]) hit++;
      return (2 * hit) / (n + m);
    }
    return (2 * lcsLen(a, b)) / (n + m);
  }

  /* ------------------------------------------------------------ 题型归一化 */

  var TYPE_MAP = {
    single: 0, '单选题': 0, '单选': 0,
    multiple: 1, '多选题': 1, '多选': 1,
    completion: 2, '填空题': 2, '填空': 2, 'fill': 2,
    judgement: 3, '判断题': 3, '判断': 3, 'judge': 3,
    shortanswer: 4, '简答题': 4, '问答题': 4, '问答': 4
  };

  function normType(v) {
    if (typeof v === 'boolean') return v ? 3 : 0;
    if (typeof v === 'number') return (v >= 0 && v <= 4 && v === (v | 0)) ? v : 0;
    var s = String(v == null ? '' : v).trim();
    if (Object.prototype.hasOwnProperty.call(TYPE_MAP, s)) return TYPE_MAP[s];
    if (Object.prototype.hasOwnProperty.call(TYPE_MAP, s.toLowerCase())) return TYPE_MAP[s.toLowerCase()];
    var n = parseInt(s, 10);
    return (n >= 0 && n <= 4) ? n : 0;
  }

  function normOptions(v) {
    if (!v) return [];
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return [];
      if (s.charAt(0) === '[') {                    // OCS 有时把数组序列化成字符串
        try {
          var arr = JSON.parse(s);
          if (Array.isArray(arr)) {
            return arr.map(function (x) { return String(x).trim(); }).filter(Boolean);
          }
        } catch (e) { /* 落到下面按行切 */ }
      }
      var parts = s.split(/[\n\r]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (parts.length === 1 && s.indexOf('#') >= 0) {
        parts = s.split('#').map(function (x) { return x.trim(); }).filter(Boolean);
      }
      return parts;
    }
    /* 数组分支**不能** filter(Boolean)：卷面上某个选项整块是图片/没有文字时，
       这个空串被过滤掉，后面所有选项的字母都会前移一位（B 变 A）。
       保留占位、在匹配时跳过空项，字母才和卷面对得上。 */
    if (Array.isArray(v)) return v.map(function (x) { return String(x == null ? "" : x).trim(); });
    return [];
  }

  function normQuestion(req) {
    return String((req && (req.question || req.title)) || '').trim();
  }

  /* -------------------------------------------------------- 判断题语义归一
   * 选项常写「对/错」「√/×」「正确/错误」，而题库可能回任意一种写法。
   * 「正确」里并不含「对」字，字面上互不包含，所以必须做语义归一。
   * 必须先判「否」，否则「不正确」会因为包含「正确」被误判为真。
   */
  var JUDGE_FALSE = ['不正确', '不对', 'false', '错误', '不是', 'no', '×', '✗', '错', '否', '假', 'f', 'n', '0'];
  var JUDGE_TRUE = ['正确', '是的', '对', '是', '真', 'true', '√', '✓', 'yes', 't', 'y', '1'];

  function judgeBool(text) {
    var t = norm(text);
    if (!t) return null;
    var i, w;
    for (i = 0; i < JUDGE_FALSE.length; i++) {
      w = norm(JUDGE_FALSE[i]);
      if (w && t.indexOf(w) >= 0) return false;
    }
    for (i = 0; i < JUDGE_TRUE.length; i++) {
      w = norm(JUDGE_TRUE[i]);
      if (w && t.indexOf(w) >= 0) return true;
    }
    return null;
  }

  /* ------------------------------------------------------------------ 解密 */

  function b64ToBytes(t) {
    var s = String(t == null ? '' : t).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin;
    if (typeof atob === 'function') {
      bin = atob(s);
    } else {
      bin = Buffer.from(s, 'base64').toString('latin1');
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  function latin1ToUtf8(latin) {
    // 把 Latin-1 字节串里的 %XX 解成字节，再整体按 UTF-8 解码
    // （对齐 Python 的 urllib.parse.unquote）
    var bytes = [], i, ch;
    for (i = 0; i < latin.length; i++) {
      ch = latin.charAt(i);
      if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(latin.substr(i + 1, 2))) {
        bytes.push(parseInt(latin.substr(i + 1, 2), 16));
        i += 2;
      } else {
        bytes.push(latin.charCodeAt(i) & 0xff);
      }
    }
    try {
      if (typeof TextDecoder === 'function') {
        return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
      }
      return Buffer.from(bytes).toString('utf8');
    } catch (e) {
      return latin;
    }
  }

  /* 复刻 tikuAdapter/internal/search/buguake.go 的 decrypt()：
   * 先用 seed+actk 逐字节异或，再把相邻字节两两异或，最后百分号解码。 */
  function decrypt(t, r) {
    var e = XOR_SEED + String(r == null ? '' : r);
    var raw = b64ToBytes(t);
    var x = new Uint8Array(raw.length);
    var o = 0, c;
    for (c = 0; c < raw.length; c++) {
      o %= e.length;
      x[c] = raw[c] ^ (e.charCodeAt(o) & 0xff);
      o += 1;
    }
    var latin = '';
    for (c = 0; c + 1 < x.length; c += 2) {
      latin += String.fromCharCode(x[c] ^ x[c + 1]);
    }
    return latin1ToUtf8(latin).replace(/\+/g, ' ');
  }

  /* ------------------------------------------------- 百度结果结构遍历 */

  /* 从 {"t":"span","c":"文字"} 这类嵌套结构里挤出所有文字。
   * 注意：百度把多个答案用 \x01 这类控制字符拼在同一个字符串里
   * （例如 "科学社会主义\x01马克思主义政治经济学\x01马克思主义哲学"），
   * 必须先按控制字符拆开，否则多选会被当成一整个答案。 */
  function texts(node, acc) {
    acc = acc || [];
    (function rec(x) {
      var i, k, parts, p;
      if (typeof x === 'string') {
        parts = x.split(CTRL);
        for (i = 0; i < parts.length; i++) {
          p = parts[i].trim();
          if (p) acc.push(p);
        }
      } else if (Array.isArray(x)) {
        for (i = 0; i < x.length; i++) rec(x[i]);
      } else if (x && typeof x === 'object') {
        var keys = ['c', 'ret', 'text', 'content', 'value'];
        for (i = 0; i < keys.length; i++) {
          k = keys[i];
          if (Object.prototype.hasOwnProperty.call(x, k)) rec(x[k]);
        }
      }
    })(node);
    return acc;
  }

  function yesOptions(node, acc) {
    acc = acc || [];
    var i, k;
    if (Array.isArray(node)) {
      for (i = 0; i < node.length; i++) yesOptions(node[i], acc);
    } else if (node && typeof node === 'object') {
      if (node.yes === true) {
        var txt = texts(node).join(' ').trim();
        if (txt) acc.push(txt);
      }
      for (k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) yesOptions(node[k], acc);
      }
    }
    return acc;
  }

  function dig(node) {
    var cur = node;
    for (var i = 1; i < arguments.length; i++) {
      var key = arguments[i];
      if (Array.isArray(cur) && typeof key === 'number') {
        if (key >= cur.length) return null;
        cur = cur[key];
      } else if (cur && typeof cur === 'object') {
        cur = cur[key];
      } else {
        return null;
      }
      if (cur === undefined || cur === null) return null;
    }
    return cur;
  }

  /* 从一条解密结果里取出 (题干, 答案文本[], 答案字母[]) */
  function parseCandidate(obj) {
    var stem = dig(obj, 'que_stem', 0, 'c', 0, 'c');
    if (stem && typeof stem === 'object') stem = texts(stem).join(' ');
    stem = String(stem == null ? '' : stem).trim();

    var letters = [], out = [], t, i;
    var yes = yesOptions(obj);
    if (yes.length) {
      out = yes;
    } else {
      var ans = dig(obj, 'que_answer');
      if (ans !== null && ans !== undefined) {
        var raw = texts(ans);
        for (i = 0; i < raw.length; i++) {
          t = raw[i].trim();
          if (!t) continue;
          if (LETTERS.test(t)) {
            var m = t.toUpperCase().match(/[A-Za-z]/g) || [];
            for (var j = 0; j < m.length; j++) letters.push(m[j]);
          } else {
            out.push(t);
          }
        }
      }
    }
    return { stem: stem, texts: out, letters: letters };
  }

  /* ------------------------------------------------------------ 组装响应 */

  /* 题库答案常见写法：「哲学(或辩证唯物主义历史唯物主义)」—— 括号里是同义分支。
     拆出主文本与各括号内分支，任一分支能对上选项即算命中（不拆的话这种写法会漏选项）。 */
  function answerVariants(s) {
    var out = [];
    function push(x) {
      x = norm(x).replace(/^[.、,，:：)）\s]+/, '').replace(/[.、,，:：\s]+$/, '');
      if (x && out.indexOf(x) < 0) out.push(x);
    }
    var raw = String(s == null ? '' : s);
    push(raw);
    push(raw.replace(/^[A-Za-z]\s*[.、,，:：)）]\s*/, ''));
    push(raw.replace(/^[（(]\s*[A-Za-z]\s*[)）]\s*/, ''));
    push(raw.replace(/[`$]/g, ''));
    push(latexPlain(raw));
    push(String(raw).replace(/[（(][^（）()]*[)）]/g, ' '));   // 去掉括号 -> 主文本
    var re = /[（(]([^（）()]*)[)）]/g, mm;
    while ((mm = re.exec(raw))) push(mm[1].replace(/^(或|或者|也作|又叫|即)\s*/, ''));   // 括号内的分支
    return out;
  }

  /* 否定语气：「不增加」和「增加」是相反的，包含关系不能把它们算成同一个答案。
     以前这里没管，答案「不增加」+ 选项「增加/不增加」会两个都命中：
     单选题逐项点击、以最后点的为准 → 直接选反；多选还会把否定项一起勾上。 */
  function negatedText(s) {
    /* 先剥掉选项字母前缀（「B. 不增加」不能因为开头是 B 就被当成肯定句） */
    var t = String(s == null ? '' : s)
      .replace(/^[A-Za-z]\s*[.、,，:：)）]?\s*/, '')
      .replace(/^\s+/, '');
    /* 注意：这里以前写的是 /^[\s\W_]+/ —— JS 里 \w 只认 [A-Za-z0-9_]，
       汉字全算 \W，会把「不增加」整串吃掉，否定判断永远为假。 */
    if (/^(不|非|无|未|没|否|勿|莫|别|反)/.test(t)) return true;
    return /(不能|不会|不是|不要|不同|不需要|不必|没有|无法|并非|不属于|不包括)/.test(t);
  }

  function buildResponse(req, textsIn, lettersIn) {
    var question = normQuestion(req);
    var options = normOptions(req.options);
    var qtype = normType(req.type);
    var textsArr = (textsIn || []).slice();
    var letters = (lettersIn || []).slice();

    /* 有的源只回「B」或「A、C」，没有单独的 letters 字段。
       选择题里先把这种纯字母答案识别出来，避免后面拿字母去和选项正文比对。 */
    if (qtype !== 2 && options.length && !letters.length) {
      var onlyLetters = textsArr.length > 0;
      for (var li0 = 0; li0 < textsArr.length; li0++) {
        if (!/^[A-Za-z](?:[\s,，、;；/|]*[A-Za-z])*$/.test(String(textsArr[li0]).trim())) {
          onlyLetters = false;
          break;
        }
      }
      if (onlyLetters) {
        textsArr.forEach(function (b) {
          String(b).split('').forEach(function (c) { if (/[A-Za-z]/.test(c)) letters.push(c); });
        });
        textsArr = [];
      }
    }

    var answerKey = [], answerIndex = [], outTexts = [];

    // 判断题优先走语义归一：把「正确/√/是」统一到选项的实际写法上
    if (qtype === 3 && (textsArr.length || letters.length)) {
      var b = textsArr.length ? judgeBool(textsArr.join('')) : null;
      if (b === null && letters.length) b = judgeBool(letters.join(''));
      if (b !== null) {
        for (var i = 0; i < options.length; i++) {
          if (judgeBool(options[i]) === b) {
            answerIndex.push(i);
            answerKey.push(String.fromCharCode(65 + i));
            outTexts.push(options[i]);
            break;
          }
        }
        if (!outTexts.length) outTexts.push(b ? '对' : '错');   // 选项不是对/错类词，退回语义词
      }
    }

    if (!outTexts.length && textsArr.length && options.length) {
      // 按选项顺序扫，保证多选答案顺序与卷面一致
      var exactIdx = {};
      for (var k = 0; k < options.length; k++) {
        var no = norm(options[k]), bo = bare(options[k]);
        if (!no && !bo) continue;              // 空占位（纯图选项）不参与匹配，但保留它的字母位
        for (var m = 0; m < textsArr.length; m++) {
          var vs = answerVariants(textsArr[m]);
          var matched = false, exact = false;
          for (var v = 0; v < vs.length && !matched; v++) {
            var nt = vs[v];
            if (!nt) continue;
            if (nt === no || nt === bo) { matched = true; exact = true; }
            else if (negatedText(nt) === negatedText(no) &&
                     (no.indexOf(nt) >= 0 || (nt.length > 1 && nt.indexOf(no) >= 0))) {
              matched = true;          // 语气一致才允许「包含」算命中
            }
          }
          if (matched) {
            answerIndex.push(k);
            if (exact) exactIdx[k] = 1;
            answerKey.push(String.fromCharCode(65 + k));
            outTexts.push(options[k]);
            break;
          }
        }
      }
      /* 单选题只能有一个答案。命中多个说明答案文本和卷面有歧义，
         优先留「完全相等」的那一项（一个都没有就留第一个），
         否则单选页面会逐项点击、以最后点的为准，等于随机选。 */
      if (qtype === 0 && answerIndex.length > 1) {
        var _ki = [], _kk = [], _kt = [];
        for (var _e = 0; _e < answerIndex.length; _e++) {
          if (exactIdx[answerIndex[_e]]) {
            _ki.push(answerIndex[_e]); _kk.push(answerKey[_e]); _kt.push(outTexts[_e]);
          }
        }
        if (!_ki.length) { _ki = [answerIndex[0]]; _kk = [answerKey[0]]; _kt = [outTexts[0]]; }
        answerIndex = _ki; answerKey = _kk; outTexts = _kt;
      }
      if (!answerIndex.length) {            // 完全不沾边才做模糊兜底
        for (var p = 0; p < textsArr.length; p++) {
          var bestS = 0, bestI = -1;
          var pv = answerVariants(textsArr[p]);
          for (var q = 0; q < options.length; q++) {
            for (var vi = 0; vi < pv.length; vi++) {
              var s = ratio(pv[vi], options[q]);
              if (s > bestS) { bestS = s; bestI = q; }
            }
          }
          if (bestS >= 0.7 && bestI >= 0 && answerIndex.indexOf(bestI) < 0) answerIndex.push(bestI);
        }
        answerIndex.sort(function (a, b2) { return a - b2; });
        answerKey = answerIndex.map(function (n) { return String.fromCharCode(65 + n); });
        outTexts = answerIndex.map(function (n) { return options[n]; });
      }
    }

    if (!outTexts.length && letters.length) {
      var gotOne = false;
      for (var r = 0; r < letters.length; r++) {
        var ch = String(letters[r]).toUpperCase();
        var idx = ch.charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) {
          gotOne = true;
          if (answerKey.indexOf(ch) < 0) answerKey.push(ch);
          if (answerIndex.indexOf(idx) < 0) {
            answerIndex.push(idx);
            outTexts.push(options[idx]);
          }
        }
      }
      /* 数据源给了 A/B/C/D 以外的字母（例如只有 4 个选项却回 E），
         不能把它留成 bestAnswer —— 那不是能填到页面上的答案。 */
      if (!gotOne && options.length) { answerKey = []; answerIndex = []; }
    }
    if (!outTexts.length && textsArr.length && !options.length) {
      /* 只有填空题/没有选项的题，才允许把原始文字答案直接当作结果。
         选择题如果一条都没匹配上，bestAnswer 必须保持为空，否则会被误当成
         「有答案」，覆盖掉本来正确的题库结果，最后在页面上报「无法定位选项」。 */
      var seen = {};
      outTexts = textsArr.filter(function (x) { return seen[x] ? false : (seen[x] = 1); });
    }

    answerKey = uniq(answerKey).sort();
    answerIndex = uniq(answerIndex).sort(function (a, b3) { return a - b3; });

    return {
      plat: req.plat || 0,
      question: question,
      options: options,
      type: qtype,
      answer: {
        answerKey: answerKey,
        answerKeyText: answerKey.join(''),
        answerIndex: answerIndex,
        answerText: outTexts.join('#'),
        bestAnswer: outTexts.length ? outTexts : answerKey,
        allAnswer: outTexts.length ? [outTexts] : []
      }
    };
  }

  function uniq(a) {
    var seen = {}, out = [];
    for (var i = 0; i < a.length; i++) if (!seen[a[i]]) { seen[a[i]] = 1; out.push(a[i]); }
    return out;
  }

  /* ------------------------------------------------------------ 数据源：百度 */

  var BAIDU_URL = 'https://easylearn.baidu.com/edu-web-go/bgk/searchlist';

  function baiduRequest(question) {
    return {
      url: BAIDU_URL + '?query=' + encodeURIComponent(question) + '&rn=10&pn=0',
      method: 'GET',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    };
  }

  function parseBaidu(question, bodyText, log) {
    var data;
    try { data = JSON.parse(bodyText); } catch (e) {
      if (log) log('百度返回的不是 JSON：' + String(bodyText).slice(0, 120));
      return { texts: [], letters: [] };
    }
    var list = dig(data, 'data', 'list') || [];
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      if (!item.bdjson || !item.actk) continue;
      var obj;
      try { obj = JSON.parse(decrypt(item.bdjson, item.actk)); } catch (e2) { continue; }
      var pc = parseCandidate(obj);
      if (!pc.stem || (!pc.texts.length && !pc.letters.length)) continue;
      var score = ratio(question, pc.stem);
      if (score < SIM_THRESHOLD) continue;
      if (best === null || score > best.score) best = { score: score, texts: pc.texts, letters: pc.letters };
      if (score >= 0.999) break;
    }
    if (!best) return { texts: [], letters: [] };
    if (log) log('百度命中，相似度 ' + best.score.toFixed(3));
    return { texts: best.texts, letters: best.letters };
  }

  /* ---------------------------------------------------------- 数据源：GO题 */

  var ICOD_EF_URL = 'https://q.icodef.com/wyn-nb?v=4';
  var ICOD_EF_THROTTLE = ['流控限制', '速度太快', '并发限制', '忙不过来'];

  function icodefRequest(question) {
    return {
      url: ICOD_EF_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': ''
      },
      body: 'question=' + encodeURIComponent(question)
    };
  }

  function parseIcodef(bodyText, log) {
    var j;
    try { j = JSON.parse(bodyText); } catch (e) {
      if (log) log('GO题返回的不是 JSON：' + String(bodyText).slice(0, 120));
      return { texts: [], letters: [], throttled: false };
    }
    var code = parseInt(String(j.code == null ? '' : j.code).trim(), 10);
    if (isNaN(code)) code = 0;
    var answer = String(j.data == null ? '' : j.data).trim();
    var msg = String(j.msg == null ? '' : j.msg).trim();
    var raw = answer + ' ' + msg;
    var throttled = ICOD_EF_THROTTLE.some(function (k) { return raw.indexOf(k) >= 0; });
    // GO题库搜不到时会返回「李恒雅正在努力撰写中…」这种占位文案
    if (code !== 1 || !answer || answer.indexOf('李恒雅') >= 0 || msg.indexOf('李恒雅') >= 0) {
      if (log && throttled) log('GO题触发流控');
      return { texts: [], letters: [], throttled: throttled };
    }
    var parts = answer.split('#').map(function (x) { return x.trim(); }).filter(Boolean);
    var textsOut = [], lettersOut = [];
    for (var i = 0; i < parts.length; i++) {
      if (LETTERS.test(parts[i])) {
        var m = parts[i].toUpperCase().match(/[A-Za-z]/g) || [];
        for (var k = 0; k < m.length; k++) lettersOut.push(m[k]);
      } else {
        textsOut.push(parts[i]);
      }
    }
    return { texts: textsOut, letters: lettersOut, throttled: false };
  }

  /* ------------------------------------------------------------ DeepSeek AI 兜底 */

  // 桥的地址。改了启动器的 PORT 就要改这里（一般不用动）。
  var BRIDGE_URL = 'http://127.0.0.1:8060';

  // 为什么 AI 要绕一趟本地桥、而不是浏览器直接打 api.deepseek.com：
  //   API Key 存在电脑上的 ai_config.json 里，浏览器里没有密钥，
  //   也就不怕被页面上别的脚本（同一份登录态里还装着三个）顺手拿走。
  function aiRequest(question, options, qtype, images, optionLetters) {
    var body = {
      question: question,
      options: options || [],
      type: normType(qtype)
    };
    /* 只有图片公式题才带图：普通题仍然走纯文本，少传几 MB base64。
       images 的每一项由 main.js 从页面图片整理成
       { url, where, label }，桥负责下载并转成 data URL。
       optionLetters 保留卷面真实字母（可能不是从 A 连续排），
       视觉模型直接回字母时才能点对选项。 */
    if (images && images.length) body.images = images;
    if (optionLetters && optionLetters.length) body.optionLetters = optionLetters;
    return {
      url: BRIDGE_URL + '/ai/ask',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 120000
    };
  }

  function parseAi(bodyText, log) {
    var j;
    try { j = JSON.parse(bodyText); } catch (e) {
      if (log) log('AI 返回的不是 JSON：' + String(bodyText).slice(0, 120));
      return { texts: [], letters: [], throttled: false };
    }
    if (!j || j.ok !== true) {
      var why = (j && j.error) ? j.error : '未知原因';
      if (log) log('AI 没给出答案：' + why);
      return { texts: [], letters: [], throttled: false, error: why };
    }
    var arr = (j.answers || []).map(function (x) { return String(x).trim(); })
                              .filter(function (x) { return !!x; });
    /* 视觉接口对纯图片选项会让模型直接回「A / B」，桥会额外给 letters。
       单独返回 letters，buildResponse 才能按卷面字母定位，不会拿
       「［图］」这种占位文本去和所有选项乱比。 */
    var lets = (j.letters || []).map(function (x) { return String(x).trim().toUpperCase(); })
                                 .filter(function (x) { return /^[A-Z]$/.test(x); });
    return { texts: arr, letters: lets, throttled: false };
  }

  /* ------------------------------------------------------------ 检索调度 */

  function makeSearcher(opts) {
    opts = opts || {};
    var transport = opts.transport;        // (reqOpts) => Promise<string>  必需
    // 百度教育实测 3/3 命中且基本不限流，放第一位；GO题(icodef) 覆盖面更全但极易流控，作兜底。
    var sources = opts.sources || ['baidu', 'icodef'];
    var log = opts.log || function () {};
    var cache = opts.cache || {};
    var verifyAi = !!opts.verifyAi;   // 题库命中了也再问一次 AI，两边不一致就按 AI 的填
    var minInterval = opts.minInterval == null ? 400 : opts.minInterval;
    var maxRetries = opts.maxRetries == null ? 3 : opts.maxRetries;  // 遇流控时的退避重试次数
    var backoff = opts.backoff == null ? 1500 : opts.backoff;        // 退避基数（ms）
    var flags = { throttled: false };
    var lastMiss = [];
    var lastReq = 0;
    var queue = Promise.resolve();

    function cacheKey(question, options, qtype) {
      var parts = [norm(question), qtype];
      for (var i = 0; i < options.length; i++) parts.push(bare(options[i]));
      return parts.join('|');
    }

    function throttle() {
      if (!minInterval) return Promise.resolve();
      queue = queue.then(function () {
        var wait = minInterval - (Date.now() - lastReq);
        lastReq = Date.now() + Math.max(0, wait);
        return wait > 0 ? new Promise(function (r) { setTimeout(r, wait); }) : null;
      });
      return queue;
    }

    function callSource(name, question, options, qtype) {
      if (name === 'ai') {
        return throttle()
          .then(function () { return transport(aiRequest(question, options, qtype)); })
          .then(function (body) { return parseAi(body, log); })
          .catch(function (e) {
            log('AI 请求失败：' + (e && e.message ? e.message : e));
            return { texts: [], letters: [], error: String(e) };
          });
      }
      var reqOpts = name === 'baidu' ? baiduRequest(question) : icodefRequest(question);
      return throttle()
        .then(function () { return transport(reqOpts); })
        .then(function (body) {
          return name === 'baidu' ? parseBaidu(question, body, log) : parseIcodef(body, log);
        })
        .catch(function (e) {
          log(name + ' 请求失败：' + (e && e.message ? e.message : e));
          return { texts: [], letters: [], error: String(e) };
        });
    }

    /* 带退避重试的取源：GO题返回「触发流控限制」时等一会儿再问，往往第二次就有答案 */
    function callSourceRetry(name, question, attempt, options, qtype) {
      return callSource(name, question, options, qtype).then(function (res) {
        if (res.throttled && attempt < maxRetries) {
          var wait = backoff * (attempt + 1);
          log(name + ' 触发流控，' + wait + 'ms 后重试（' + (attempt + 1) + '/' + maxRetries + '）');
          return new Promise(function (r) { setTimeout(r, wait); })
            .then(function () { return callSourceRetry(name, question, attempt + 1, options, qtype); });
        }
        return res;
      });
    }

    /* 题库命中了不代表对：百度经常把「别的课里长得像的那道题」匹配进来。
       实测「振幅变两倍、总能量变几倍」那道题，百度给「四分之一」，AI 给「四倍」，
       正确答案是四倍。所以命中之后再问一次 AI，不一致就按 AI 填。
       AI 没答上来就沿用题库的，不冒额外风险。 */
    function crossCheck(question, options, qtype, resp, fromName) {
      if (!verifyAi || fromName === 'ai') return Promise.resolve(resp);
      return callSource('ai', question, options, qtype).then(function (res) {
        var ai = buildResponse({ question: question, options: options, type: qtype },
                               res.texts, res.letters);
        /* 只有 AI 真的落到了某个选项上才允许覆盖题库。
           以前只检查 bestAnswer 非空；AI 返回一段和卷面选项完全对不上的
           文字时也算「有答案」，会把题库原本正确的字母冲掉，页面最后
           报「无法定位选项」—— 用户看到的「知道答案却没选上」。 */
        if (!ai.answer.answerKey.length && !ai.answer.answerIndex.length) {
          log('AI 校验：没给出答案（没落到具体选项），沿用' + fromName + '的。');
          return resp;
        }
        var a0 = resp.answer.answerKey.join('');
        var a1 = ai.answer.answerKey.join('');
        if (a0 && a1 && a0 === a1) { log('AI 校验：和' + fromName + '一致。'); return resp; }
        if (!a0) {
          var b0 = resp.answer.bestAnswer.slice().sort().join('\u0001');
          var b1 = ai.answer.bestAnswer.slice().sort().join('\u0001');
          if (b0 && b0 === b1) { log('AI 校验：和' + fromName + '一致。'); return resp; }
        }
        ai.source = 'ai';
        ai.note = fromName + ' 说「' + resp.answer.bestAnswer.join(' / ') +
                  '」，AI 说「' + ai.answer.bestAnswer.join(' / ') + '」，按 AI 的填';
        log('⚠ AI 和' + fromName + '不一致 -> 采用 AI：' + fromName + '=' +
            resp.answer.bestAnswer.join('/') + '，AI=' + ai.answer.bestAnswer.join('/'));
        return ai;
      }).catch(function (e) {
        log('AI 校验失败（沿用' + fromName + '的）：' + (e && e.message ? e.message : e));
        return resp;
      });
    }

    /* 单题查询：命中即返回完整响应对象，全源未命中返回 null */
    function queryOnce(req) {
      var question = normQuestion(req);
      var options = normOptions(req.options);
      var qtype = normType(req.type);
      if (!question) return Promise.resolve(null);
      var key = cacheKey(question, options, qtype);
      if (cache[key]) {
        var hit = JSON.parse(JSON.stringify(cache[key]));
        hit.fromCache = true;
        return Promise.resolve(hit);
      }
      var i = 0, lastThrottled = false;
      lastMiss = [];
      // 记下每个数据源为什么没成 —— 面板上直接显示，不然用户只看到「没搜到答案」没法判断
      function note(name, res) {
        var why;
        if (res.throttled) why = '限流';
        else if (res.error) why = String(res.error).slice(0, 60);
        else if (res.texts && res.texts.length) why = res.texts.length + ' 条候选但和选项对不上';
        else why = '没返回候选';
        lastMiss.push(name + '：' + why);
      }
      function next() {
        if (i >= sources.length) {
          if (lastThrottled) { flags.throttled = true; log('全部数据源触发流控'); }
          return Promise.resolve(null);
        }
        var name = sources[i++];
        return callSourceRetry(name, question, 0, options, qtype).then(function (res) {
          if (res.throttled) { lastThrottled = true; note(name, res); return next(); }
          var resp = buildResponse({ question: question, options: options, type: qtype },
                                   res.texts, res.letters);
          if (!resp.answer.bestAnswer.length) { note(name, res); return next(); }
          resp.source = name;
          return crossCheck(question, options, qtype, resp, name).then(function (final) {
            var copy = JSON.parse(JSON.stringify(final));
            delete copy.fromCache;          // 缓存里存的必须是「原始结果」，不能带这个标记
            cache[key] = copy;
            if (opts.onCache) opts.onCache(key, final);
            return final;
          });
        });
      }
      return next();
    }

    /* 批量查询：返回与入参等长的数组，未命中的位置是 null。串行以保证不漏题不错位。 */
    function queryAll(list) {
      var out = new Array(list.length);
      var chain = Promise.resolve();
      list.forEach(function (req, idx) {
        chain = chain.then(function () {
          return queryOnce(req).then(function (r) { out[idx] = r; });
        });
      });
      return chain.then(function () { return out; });
    }

    return {
      queryOnce: queryOnce,
      queryAll: queryAll,
      cacheKey: cacheKey,
      flags: flags,
      miss: function () { return lastMiss.slice(); },
      _cache: cache
    };
  }

  return {
    // 归一化
    nfkc: nfkc, norm: norm, bare: bare, ratio: ratio, judgeBool: judgeBool,
    normType: normType, normOptions: normOptions, normQuestion: normQuestion,
    answerVariants: answerVariants,
    // 解密 / 解析
    decrypt: decrypt, texts: texts, yesOptions: yesOptions, parseCandidate: parseCandidate,
    parseBaidu: parseBaidu, parseIcodef: parseIcodef,
    baiduRequest: baiduRequest, icodefRequest: icodefRequest,
    aiRequest: aiRequest, parseAi: parseAi, BRIDGE_URL: BRIDGE_URL,
    // 组装
    buildResponse: buildResponse,
    // 调度
    makeSearcher: makeSearcher,
    // 常量（测试用）
    _const: { XOR_SEED: XOR_SEED, SIM_THRESHOLD: SIM_THRESHOLD, TYPE_MAP: TYPE_MAP }
  };
});

/* ======================== panel.js ======================== */
/* ============================================================================
 *  panel.js —— 悬浮控制面板（纯原生 DOM，不依赖 jQuery / 不注入页面上下文）
 *  v1.3.0：换深蓝玻璃拟态皮肤（DeepSeek 配色：蓝鲸 + 靛蓝→青蓝渐变）
 * ==========================================================================*/
(function (root) {
  'use strict';

  /* 面板宽 352px。所有选择器都带 #ftk- 前缀，避免和页面样式打架。 */
  var CSS = [
    '#ftk-panel{position:fixed;right:16px;bottom:16px;width:352px;z-index:2147483000;',
    'max-width:calc(100vw - 24px);max-width:calc(100dvw - 24px);',
    /* 面板比屏幕还高时，标题栏会被顶出可视区，用户就「抓不到、拖不动」。
       限制最大高度，标题栏永远留在屏幕里；放不下的内容由 #ftk-body 自己滚动。 */
    'display:flex;flex-direction:column;max-height:calc(100vh - 32px);max-height:calc(100dvh - 32px);',
    'font:13px/1.6 "Microsoft YaHei",system-ui,-apple-system,sans-serif;color:#E8ECFF;',
    'background:linear-gradient(158deg,#151D36 0%,#0D1327 52%,#0A0E1C 100%);',
    'border:1px solid rgba(93,135,255,.30);border-radius:16px;overflow:hidden;user-select:none;',
    'box-shadow:0 18px 52px rgba(3,8,25,.66),0 0 0 1px rgba(0,0,0,.30) inset,0 0 38px rgba(77,107,254,.16);',
    '-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);transition:border-color .3s,box-shadow .3s}',
    /* 顶部那层蓝色辉光，只是装饰 */
    '#ftk-panel:before{content:"";position:absolute;left:-12%;top:-90px;width:124%;height:180px;pointer-events:none;',
    'background:radial-gradient(58% 100% at 22% 100%,rgba(77,107,254,.34),rgba(0,194,255,.10) 55%,transparent 72%)}',
    /* 运行中：边框和辉光变青，一眼能看出「在干活」 */
    '#ftk-panel.ftk-on{border-color:rgba(0,194,255,.52);',
    'box-shadow:0 18px 52px rgba(3,8,25,.64),0 0 0 1px rgba(0,194,255,.14) inset,0 0 46px rgba(0,194,255,.30)}',
    '#ftk-panel.ftk-collapsed #ftk-body{display:none}',
    '#ftk-head{position:relative;display:flex;align-items:center;gap:9px;padding:10px 12px;cursor:move;',
    'flex:none;touch-action:none;-ms-touch-action:none;',
    'background:linear-gradient(90deg,rgba(77,107,254,.20),rgba(0,194,255,.06) 62%,rgba(0,0,0,0));',
    'border-bottom:1px solid rgba(93,135,255,.18)}',
    '.ftk-whale{width:27px;height:19px;flex:none;filter:drop-shadow(0 0 7px rgba(90,140,255,.7))}',
    '.ftk-title{flex:1;min-width:0}',
    '.ftk-title b{display:block;font-size:13px;font-weight:700;letter-spacing:.5px;color:#EDF2FF;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ftk-title b .ftk-ver{font-size:10px;font-weight:600;letter-spacing:.2px;color:#8FB2FF;margin-left:4px}',
    '.ftk-title span{display:block;font-size:10px;line-height:1.2;letter-spacing:.6px;color:#7C8CBB}',
    '#ftk-head .ftk-grip{flex:none;padding:0 2px;color:#6E80B2;font-size:14px;line-height:1;',
    'letter-spacing:-1px;cursor:move;user-select:none}',
    '#ftk-head .ftk-min{cursor:pointer;padding:0 5px;color:#8C9CCB;font-weight:700;font-size:14px;line-height:1}',
    '#ftk-head .ftk-min:hover{color:#DCE6FF}',
    '#ftk-body{position:relative;padding:11px 12px 12px;flex:1 1 auto;min-height:0;',
    'overflow-y:auto;overscroll-behavior:contain}',
    '#ftk-status{padding:7px 9px;border-radius:10px;background:rgba(7,11,24,.78);',
    'border:1px solid rgba(93,135,255,.16);margin-bottom:8px;white-space:pre-wrap;word-break:break-all;',
    'color:#C6D3FF;font-size:12px}',
    '#ftk-bar{height:7px;background:rgba(7,11,24,.85);border-radius:99px;overflow:hidden;margin-bottom:9px;',
    'box-shadow:0 0 0 1px rgba(93,135,255,.12) inset}',
    '#ftk-bar>i{display:block;height:100%;width:0;border-radius:99px;',
    'background:linear-gradient(90deg,#4D6BFE,#00D2FF);box-shadow:0 0 12px rgba(0,194,255,.75);',
    'transition:width .3s ease}',
    '#ftk-btns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-bottom:9px}',
    '#ftk-btns button{padding:8px 10px;border-radius:10px;cursor:pointer;font-family:inherit;',
    'border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.05);color:#DBE4FF;font-size:12px;font-weight:600;',
    'letter-spacing:.2px;transition:background .18s,transform .12s,box-shadow .2s}',
    '#ftk-btns button:hover:not(:disabled){background:rgba(255,255,255,.10);transform:translateY(-1px)}',
    '#ftk-btns button:active:not(:disabled){transform:translateY(0)}',
    '#ftk-btns button:disabled{opacity:.45;cursor:not-allowed}',
    /* 主键：跨两列的大胶囊，靛蓝→青蓝渐变 */
    '#ftk-btns button.ftk-primary{grid-column:1/3;padding:11px;font-size:13px;border:none;color:#fff;',
    'background:linear-gradient(135deg,#4D6BFE 0%,#3A8BFF 55%,#00C2FF 100%);',
    'box-shadow:0 8px 24px rgba(77,107,254,.44)}',
    '#ftk-btns button.ftk-primary:hover:not(:disabled){background:linear-gradient(135deg,#5A76FF,#31C7FF);',
    'box-shadow:0 10px 30px rgba(77,107,254,.58)}',
    /* 运行中：同一个键切成红色渐变 */
    '#ftk-btns button.ftk-primary.ftk-stopbtn{background:linear-gradient(135deg,#FF4D6D 0%,#FF6F5E 60%,#FF9B52 100%);',
    'box-shadow:0 8px 24px rgba(255,77,109,.42)}',
    '#ftk-btns button.ftk-primary.ftk-stopbtn:hover:not(:disabled){background:linear-gradient(135deg,#FF5E7C,#FF8A63);',
    'box-shadow:0 10px 30px rgba(255,77,109,.56)}',
    '#ftk-btns button.ftk-danger{border-color:rgba(255,120,140,.30);color:#FFC7D2}',
    '#ftk-opts{display:grid;grid-template-columns:1fr 1fr;gap:5px 10px;margin-bottom:9px;font-size:12px}',
    '#ftk-opts label{display:flex;align-items:center;gap:6px;cursor:pointer;color:#AEBBE3}',
    '#ftk-opts input[type=checkbox]{-webkit-appearance:none;appearance:none;width:14px;height:14px;flex:none;',
    'margin:0;border-radius:4px;border:1px solid rgba(140,165,255,.45);background:rgba(255,255,255,.04);',
    'position:relative;cursor:pointer;transition:background .15s,border-color .15s}',
    '#ftk-opts input[type=checkbox]:checked{background:linear-gradient(135deg,#4D6BFE,#00C2FF);border-color:#4D6BFE}',
    '#ftk-opts input[type=checkbox]:checked:after{content:"\\2713";position:absolute;left:2px;top:-2px;',
    'font-size:11px;line-height:1.4;color:#fff}',
    '#ftk-opts input[type=number]{width:46px;background:rgba(7,11,24,.9);color:#EAF0FF;',
    'border:1px solid rgba(140,165,255,.35);border-radius:6px;padding:1px 4px;font-size:11px;font-family:inherit}',
    '#ftk-opts label.ftk-pipe{grid-column:1/3;font-weight:600}',
    '#ftk-opts label.ftk-pipe:first-of-type{color:#9FB4FF}',
    '#ftk-log{height:168px;overflow-y:auto;overscroll-behavior:contain;',
    'background:rgba(5,8,19,.9);border:1px solid rgba(93,135,255,.14);',
    'border-radius:10px;padding:8px 9px;font:12px/1.55 Consolas,Menlo,monospace;user-select:text;color:#A9B7DC}',
    '#ftk-log div{margin-bottom:4px;word-break:break-all}',
    '#ftk-log .ok{color:#3DDC97}#ftk-log .warn{color:#FFC24B}',
    '#ftk-log .err{color:#FF6B87}#ftk-log .dim{color:#6E7CA6}',
    '#ftk-log::-webkit-scrollbar{width:6px}',
    '#ftk-log::-webkit-scrollbar-thumb{background:rgba(93,135,255,.35);border-radius:99px}',
    '#ftk-panel.ftk-dragging{user-select:none}',
    '#ftk-head{cursor:move}'
  ].join('');

  /* DeepSeek 那种蓝鲸：圆身子 + 上翘尾鳍 + 头顶水花。
     纯 SVG，不引外部资源，套在篡改猴里也不会被 CSP 拦。 */
  var WHALE =
    '<svg class="ftk-whale" viewBox="0 0 64 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<defs><linearGradient id="ftkWg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#8FB2FF"/><stop offset=".55" stop-color="#5A7BFF"/>' +
    '<stop offset="1" stop-color="#00D2FF"/></linearGradient></defs>' +
    '<path fill="url(#ftkWg)" d="M5 25c0-7.4 7.4-12.8 17-12.8 6.6 0 11.7 2.3 14.7 5.6l8.6-7.2-1.7 9.2 7.4 8.4-10.4-2.6C37.7 31 30.9 34 23 34 11.6 34 5 31.2 5 25z"/>' +
    '<path fill="rgba(255,255,255,.42)" d="M9.4 27.4c3.6 3.1 9.5 4.4 15.4 4.1 4.8-.2 9-1.6 12-4 1.4 1.6.2 3.4-2.4 4.6-3.6 1.7-8.4 2.6-13.2 2.4-5.9-.3-10.6-2.2-11.8-4.7-.5-1 0-1.8 0-2.4z"/>' +
    '<circle cx="19.5" cy="22" r="2.4" fill="#080C18"/>' +
    '<circle cx="20.4" cy="21.2" r=".8" fill="#BFD4FF"/>' +
    '<path d="M15.2 11.6c1.2-3.6 3.9-5.6 7.4-5.9" stroke="#8FB2FF" stroke-width="2.4" stroke-linecap="round" fill="none" opacity=".9"/>' +
    '<circle cx="12.6" cy="7.4" r="1.6" fill="#00D2FF" opacity=".85"/>' +
    '<circle cx="20.6" cy="4.2" r="1.2" fill="#8FB2FF" opacity=".75"/>' +
    '</svg>';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function create(opts) {
    opts = opts || {};
    var settings = opts.settings || {};
    var ver = '';
    try {
      ver = root.__ftkVersion ||
        (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '';
    } catch (eVer) { ver = ''; }
    /* 面板实现的是「建它的那一份文档」。
       为什么要抓一份：题目框里的代码也会来调 panel.log()，
       如果 log 里读全局 document，就会把日志 div 造到题目框的文档里去。 */
    var doc = opts.doc || document;
    /* 面板 DOM 可能挂到外层文档，但按钮/拖动回调仍属于「创建它的那一层」。
       那一层 iframe 一旦交卷/翻页被销毁，DOM 还在、监听器却成了僵尸：
       用户看到面板能显示，但停止/拖动/所有按钮都点不动。这里把创建者记下来，
       新页面复用前先验活，死了就换新面板。 */
    var ownerWin = root;
    var ownerDoc = null;
    var ownerFrame = null;
    try { ownerDoc = root.document; } catch (e00) { ownerDoc = null; }
    try { ownerFrame = root.frameElement || null; } catch (e01) { ownerFrame = null; }

    var style = doc.createElement('style');
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);

    var box = doc.createElement('div');
    box.id = 'ftk-panel';
    box.innerHTML =
      '<div id="ftk-head">' + WHALE +
      '<div class="ftk-title"><b>学习通 · 免费题库' +
        (ver ? '<span class="ftk-ver">v' + esc(ver) + '</span>' : '') +
      '</b><span>FREE TIKU · 答题 / 刷课</span></div>' +
      '<span class="ftk-grip" title="按住这里拖动面板">\u22ee\u22ee</span>' +
      '<span class="ftk-min" title="折叠/展开">－</span></div>' +
      '<div id="ftk-body">' +
      '  <div id="ftk-status">待命中</div>' +
      '  <div id="ftk-bar"><i></i></div>' +
      '  <div id="ftk-btns">' +
      '    <button id="ftk-run" class="ftk-primary" title="一键开关：按住它就开始做题/刷视频，再点一下全部停下">\u25b6 一键启动</button>' +
      '    <button id="ftk-stop" style="display:none" title="（内部用，界面上由左边那个键代替）">停止</button>' +
      '    <button id="ftk-submit" class="ftk-danger" title="点击页面上的交卷按钮，请自行确认">交卷</button>' +
      '    <button id="ftk-clear">清屏</button>' +
      '    <button id="ftk-diag" title="只读：把这一页有哪些章节/任务点列出来，不点任何东西">诊断</button>' +
      '    <button id="ftk-rework" title="这一页已经批改过时，帮你点页面上的「重做」">重做</button>' +
      '    <button id="ftk-reset" title="清掉流水线「已试过」的记录和轮数，让它重新找下一个">重置</button>' +
      '  </div>' +
      '  <div id="ftk-opts">' +
      '    <label class="ftk-pipe"><input type="checkbox" id="ftk-pipe" title="自动开答 + 自动交卷 + 自动点下一个任务点。章节测验和视频都会做，不碰考试"> 流水线模式（自动跑完整章）</label>' +
      '    <label class="ftk-pipe" title="启动后，遇到视频/音频任务点就自动播放、自动倍速，满了自动点下一节"><input type="checkbox" id="ftk-video"> 自动播放视频</label>' +
      '    <label><input type="checkbox" id="ftk-auto"> 答完自动交卷</label>' +
      '    <label><input type="checkbox" id="ftk-guess"> 查不到就蒙一个</label>' +
      '    <label><input type="checkbox" id="ftk-overwrite"> 覆盖已填答案</label>' +
      '    <label><input type="checkbox" id="ftk-baidu"> 启用百度源</label>' +
      '    <label><input type="checkbox" id="ftk-icodef"> 启用 GO 题源</label>' +
      '    <label><input type="checkbox" id="ftk-ai" title="百度/GO题都搜不到时问 AI，会消耗你的 DeepSeek 余额"> 启用 AI 兜底</label>' +
      '    <label title="题库命中了也再问一次 AI；两边不一致就按 AI 的填。能挡住「题库匹配到别的课里的相似题」导致的错答案，代价是每题多花一两秒"> <input type="checkbox" id="ftk-verifyai"> AI 校验答案</label>' +
      '    <label><input type="checkbox" id="ftk-logdetail"> 详细日志</label>' +
      '    <label title="命中率到这个数才自动交卷，否则只填不交">交卷门槛 <input type="number" id="ftk-minhit" min="0" max="100" step="5"> %</label>' +
      '    <label title="学习通默认封顶 2x；超过 2x 属于强改，提太猛有可能被服务器按「观看时长不足」打回">视频倍速 <input type="number" id="ftk-rate" min="0.5" max="16" step="0.5"> x</label>' +
      '    <label title="视频任务点连续这么多次没有进展，就当作播放器卡住了、先放行往下翻。注意这不是「视频没播完」，只是防止卡死">视频卡住放行 <input type="number" id="ftk-mediawait" min="1" max="60" step="1"> 次</label>' +
      '  </div>' +
      '  <div id="ftk-log"></div>' +
      '</div>';
    doc.body.appendChild(box);

    var $ = function (id) { return box.querySelector('#' + id); };
    var elLog = $('ftk-log'), elStatus = $('ftk-status'), elBar = $('ftk-bar').firstChild;

    /* ---- 折叠 ---- */
    var collapsed = false;
    var refit = function () { };   // 由下面的拖动逻辑接管：重新限制高度并把面板夹回屏幕
    $('ftk-head').querySelector('.ftk-min').addEventListener('click', function () {
      collapsed = !collapsed;
      box.classList.toggle('ftk-collapsed', collapsed);
      this.textContent = collapsed ? '＋' : '－';
      refit();
    });

    /* ---- 拖动 ---- */
    (function () {
      var POS_KEY = 'ftk_pos_v1';
      /* 面板真正所在的那份文档/窗口。子框架把面板建到外层文档时，
         鼠标事件只会出现在外层，挂在子框架上是收不到的。 */
      function pdoc() { return box.ownerDocument || doc; }
      function pw() {
        var d = pdoc();
        return d.defaultView || d.parentWindow || null;
      }
      function viewport() {
        var w = pw();
        return {
          w: w,
          W: (w && w.innerWidth) || 1000,
          H: (w && w.innerHeight) || 700
        };
      }
      function fitHeight() {
        var v = viewport();
        /* 面板比屏幕还高时，标题栏会被顶到屏幕外面 —— 看上去就是「拖不动」。
           给上下各留 16px，剩下的高度让 #ftk-body 自己滚。 */
        box.style.maxHeight = Math.max(160, v.H - 32) + 'px';
      }
      function place(l, t) {
        box.style.right = 'auto'; box.style.bottom = 'auto';
        box.style.left = l + 'px'; box.style.top = t + 'px';
      }
      function clampX(x) {
        var v = viewport(), W = v.W;
        var bw = box.offsetWidth || 300;   /* 与 CSS 的 min-width 对齐；linkedom 里 offsetWidth 恒为 0 */
        return Math.max(-(bw - 60), Math.min(W - 60, x));
      }
      function clampY(y) {
        var v = viewport(), H = v.H;
        /* 只要保证标题栏 + 一小段内容还露在屏幕里，就允许往下拖。
           旧逻辑用「整个面板都留在屏幕内」算 maxTop：面板最高能到 H-32，
           maxTop 就只剩 24px，小窗口里纵向几乎拖不动（用户说的
           「拖小窗口不移动」）。现在至少留 120px（面板更矮就全留），
           既解决拖不动，也不会把面板拖到只剩一条标题栏、下次打开像消失。 */
        var bh = box.offsetHeight || 0;
        var keep = bh > 0 ? Math.min(bh, 120) : 34;
        return Math.max(0, Math.min(Math.max(0, H - keep - 8), y));
      }
      function loadPos() {
        try {
          var w = pw();
          var s = (w && w.localStorage) ? w.localStorage.getItem(POS_KEY) : null;
          if (!s) return null;
          var o = JSON.parse(s);
          if (!o || typeof o.left !== 'number' || typeof o.top !== 'number') return null;
          return o;
        } catch (e) { return null; }
      }
      function savePos() {
        try {
          var w = pw();
          if (!w || !w.localStorage) return;
          var l = parseFloat(box.style.left), t = parseFloat(box.style.top);
          if (isNaN(l) || isNaN(t)) return;
          w.localStorage.setItem(POS_KEY, JSON.stringify({ left: l, top: t }));
        } catch (e) { /* 隐私模式 / 被站点禁用，算了 */ }
      }
      function ensureInView() {
        var l = parseFloat(box.style.left), t = parseFloat(box.style.top);
        if (isNaN(l) || isNaN(t)) return;
        place(clampX(l), clampY(t));
      }

      refit = function () {
        fitHeight();
        ensureInView();
      };
      fitHeight();

      /* 上次拖到哪儿就还放哪儿：换章节时面板会被重建，
         每次都弹回右下角，用户就会觉得「拖不动 / 被钉死了」。 */
      var saved = loadPos();
      if (saved) place(clampX(saved.left), clampY(saved.top));

      var drag = null, capId = null;
      /* 按钮、勾选框、输入框、日志区不许当拖动手柄（点了要能用） */
      var SKIP = 'button,input,select,textarea,a,label,#ftk-log,.ftk-min';

      function onDown(e) {
        if (drag) return;
        if (e.button != null && e.button !== 0) return;
        if (e.isPrimary === false) return;          // 多指触摸只认第一根手指
        var t = e.target;
        try { if (t && t.closest && t.closest(SKIP)) return; } catch (e0) { }
        var r = box.getBoundingClientRect();
        drag = {
          id: (e.pointerId == null ? null : e.pointerId),
          x: e.clientX, y: e.clientY, left: r.left, top: r.top
        };
        place(clampX(r.left), clampY(r.top));
        try { box.classList.add('ftk-dragging'); } catch (e1) { }
        /* 关键：把指针捕获到面板上。
           学习通的内容区通常是一整层 iframe，鼠标一拖进 iframe，
           外层 document 就收不到 mousemove 了；setPointerCapture
           会把后续的 pointermove / pointerup 继续送回面板，拖动不会断。 */
        if (drag.id != null && box.setPointerCapture) {
          try { box.setPointerCapture(drag.id); capId = drag.id; } catch (e2) { capId = null; }
        }
        if (e.preventDefault) e.preventDefault();
      }
      function onMove(e) {
        if (!drag) return;
        if (drag.id != null && e.pointerId != null && e.pointerId !== drag.id) return;
        place(clampX(drag.left + (e.clientX - drag.x)),
              clampY(drag.top + (e.clientY - drag.y)));
        if (e.preventDefault) e.preventDefault();
      }
      function onUp(e) {
        if (!drag) return;
        if (drag.id != null && e.pointerId != null && e.pointerId !== drag.id) return;
        if (capId != null && box.releasePointerCapture) {
          try { box.releasePointerCapture(capId); } catch (e3) { /* ... */ }
        }
        capId = null;
        drag = null;
        try { box.classList.remove('ftk-dragging'); } catch (e2) { }
        savePos();
      }

      box.addEventListener('mousedown', onDown);
      box.addEventListener('pointerdown', onDown);
      /* 指针捕获后事件的目标是面板自己，所以这组监听必须有 */
      box.addEventListener('pointermove', onMove);
      box.addEventListener('pointerup', onUp);
      box.addEventListener('pointercancel', onUp);
      box.addEventListener('lostpointercapture', onUp);

      var d = pdoc();
      /* capture=true：页面自己的脚本 stopPropagation 也拦不住我们的拖动 */
      d.addEventListener('mousemove', onMove, true);
      d.addEventListener('mouseup', onUp, true);
      d.addEventListener('pointermove', onMove, true);
      d.addEventListener('pointerup', onUp, true);
      d.addEventListener('pointercancel', onUp, true);

      var w = pw();
      if (w) {
        try {
          if (w !== d) {
            w.addEventListener('mousemove', onMove, true);
            w.addEventListener('mouseup', onUp, true);
            w.addEventListener('pointermove', onMove, true);
            w.addEventListener('pointerup', onUp, true);
          }
          /* 浏览器窗口变小 / 放大页面后，把面板重新夹回可视区 */
          w.addEventListener('resize', function () { refit(); });
          /* 切标签页 / 窗口失焦时清掉拖动状态，
             免得回来时鼠标没按键、面板却还跟着跑 */
          w.addEventListener('blur', onUp);
        } catch (e3) { /* 老环境没有这些，鼠标那套已经够了 */ }
      }
    })();

    /* ---- 日志 ---- */
    var logCount = 0;
    function log(msg, kind) {
      var d = doc.createElement('div');
      if (kind) d.className = kind;
      d.innerHTML = esc(msg);
      elLog.appendChild(d);
      logCount++;
      while (elLog.childNodes.length > 400) elLog.removeChild(elLog.firstChild);
      elLog.scrollTop = elLog.scrollHeight;
      return d;
    }
    function detail(msg) { if (settings.logDetail) log(msg, 'dim'); }
    function clear() { elLog.innerHTML = ''; logCount = 0; }

    /* ---- 状态 / 进度 ---- */
    function status(t) { elStatus.textContent = t; }
    function progress(done, total, hit) {
      elBar.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
      if (total) status('已处理 ' + done + '/' + total + '　命中 ' + hit + '　未命中 ' + (done - hit));
    }
    var isOn = false;                 // 真实开关状态：按钮语义只认它，不认按钮上的字
    function running(on) {
      isOn = !!on;
      /* 两个按钮都永远可点：
         「停止」在空闲时按下去也要有回执（它同时是「暂停流水线」的总开关），
         否则用户只会看到一块灰掉的死键，以为脚本坏了。
         「一键启动」也不敢再禁用 —— 一旦 running 卡住就永久点不动了。 */
      var btn = $('ftk-run');
      if (!btn) return;
      btn.disabled = false;
      btn.textContent = on ? '\u25a0 全部停止' : '\u25b6 一键启动';
      btn.classList.toggle('ftk-stopbtn', !!on);
      btn.title = on ? '点一下：停下所有自动化（视频、答题、翻页）' : '点一下：开始自动做（视频、答题、翻页）';
      try { box.classList.toggle('ftk-on', !!on); } catch (e) { /* 老 DOM 忽略 */ }
      var st = $('ftk-stop');
      if (st) { st.disabled = false; st.style.opacity = '1'; }
    }

    /* ---- 选项绑定 ---- */
    var boxes = {
      auto: $('ftk-auto'), guess: $('ftk-guess'), overwrite: $('ftk-overwrite'),
      baidu: $('ftk-baidu'), icodef: $('ftk-icodef'), ai: $('ftk-ai'),
      logDetail: $('ftk-logdetail'), pipe: $('ftk-pipe'), video: $('ftk-video'),
      verifyAi: $('ftk-verifyai')
    };
    Object.keys(boxes).forEach(function (k) {
      if (k in settings) boxes[k].checked = !!settings[k];
      boxes[k].addEventListener('change', function () {
        settings[k] = boxes[k].checked;
        if (opts.onSettings) opts.onSettings(settings);
      });
    });

    /* 交卷门槛：数字框，单独绑（它不是勾选框） */
    var elMinHit = $('ftk-minhit');
    elMinHit.value = (settings.minHit == null ? 80 : settings.minHit);
    function readMinHit() {
      var v = parseInt(elMinHit.value, 10);
      if (isNaN(v)) v = 80;
      v = Math.max(0, Math.min(100, v));
      settings.minHit = v;
      if (opts.onSettings) opts.onSettings(settings);
      return v;
    }
    elMinHit.addEventListener('change', readMinHit);
    elMinHit.addEventListener('blur', function () { elMinHit.value = readMinHit(); });

    /* 视频倍速：也是数字框 */
    var elRate = $('ftk-rate');
    elRate.value = (settings.rate == null ? 2 : settings.rate);
    function readRate() {
      var v = parseFloat(elRate.value);
      if (isNaN(v) || v <= 0) v = 2;
      v = Math.max(0.5, Math.min(16, v));
      settings.rate = v;
      if (opts.onSettings) opts.onSettings(settings);
      return v;
    }
    elRate.addEventListener('change', readRate);
    elRate.addEventListener('blur', function () { elRate.value = readRate(); });

    /* 视频卡住放行：连续几次没进展才跳下一节（只影响「播放器卡死」的兜底，
       不影响正常播放；默认 8 次） */
    var elMediaWait = $('ftk-mediawait');
    elMediaWait.value = (settings.mediaWait == null ? 8 : settings.mediaWait);
    function readMediaWait() {
      var v = parseInt(elMediaWait.value, 10);
      if (isNaN(v)) v = 8;
      v = Math.max(1, Math.min(60, v));
      settings.mediaWait = v;
      if (opts.onSettings) opts.onSettings(settings);
      return v;
    }
    elMediaWait.addEventListener('change', readMediaWait);
    elMediaWait.addEventListener('blur', function () { elMediaWait.value = readMediaWait(); });

    /* ---- 按钮 ---- */
    function callStop() {
      /* 先把按钮切回「启动」：即使 onStop 里某一层抛异常，用户也能立刻
         看到回执，不会觉得「点了没响应」。真正的停止动作仍由 onStop 广播。 */
      running(false);
      try {
        if (opts.onStop) opts.onStop();
      } catch (e) {
        try { log('停止命令出错（已尝试本地停止）：' + ((e && e.message) || e), 'err'); } catch (e2) { /* ... */ }
        toast('已停止');
      }
    }
    $('ftk-run').addEventListener('click', function () {
      /* 以前靠按钮上的字判断「这次是启动还是停止」：一旦状态和文字对不上，
         用户点「启动」实际执行的是停止 —— 表现就是「点启动没反应」。
         现在同时看面板状态和主流程真实总开关；任一为真都按「停止」处理。 */
      var active = isOn;
      if (!active && typeof opts.isRunning === 'function') {
        try { active = !!opts.isRunning(); } catch (e0) { active = false; }
      }
      if (active) { callStop(); return; }
      running(true);
      try {
        if (opts.onStart) opts.onStart();
      } catch (e) {
        running(false);
        try { log('启动命令出错：' + ((e && e.message) || e), 'err'); } catch (e2) { /* ... */ }
      }
    });
    $('ftk-stop').addEventListener('click', callStop);
    $('ftk-clear').addEventListener('click', clear);
    $('ftk-submit').addEventListener('click', function () { if (opts.onSubmit) opts.onSubmit(); });
    $('ftk-diag').addEventListener('click', function () { if (opts.onDiag) opts.onDiag(); });
    $('ftk-rework').addEventListener('click', function () { if (opts.onRework) opts.onRework(); });
    $('ftk-reset').addEventListener('click', function () { if (opts.onReset) opts.onReset(); });

    function toast(msg) {
      var old = elStatus.textContent;
      elStatus.textContent = msg;
      setTimeout(function () { if (elStatus.textContent === msg) elStatus.textContent = old; }, 2200);
    }

    var api = {
      el: box, node: box, log: log, detail: detail, clear: clear,
      status: status, progress: progress, running: running, toast: toast,
      /* 供 main.ensurePanel 判断这个面板还能不能用：DOM 还在、创建者 realm
         没换页、document 还是原来那份。三者任一不满足就重建。 */
      isAlive: function () {
        try {
          if (!box) return false;
          if (box.isConnected === false) return false;
          if (!ownerWin || ownerWin.closed) return false;
          if (ownerDoc && ownerWin.document !== ownerDoc) return false;
          /* 面板由子 iframe 创建、DOM 挂在外层时，子 iframe 被 remove()
             后 ownerWin.document 不一定变；必须看当初那个 iframe 还在不在。 */
          if (ownerFrame && ownerFrame.isConnected === false) return false;
          return true;
        } catch (eA) { return false; }
      },
      /* 徽标点一下要能显示 / 隐藏整个面板 */
      setVisible: function (v) { box.style.display = v ? '' : 'none'; },
      isVisible: function () { return box.style.display !== 'none'; },
      settings: settings,
      values: function () {
        return {
          auto: boxes.auto.checked, guess: boxes.guess.checked,
          overwrite: boxes.overwrite.checked, baidu: boxes.baidu.checked,
          icodef: boxes.icodef.checked, ai: boxes.ai ? boxes.ai.checked : true,
          logDetail: boxes.logDetail.checked, pipe: !!boxes.pipe.checked,
          video: boxes.video ? boxes.video.checked : true,
          verifyAi: boxes.verifyAi ? boxes.verifyAi.checked : true,
          minHit: settings.minHit == null ? 80 : settings.minHit,
          rate: settings.rate == null ? 2 : settings.rate,
          mediaWait: settings.mediaWait == null ? 8 : settings.mediaWait
        };
      }
    };
    /* 面板对象挂在自己的 DOM 节点上：别的框架（同源）拿到同一个 #ftk-panel
        就能取到这个对象，用它写日志、读状态 —— 这是跨框架共享一份面板的关键。 */
    try { box.__ftkObj = api; } catch (e) { /* ... */ }
    return api;
  }

  root.FreeTikuPanel = { create: create, WHALE: WHALE };
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot
   : (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window));

/* ======================== chaoxing.js ======================== */
/* ============================================================================
 *  chaoxing.js —— 学习通「章节测验 / 作业」页面适配层
 *
 *  结构依据（与 Samueli924/chaoxing 的 api/decode.py 及 ocsjs 的
 *  cdn/chaoxingWork/sk-main.js 逐条对照过，不是猜的）：
 *
 *    div.singleQuesId[data=<qid>]          一道题
 *      └ div.TiMu[data=<题型码>]           0单选 1多选 2填空 3判断 4简答
 *      └ div.Zy_TItle                      题干（含【题型】前缀、题号）
 *      └ ul > li                           选项；每 li 里通常有
 *                                          input[name=answer<qid>][value=A/B/...]
 *                                          判断题用 <b class="ri"> 对 / <b class="wr"> 错
 *      └ textarea / iframe(富文本).p       填空题、简答题的作答区
 *
 *  考试页面（.Cy_TItle / /exam/）结构不同且风控强，本脚本不处理。
 *
 *  Third-party attribution: see THIRD_PARTY_NOTICES.md. Parts of the DOM
 *  knowledge are based on ocsjs (Apache-2.0) and Samueli924/chaoxing
 *  (GPL-3.0); this project is distributed under GPL-3.0-or-later.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var TYPE_CODE = { '0': 'single', '1': 'multiple', '2': 'completion', '3': 'judgement', '4': 'shortanswer' };
  var LETTER = /^[A-Za-z]$/;
  var PL_PUNCT = /[\s,.、，。;；:：!！?？()（）\[\]【】\"'“”‘’《》<>_\-]/g;

  function slice(nodes) { return Array.prototype.slice.call(nodes || []); }
  /* 面板/徽标也住在页面 DOM 里，而且按钮文字恰好有「交卷」「重做」。
     自动找页面按钮时必须排除它们，否则会点到脚本自己 -> 同步递归，
     页面主线程直接卡死（用户 2026-10-22 的现场）。 */
  function isOwnUI(el) {
    try {
      return !!(el && el.closest && el.closest('#ftk-panel,#ftk-badge,#ftk-xframe'));
    } catch (e) { return false; }
  }
  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.hidden) return false;
    /* 先看行内样式：模板/测试环境不一定有可靠的 getComputedStyle。 */
    try {
      var inl = el.style;
      if (inl && (inl.display === 'none' || inl.visibility === 'hidden')) return false;
    } catch (eI) { /* ... */ }
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var st = root.getComputedStyle ? root.getComputedStyle(el) : null;
    return !(st && (st.display === 'none' || st.visibility === 'hidden'));
  }
  /* 学习通把公式画成 <img>（有的带 alt/title，有的什么都不带）。
     只看 innerText 会把整条公式悄悄吃掉 —— 题干和选项各缺一块，
     题库匹配不上、AI 也答不出来（用户报的「公式单选题一道都搜不到」就是这个）。
     这里自己遍历节点，把图片上的文字捡回来。 */
  function latexFromSrc(src) {
    if (!src) return '';
    try {
      var s = String(src);
      var m = s.match(/[?&](?:latex|tex|text|q|str|formula)=([^&]+)/i);
      if (m) {
        var d = decodeURIComponent(m[1]);
        if (d && d.length <= 200) return d;
      }
      if (/\$|\\[a-zA-Z]/.test(s)) {
        var d2 = decodeURIComponent(s);
        var m2 = d2.match(/\$[^$]{1,160}\$/);
        if (m2) return m2[0];
      }
    } catch (e) { /* 解不出来就算了 */ }
    return '';
  }
  function nodeText(n, out, depth) {
    if (!n || depth > 12) return;
    if (n.nodeType === 3) { out.push(n.nodeValue || ''); return; }
    if (n.nodeType !== 1) return;
    var tag = String(n.tagName || '').toLowerCase();
    if (tag === 'br') { out.push(' '); return; }
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
    if (tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video' || tag === 'embed') {
      var t = '';
      try {
        t = n.getAttribute('data-latex') || n.getAttribute('data-tex') ||
            n.getAttribute('data-formula') || n.getAttribute('alt') ||
            n.getAttribute('title') || n.getAttribute('aria-label') || '';
      } catch (e0) { t = ''; }
      if (!t) { try { t = latexFromSrc(n.getAttribute('src')); } catch (e1) { t = ''; } }
      if (!t) { try { t = latexFromSrc(n.getAttribute('data-original')); } catch (e1b) { t = ''; } }
      if (t) { out.push(' ' + t + ' '); return; }
      /* 没文字可捡：学习通把公式/图片选项画成 star3/origin 下的 PNG，
         一般没有 alt，也没有 width/height 属性。以前只认带尺寸的，结果整个选项
         只剩一个字母，题库/AI 都没法对。这里按图片来源和实际像素兜底。
         小图标（radio/check/箭头/loading）不能当公式，否则选项文本会被污染。 */
      var cls = '', src = '', w = 0, h = 0, nw = 0, nh = 0;
      try {
        cls = String(n.getAttribute('class') || '');
        src = String(n.getAttribute('src') || n.getAttribute('data-original') || '');
        w = parseInt(n.getAttribute('width') || '0', 10) || 0;
        h = parseInt(n.getAttribute('height') || '0', 10) || 0;
        nw = parseInt(n.naturalWidth || 0, 10) || 0;
        nh = parseInt(n.naturalHeight || 0, 10) || 0;
      } catch (e2) { /* ... */ }
      var icon = /(?:^|[/_.-])(?:icon|ico|arrow|bullet|check|radio|loading|spacer|blank|logo|emoji)(?:[/_.-]|$)/i
        .test(src + ' ' + cls);
      var isMath = /tex|math|formul|latex|equat/i.test(cls) ||
                   /tex|math|formul|latex|equat|star3\/origin/i.test(src);
      if (isMath && !icon) out.push(' ［式］ ');
      else if (!icon && (w >= 20 || h >= 20 || nw >= 40 || nh >= 20)) out.push(' ［图］ ');
      return;
    }
    var kids = n.childNodes || [];
    for (var i = 0; i < kids.length; i++) nodeText(kids[i], out, depth + 1);
  }
  function txt(el) {
    if (!el) return '';
    var out = [];
    try { nodeText(el, out, 0); } catch (e) { out = [el.textContent || '']; }
    var s = out.join('');
    if (!s.trim() && el.innerText != null) s = el.innerText;   // 兜底
    return s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /* 题干清洗：去掉题号、【题型】、(2分) 之类的前后缀噪音 */
  function cleanStem(t) {
    t = String(t || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    /* 现场格式既有「1. 题干」，也有「1【单选题】题干」——后者以前没剥掉，
       题号会跟着进题库/AI，相似度被拉低。 */
    t = t.replace(/^\s*\d+\s*(?=【)/, '');
    t = t.replace(/^\s*\d+\s*[.、,，:：)）]\s*/, '');
    t = t.replace(/^\s*[（(]\s*\d+\s*[)）]\s*/, '');
    t = t.replace(/^\s*[（(]\s*\d+(\.\d+)?\s*分\s*[)）]\s*/, '');
    t = t.replace(/^\s*【[^】]{1,16}】\s*/, '');
    t = t.replace(/^\s*[（(]\s*[^）)]{0,10}(单选|多选|判断|填空|简答|问答)[^）)]{0,10}[)）]\s*/, '');
    t = t.replace(/\s*[（(]\s*\d+(\.\d+)?\s*分\s*[)）]\s*$/, '');
    t = t.replace(/\s*【\s*\d+(\.\d+)?\s*分\s*】\s*$/, '');
    t = t.replace(/\s*[（(]\s*[)）]\s*$/, '');
    return t.trim();
  }

  /* 选项文本清洗：去掉 "A、" "A." "A)" 前缀和结尾多余标点 */
  function cleanOption(t) {
    t = String(t || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    /* 学习通把选项字母当普通文字放在 <li> 里（"A 波的频率为"），
       不剥掉的话，字母会被当成选项内容的一部分发给题库和 AI。 */
    t = t.replace(/^[（(]\s*[A-Za-z]\s*[)）]\s*/, '');
    t = t.replace(/^[A-Za-z]\s*[.、,，:：)）]\s*/, '');
    t = t.replace(/^[A-Za-z][\s\u3000]+(?=\S)/, '');
    return t.trim();
  }

  /* 把题干/选项里的公式图片地址收集起来，交给本地桥做视觉识别。
     学习通公式图一般在 p.ananas.chaoxing.com/star3/origin/...，没有 alt；
     以前只把位置标成「［式］」，图片本身丢掉了。 */
  function absoluteImageUrl(src) {
    src = String(src || '').trim();
    if (!src) return '';
    if (/^data:image\//i.test(src)) return src;
    if (/^https?:\/\//i.test(src)) return src;
    if (/^\/\//.test(src)) return 'https:' + src;
    try {
      var base = (root.location && root.location.href) || 'https://mooc1.chaoxing.com/';
      return new URL(src, base).href;
    } catch (e) {
      return src.charAt(0) === '/' ? 'https://mooc1.chaoxing.com' + src : '';
    }
  }

  function collectImages(el) {
    var out = [], seen = {};
    if (!el || !el.nodeType) return out;
    var nodes = [];
    try {
      if (el.nodeType === 1 && /^(img|svg|canvas|video|embed)$/i.test(el.tagName)) nodes.push(el);
      if (el.querySelectorAll) nodes = nodes.concat(slice(el.querySelectorAll('img,svg,canvas,video,embed')));
    } catch (e) { /* ... */ }

    function push(u) {
      u = absoluteImageUrl(u);
      if (!u) return;
      if (!/^https?:\/\//i.test(u) && !/^data:image\//i.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1;
      out.push(u);
    }

    nodes.forEach(function (n) {
      var tag = String(n.tagName || '').toLowerCase();
      if (tag === 'video' || tag === 'embed' || tag === 'svg') return; // 公式题基本都是 PNG
      if (tag === 'canvas') {
        try {
          var data = n.toDataURL && n.toDataURL('image/png');
          if (data && data.length > 120) push(data);
        } catch (eC) { /* 画布被污染，读不了 */ }
        return;
      }
      if (tag !== 'img') return;
      var src = '', cls = '', w = 0, h = 0, nw = 0, nh = 0;
      try {
        src = n.currentSrc || n.getAttribute('src') ||
              n.getAttribute('data-src') || n.getAttribute('data-original') || '';
        cls = String(n.getAttribute('class') || '');
        w = parseInt(n.getAttribute('width') || '0', 10) || 0;
        h = parseInt(n.getAttribute('height') || '0', 10) || 0;
        nw = parseInt(n.naturalWidth || 0, 10) || 0;
        nh = parseInt(n.naturalHeight || 0, 10) || 0;
      } catch (e0) { return; }
      src = absoluteImageUrl(src);
      if (!src) return;
      var marker = src + ' ' + cls;
      if (/(?:^|[/_.-])(?:icon|ico|arrow|bullet|check|radio|loading|spacer|blank|logo|avatar|emoji)(?:[/_.-]|$)/i
        .test(marker)) return;
      var formula = /tex|math|formul|latex|equat|star3\/origin/i.test(marker);
      /* 明显的小图标不送给视觉模型；没有尺寸属性的公式图照常保留。 */
      if (!formula && ((w && h && w < 16 && h < 16) || (nw && nh && nw < 16 && nh < 16))) return;
      push(src);
    });
    return out;
  }

  function optionImages(textEl, li) {
    var out = [], seen = {};
    collectImages(textEl).concat(collectImages(li)).forEach(function (u) {
      if (!seen[u]) { seen[u] = 1; out.push(u); }
    });
    return out;
  }

  /* 纯图片选项：文本可能只剩「［式］」「［图］」或字母。
     这种题脚本没有可靠的公式识别能力，必须明确标出来，不能拿去让 AI 猜。 */
  function optionHasImage(el) {
    try { return !!(el && el.querySelector && el.querySelector('img,svg,canvas,video')); }
    catch (e) { return false; }
  }
  function optionIsImageOnly(text) {
    var t = String(text || '')
      .replace(/[\[［【(（]\s*(?:式|图|图片|公式|影像)\s*[\]］】)）]/g, '')
      .replace(/[A-Za-z\s]/g, '');
    return !t;
  }

  /* 图片公式题不只是「整道题全是图」。学习通很多题的选项是
     「波的频率为［式］」——周围有文字，但关键公式仍在图片里，源码里
     只有一个没有 alt 的 PNG。这种题 AI 也看不到公式，不能拿去猜。 */
  function hasUnreadableImage(el, text) {
    if (!optionHasImage(el)) return false;
    return /[\[［【(（]\s*(?:式|图|图片|公式|影像)\s*[\]］】)）]/.test(String(text || ''));
  }

  function pageKind() {
    var href = location.href;
    if (/\/exam\/|exam-ans|\/examtopic/i.test(href)) return 'exam';
    if (document.querySelector('.Cy_TItle') && !document.querySelector('.TiMu')) return 'exam';
    if (document.querySelector('div.TiMu, div.singleQuesId, .Zy_TItle')) return 'work';
    return 'other';
  }

  /* 找到每道题的容器。
     正常情况一个 .singleQuesId 就是一题；但材料题/复合题会把好几道小题的
     .TiMu 塞进同一个 .singleQuesId，这时必须以每个 .TiMu 为锚 ——
     以前以上层为锚，只能解析出第一小题，后面的永远交白卷。 */
  function anchors() {
    var sq = slice(document.querySelectorAll('div.singleQuesId'));
    var out = [];
    sq.forEach(function (s) {
      var tis = slice(s.querySelectorAll('div.TiMu'));
      if (tis.length > 1) {
        tis.forEach(function (t) { out.push(t); });
      } else {
        out.push(s);
      }
    });
    if (out.length) return out;
    var a = slice(document.querySelectorAll('div.TiMu'));
    if (a.length) return a;
    return [];
  }

  function extractQuestions() {
    var list = [];
    anchors().forEach(function (anchor, idx) {
      var ti = anchor.classList && anchor.classList.contains('TiMu')
        ? anchor : anchor.querySelector('div.TiMu');
      var code = ti ? (ti.getAttribute('data') || '') : '';
      var type = TYPE_CODE[String(code).trim()] || '';

      var titleEl = anchor.querySelector('.Zy_TItle') || (ti && ti.querySelector('.Zy_TItle'));
      var stem = cleanStem(txt(titleEl));
      if (!stem) return;
      var stemBlindImage = hasUnreadableImage(titleEl, stem);
      var stemImages = collectImages(titleEl);

      // ---- 选项 ----
      /* 题干里也可能带 <ul>（材料题要点）。只认「里面真的有作答 input」的那个 ul，
         否则字母会从题干列表开始数，整题错位。 */
      var uls = slice(anchor.querySelectorAll('ul'));
      var ul = null;
      for (var _ui = 0; _ui < uls.length; _ui++) {
        if (uls[_ui].querySelector('input')) { ul = uls[_ui]; break; }
      }
      if (!ul && uls.length) ul = uls[uls.length - 1];
      var lis = ul ? slice(ul.children).filter(function (n) { return n.tagName === 'LI'; }) : [];
      var options = lis.map(function (li, i) {
        var input = li.querySelector('input');
        var bRi = li.querySelector('b.ri'), bWr = li.querySelector('b.wr');
        var judge = bRi ? true : (bWr ? false : null);
        /* 选项正文在 a.after / p 里；直接读整个 li 会把前面的「A」和装饰图标
           一起带进来，公式图片选项还容易把字母当成正文。 */
        var textEl = li.querySelector('a.after') || li.querySelector('p') || li;
        var raw = txt(textEl);
        var val = input ? String(input.getAttribute('value') || '') : '';
        var num = li.querySelector('span.num_option[data]');
        var letter = LETTER.test(val) ? val.toUpperCase()
          : (num && LETTER.test(String(num.getAttribute('data') || '')) ? String(num.getAttribute('data')).toUpperCase()
            : String.fromCharCode(65 + i));
        var hasImage = optionHasImage(textEl) || optionHasImage(li);
        var imgs = optionImages(textEl, li);
        var text = judge === null ? cleanOption(raw) : (judge ? '对' : '错');
        if (!text && hasImage) text = '［图］';
        /* 有些版本判断题不用 b.ri/b.wr，只用「对 / 错」文字或 span.num_option */
        if (judge === null) {
          var jt = String(text).replace(/[\s。.！!？?]/g, '');
          if (/^(对|正确|是|√|✓|true)$/i.test(jt)) judge = true;
          else if (/^(错|错误|否|×|✗|false)$/i.test(jt)) judge = false;
        }
        return {
          letter: letter,
          text: text,
          raw: raw,
          judge: judge,
          hasImage: hasImage,
          images: imgs,
          imageOnly: hasImage && optionIsImageOnly(text),
          blindImage: hasUnreadableImage(textEl, text) || hasUnreadableImage(li, text),
          li: li,
          input: input
        };
      }).filter(function (o) { return o.text || o.input || o.hasImage; });

      // ---- 题型兜底推断 ----
      if (!type) {
        var hasCheckbox = options.some(function (o) { return o.input && o.input.type === 'checkbox'; });
        var hasJudge = options.some(function (o) { return o.judge !== null; });
        if (anchor.querySelector('textarea') || options.length === 0) type = 'completion';
        else if (hasCheckbox) type = 'multiple';
        else if (hasJudge) type = 'judgement';
        else type = 'single';
      }
      if (type === 'shortanswer') type = 'completion';

      // ---- 作答控件 ----
      var tas = slice(anchor.querySelectorAll('textarea'));
      var ta = tas[0] || null;
      var iframe = anchor.querySelector('iframe');
      var pEls = [];
      if (iframe) {
        try {
          var doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
          if (doc) pEls = slice(doc.querySelectorAll('body p'));
        } catch (e) { /* 跨域就别管了 */ }
      }

      var qid = anchor.getAttribute('data') || '';
      if (!qid) {
        var first = anchor.querySelector('input[name^="answer"]');
        if (first) qid = String(first.getAttribute('name')).replace(/^answer/, '').split('_')[0];
      }

      // 是否已经作答
      var answered = false;
      if (type === 'completion') answered = !!(ta && String(ta.value || '').trim());
      else answered = options.some(function (o) { return o.input && o.input.checked; });
      // 有些版本的选中态是靠 li 上的 class
      if (!answered) answered = !!anchor.querySelector('li.cur, li.checked, li.selected');

      list.push({
        idx: idx, qid: qid, type: type, stem: stem,
        options: options, textarea: ta, textareas: tas, iframe: iframe, pEls: pEls,
        answered: answered, anchor: anchor,
        stemImages: stemImages,
        imageOnly: options.some(function (o) { return o.imageOnly; }),
        blindImage: stemBlindImage || options.some(function (o) { return o.blindImage; })
      });
    });
    return list;
  }

  /* 触发一次「真」点击。
     注意：click() 和手动派发 click 事件二者只能取其一 —— 复选框/单选框每收到一次
     click 激活行为就翻转一次状态，两个都做 = 点了两下 = 等于没点。 */
  function fireClick(el) {
    if (!el) return false;
    if (typeof el.click === 'function') {
      try { el.click(); return true; } catch (e) { /* 落到下面 */ }
    }
    try {
      var opt = { bubbles: true, cancelable: true, view: root };
      var ME = root.MouseEvent;
      ['mousedown', 'mouseup', 'click'].forEach(function (t) {
        el.dispatchEvent(ME ? new ME(t, opt) : new root.Event(t, opt));
      });
    } catch (e) { /* ignore */ }
    return true;
  }

  function selectOption(q, opt) {
    var input = opt.input;
    if (input) {
      if (!input.checked) fireClick(input);
      if (input.checked) return true;
      // 浏览器/页面脚本不配合时兜底：直接改状态再广播
      input.checked = true;
      if (input.setAttribute) input.setAttribute('checked', 'checked');
      ['input', 'change'].forEach(function (t) {
        input.dispatchEvent(new root.Event(t, { bubbles: true }));
      });
      return !!input.checked;
    }
    // 没有 input 的版本：点 li / label，并补上选中标记类
    var target = opt.li.querySelector('label') || opt.li;
    fireClick(target);
    try { opt.li.classList.add('cur', 'checked'); } catch (e) { /* ignore */ }
    return true;
  }

  /* 取消勾选（多选题改答案时用） */
  function unselectOption(opt) {
    var input = opt.input;
    if (!input) return false;
    if (input.checked) fireClick(input);          // 再点一次即取消
    if (input.checked) {
      input.checked = false;
      if (input.removeAttribute) input.removeAttribute('checked');
      input.dispatchEvent(new root.Event('change', { bubbles: true }));
    }
    return !input.checked;
  }

  function fillText(q, text) {
    var ok = false;
    /* 填空题可能有多个空（多个 textarea），题库用 # 分隔答案。
       以前整串「北京#上海」写进第一个框、第二个空着，还报成功。 */
    var tas = (q.textareas && q.textareas.length) ? q.textareas : (q.textarea ? [q.textarea] : []);
    if (tas.length) {
      var pieces = String(text).split('#');
      for (var ti2 = 0; ti2 < tas.length; ti2++) {
        var piece = ti2 < pieces.length ? pieces[ti2] : '';
        if (!piece && ti2 > 0) break;                 // 答题卡只有这一空，别硬塞
        tas[ti2].focus();
        tas[ti2].value = piece;
        ['input', 'change', 'keyup', 'blur'].forEach(function (t) {
          tas[ti2].dispatchEvent(new root.Event(t, { bubbles: true }));
        });
        ok = true;
      }
    }
    (q.pEls || []).forEach(function (p, i) {
      var piece = String(text).split('#')[i] != null ? String(text).split('#')[i] : text;
      p.textContent = piece;
      try { p.dispatchEvent(new root.Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
      ok = true;
    });
    return ok;
  }

  /* 把题库返回的答案落到页面上。返回 {applied, how, detail} */
  function apply(q, resp, settings) {
    var ans = (resp && resp.answer) || {};
    var keyText = String(ans.answerKeyText || '').toUpperCase();
    var best = ans.bestAnswer || [];

    if (q.type === 'completion') {
      var text = best.join('#') || ans.answerText || '';
      if (!text) return { applied: false, how: '空答案' };
      var ok = fillText(q, text);
      return { applied: ok, how: ok ? '填入文本框' : '找不到输入框', detail: text };
    }

    // 选择题：把答案转成字母集合
    var letters = [];
    if (keyText) {
      keyText.split('').forEach(function (c) { if (LETTER.test(c)) letters.push(c.toUpperCase()); });
    }
    if (!letters.length) {
      /* 有些数据源把答案直接写成「B」或「A,C」，但没填 answerKeyText。
         以前会走到文字匹配，最后报「无法定位选项」。 */
      best.forEach(function (b) {
        var s = String(b == null ? '' : b).trim();
        if (/^[A-Za-z](?:[\s,，、;；/|]*[A-Za-z])*$/.test(s)) {
          s.split('').forEach(function (c) { if (LETTER.test(c)) letters.push(c.toUpperCase()); });
        }
      });
    }
    if (!letters.length) {
      var C = root.FreeTikuCore;
      letters = q.options.map(function (o) {
        var hit = best.some(function (b) {
          var vs = C && C.answerVariants ? C.answerVariants(b) : [String(b).toLowerCase().replace(/\s+/g, '')];
          var no = String(o.text).toLowerCase().replace(/\s+/g, '');
          return vs.some(function (v) {
            if (!v) return false;
            if (v === no) return true;
            /* 包含关系只在否定语气一致时才算命中（「不相等」≠「相等」） */
            var negA = /^(不|非|无|未|没|否|勿|莫|别|反)/.test(v);
            var negB = /^(不|非|无|未|没|否|勿|莫|别|反)/.test(no);
            if (negA !== negB) return false;
            return no.indexOf(v) >= 0 || (v.length > 1 && v.indexOf(no) >= 0);
          });
        });
        return hit ? o.letter : null;
      }).filter(Boolean);
    }
    if (!letters.length && best.length && q.options.length) {
      /* 再拿选项的**页面原文**（o.raw，字体加密前的那一份）试一次：
         来源回的可能是加密前的文字，而内存里的 o.text 已经被解密改写过。 */
      var C2 = root.FreeTikuCore;
      letters = q.options.map(function (o) {
        var raw = String(o.raw || '');
        if (!raw) return null;
        var abs = C2 && C2.answerVariants ? C2.answerVariants : null;
        var hit = best.some(function (b) {
          var vs = abs ? abs(b) : [String(b).toLowerCase().replace(/\s+/g, '')];
          var nr = raw.toLowerCase().replace(/\s+/g, '');
          return vs.some(function (v) {
            return v && (nr.indexOf(v) >= 0 || (v.length > 1 && v.indexOf(nr) >= 0));
          });
        });
        return hit ? o.letter : null;
      }).filter(Boolean);
    }
    if (!letters.length && q.type === 'judgement') {
      /* 判断题：题库常只给「正确 / 不正确 / 对 / 错」，字面对不上选项里的「对 / 错」。
         直接问 core 的 judgeBool 要好过做字符串比较。 */
      var Cj = root.FreeTikuCore;
      var jb = null;
      if (Cj && Cj.judgeBool) {
        for (var bi = 0; bi < best.length; bi++) {
          var bv = Cj.judgeBool(best[bi]);
          if (bv === true || bv === false) { jb = bv; break; }
        }
      }
      if (jb === null) {
        for (var si = 0; si < best.length; si++) {
          var sv = String(best[si]);
          if (/不正确|不对|错误|错|false|否|×/i.test(sv)) { jb = false; break; }
          if (/正确|对|true|是|√/i.test(sv)) { jb = true; break; }
        }
      }
      if (jb !== null) {
        var want = q.options.filter(function (o) { return o.judge === jb; })[0];
        if (want) letters = [want.letter];
      }
    }

    if (!letters.length && best.length && q.options.length) {
      /* 最后一招：题库/模型给的答案文字跟卷面选项字面差得远（题库串了别的课，
         比如答案「组别相等」而选项写「连接组标号相等」）。按最长公共子序列
         挑最像的那一项，只要明显领先第二名就认。 */
      var lcs = function (a, b) {
        var m = a.length, n = b.length, prev = [], cur = [], i, j;
        for (j = 0; j <= n; j++) prev[j] = 0;
        for (i = 1; i <= m; i++) {
          cur = [0];
          for (j = 1; j <= n; j++) {
            cur[j] = (a.charAt(i - 1) === b.charAt(j - 1))
              ? prev[j - 1] + 1
              : Math.max(prev[j], cur[j - 1]);
          }
          prev = cur;
        }
        return prev[n];
      };
      var strip = function (s) { return String(s || '').toLowerCase().replace(PL_PUNCT, ''); };
      var cand = [];
      best.forEach(function (b) {
        var nb = strip(b);
        if (!nb) return;
        q.options.forEach(function (o) {
          var no = strip(o.text);
          if (!no) return;
          cand.push({ letter: o.letter, score: lcs(nb, no) / nb.length });
        });
      });
      cand.sort(function (p1, p2) { return p2.score - p1.score; });
      if (cand.length && cand[0].score >= 0.6 &&
          (!cand[1] || cand[0].score - cand[1].score >= 0.1)) {
        letters = [cand[0].letter];
      }
    }
    if (!letters.length) return { applied: false, how: '无法定位选项' };

    if (q.type === 'single' && letters.length > 1) letters = [letters[0]];

    var chosen = q.options.filter(function (o) { return letters.indexOf(o.letter) >= 0; });
    if (!chosen.length) return { applied: false, how: '字母对不上选项', detail: letters.join('') };

    // 允许覆盖时，先把不该选的勾去掉，否则会多选/单选会留下两个勾
    var cleared = 0;
    if (settings && settings.overwrite) {
      q.options.forEach(function (o) {
        if (letters.indexOf(o.letter) < 0 && o.input && o.input.checked && unselectOption(o)) cleared++;
      });
    }

    var done = 0;
    chosen.forEach(function (o) {
      if (!selectOption(q, o)) return;
      /* 有些页面脚本会在 click 后异步把 checked 改回去；这里至少确认
         当前 DOM 上真的处于选中态，不再「点了就算成功」。 */
      if (o.input ? !!o.input.checked : true) done++;
    });
    return {
      applied: done > 0,
      selected: chosen.map(function (o) { return o.letter; }).join(''),
      how: '点选 ' + chosen.map(function (o) { return o.letter; }).join('') +
           (cleared ? '，清掉误选 ' + cleared + ' 项' : ''),
      detail: chosen.map(function (o) { return o.letter + '、' + o.text; }).join('  ')
    };
  }

  /* 找交卷按钮 */
  function findSubmit() {
    var byId = ['#submitBtn', '#submit', '.ZY_submit', '.completeBtn', '#completeBtn', '.btnSubmit'];
    for (var i = 0; i < byId.length; i++) {
      var e = document.querySelector(byId[i]);
      if (e && isVisible(e)) return e;
    }
    var cands = slice(document.querySelectorAll('a,button,input[type=button],input[type=submit],span[onclick],div[onclick]'));
    var want = /^(提交|交卷|提交答案|保存并提交|确认提交|完成)$/;
    for (var j = 0; j < cands.length; j++) {
      var e2 = cands[j];
      if (isOwnUI(e2)) continue;
      if (!isVisible(e2)) continue;
      var t = txt(e2) || String(e2.value || '');
      if (want.test(t.replace(/\s/g, ''))) return e2;
    }
    return null;
  }

  /* 点掉提交后弹出的确认框
     踩过的坑（实测）：点完「提交」弹出来的那个「提示 / 确认提交？」框，
     经常挂在外层文档上，而题目在一个 iframe 里 —— 所以只在 document 里找是找不到的，
     面板会一直停在「不确定交上没有」。另外也不能盲目点页面上任何一个「提交」，
     页面自己的那个交卷按钮就叫「提交」。所以这里的判据是：
       先找看得见的「取消」→ 往上找一个能同时看见「取消」和「提交/确定」的小容器（那就是弹窗）
       → 在它里面点「提交/确定」。页面自己的交卷按钮旁边没有「取消」，不会被误点。 */
  function isVisibleIn(el, win) {
    if (!el) return false;
    try {
      if (el.getBoundingClientRect) {
        var r = el.getBoundingClientRect();
        if (r && r.width === 0 && r.height === 0) return false;
      }
    } catch (e) { /* ... */ }
    try {
      var w = win || root;
      var st = w.getComputedStyle ? w.getComputedStyle(el) : null;
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
    } catch (e2) { /* ... */ }
    return true;
  }

  /* 自己能看到的文档：本层 + 往上最多 3 层父框架 + 往下最多 2 层子框架 */
  function relatedDocs() {
    var out = [], seen = [], w = root, n = 0;
    function add(doc, win) {
      if (!doc) return;
      for (var i = 0; i < seen.length; i++) if (seen[i] === doc) return;
      seen.push(doc);
      out.push({ doc: doc, win: win });
    }
    try { add(root.document, root); } catch (e) { /* ... */ }
    while (n++ < 3) {
      var up = null;
      try { if (w.parent && w.parent !== w) up = w.parent; } catch (e2) { up = null; }
      if (!up) break;
      try { add(up.document, up); } catch (e3) { /* 跨域 */ }
      w = up;
    }
    for (var k = 0; k < out.length; k++) {
      var frames = [];
      try { frames = slice(out[k].doc.querySelectorAll('iframe,frame')); } catch (e4) { frames = []; }
      for (var f = 0; f < frames.length; f++) {
        if (out.length > 12) break;
        try {
          var d = frames[f].contentDocument;
          if (d) add(d, frames[f].contentWindow || out[k].win);
        } catch (e5) { /* 跨域 */ }
      }
    }
    return out;
  }

  function clickConfirmIn(doc, win) {
    if (!doc || !doc.querySelectorAll) return false;
    var all = [];
    try { all = slice(doc.querySelectorAll('a,button,span,div,input[type=button]')); } catch (e) { return false; }

    /* 1. 老版固定选择器（ocsjs sk-main.js:810 实测可用） */
    try {
      var old = doc.querySelector('.AlertCon02 a.bluebtn, .AlertCon02 .bluebtn');
      if (old && isVisibleIn(old, win)) { fireClick(old); return true; }
    } catch (e1) { /* ... */ }

    /* 2. 通用：以「取消」为锚，往上找弹窗容器，再在容器里点「提交/确定」 */
    var boxes = [], i, n, p;
    for (i = 0; i < all.length; i++) {
      var e = all[i];
      if (!isVisibleIn(e, win)) continue;
      if (txt(e).replace(/\s/g, '') !== '取消') continue;
      p = e;
      for (n = 0; p && n < 5; n++, p = p.parentNode) {
        var tag = (p.tagName || '').toUpperCase();
        if (tag === 'BODY' || tag === 'HTML') break;   /* 再往上就是整页了，那不算弹窗 */
        var pt = p.textContent ? String(p.textContent).replace(/\s/g, '') : '';
        if (!pt) continue;
        if (pt.length > 200) break;                    /* 弹窗不会这么长，往上只会更长 */
        if (/(提交|确定|确认)/.test(pt)) { boxes.push(p); break; }
      }
    }
    for (var b = 0; b < boxes.length; b++) {
      var cs = [];
      try { cs = slice(boxes[b].querySelectorAll('a,button,span,input[type=button]')); } catch (e2) { cs = []; }
      for (var j = 0; j < cs.length; j++) {
        var ok = cs[j];
        if (ok.children && ok.children.length) continue;
        if (!isVisibleIn(ok, win)) continue;
        var t = (txt(ok) || String(ok.value || '')).replace(/\s/g, '');
        if (!/^(提交|确定|确认|确认提交|是的|继续提交|继续)$/.test(t)) continue;
        fireClick(ok);
        return true;
      }
    }
    return false;
  }

  function confirmDialog() {
    var docs = relatedDocs();
    for (var i = 0; i < docs.length; i++) {
      if (clickConfirmIn(docs[i].doc, docs[i].win)) return true;
    }
    return false;
  }

  // ---- 字体加密 ---------------------------------------------------------
  // 学习通把题干/选项里的一部分字换成「假字」，再用 <style id="cxSecretStyle">
  // 里内嵌的自定义字体把假字渲染成真字的形状。页面上看着是对的，网页源码里
  // 读出来是乱的。实测：
  //   真：人文“Humanity”这个词最早是在什么时期提出的？
  //   读：幍幊“Humanity”幎幈词幋幉是在什么时期提出縨？
  // 这里只负责把那段字体的 base64 抠出来（解密交给本地桥，它装了 fontTools）。
  function fontBase64(doc, depth) {
    doc = doc || root.document;
    depth = depth || 0;
    if (!doc) return '';
    try {
      var st = doc.getElementById && doc.getElementById('cxSecretStyle');
      if (st && st.textContent) {
        /* 学习通不同版本这里可能用单引号、双引号，甚至不带引号。
           base64 只包含 A-Z a-z 0-9 + / =，按这个字符集截取最稳，
           不会把后面的 format('woff') 也吞进来。 */
        var m = /base64,([A-Za-z0-9+/=\r\n]+)/.exec(st.textContent);
        if (m && m[1]) return m[1].replace(/\s+/g, '');
      }
    } catch (e) { /* 跨域或没这个 style */ }
    if (depth >= 2) return '';
    var frames = [];
    try { frames = doc.querySelectorAll('iframe,frame'); } catch (e) { frames = []; }
    for (var i = 0; i < frames.length; i++) {
      var d = null;
      try { d = frames[i].contentDocument; } catch (e) { d = null; }
      if (d) {
        var got = fontBase64(d, depth + 1);
        if (got) return got;
      }
    }
    return '';
  }

  // 先找自己这层和子框架，再沿父框架往上找（同源才读得到）
  function fontData() {
    var hit = fontBase64(root.document, 0);
    if (hit) return hit;
    try {
      var w = root, n = 0;
      while (w !== w.parent && n < 3) {
        w = w.parent;
        n++;
        if (w.document) {
          hit = fontBase64(w.document, 0);
          if (hit) return hit;
        }
      }
    } catch (e) { /* 父框架跨域 */ }
    return '';
  }

  /* 这一页是不是「已经批改完的结果页」？
     流水线最怕的就是：交完之后页面变成结果页，而脚本以为「这页没题目」就什么都不做，
     于是整条流水线停在那儿 —— 用户看到的现象就是「答完一章就不动了」。
     返回值：null=还是答题页 / 'fail'=没及格，可重做 / 'done'=已交并批改 */
  /* 这一页还能不能填答案？
     实测（用户截图）：已批改的结果页上 `.TiMu` 还在，只是 radio/checkbox/textarea 都撤了。
     所以「还有没有 .TiMu」骗不了，得看「还有没有可填的控件」。 */
  function hasAnswerInputs() {
    try {
      /* 结果页有时会保留 textarea（只是 disabled / 藏起来），以前只要
         源码里有 .TiMu textarea 就当成答题页，填空卷会被再答一遍。 */
      var tas = document.querySelectorAll('.TiMu textarea');
      for (var t = 0; t < tas.length; t++) {
        if (tas[t].disabled || tas[t].readOnly) continue;
        if (isVisible(tas[t])) return true;
      }
      var ins = document.querySelectorAll('.TiMu input[type=radio], .TiMu input[type=checkbox]');
      for (var i = 0; i < ins.length; i++) {
        if (ins[i].disabled) continue;
        if (isVisible(ins[i])) return true;
      }
    } catch (e) { /* ... */ }
    return false;
  }

  /* 失败提示必须真的看得见。结果页模板里常留一份 display:none 的
     「未达到及格线」，拿整段 textContent 判断会把满分当成不合格，
     然后自动点「重做」——用户看到的就是全对又做一遍。 */
  function hasVisibleFail() {
    try {
      var all = document.querySelectorAll('body, body *');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (isOwnUI(el)) continue;                 // 面板日志里的字不算页面结果
        /* 只看这一层自己的文字，避免把隐藏子元素里的模板文字带进来。 */
        var direct = '';
        try {
          for (var c = el.firstChild; c; c = c.nextSibling) {
            if (c.nodeType === 3) direct += c.nodeValue || '';
          }
        } catch (eD) { direct = ''; }
        var s = direct.replace(/\s+/g, '');
        if (!/未达到及格线|不及格|未通过/.test(s)) continue;
        if (isVisible(el)) return true;
      }
    } catch (e) { /* ... */ }
    return false;
  }

  function resultState() {
    try {
      /* 用 innerText：它不把 display:none 的模板文字算进来。
         结果页的隐藏模板里经常留着「未达到及格线」，以前拿 textContent
         判断，满分也会被当成不及格 —— 于是脚本点「重做」，把已经全对的
         题又做了一遍。 */
      var b = document.body;
      var t = '';
      try { t = (b && (b.innerText || b.textContent)) || ''; } catch (eT) { t = (b && b.textContent) || ''; }
      if (!/我的答案|正确答案|答案解析|参考答案/.test(t)) return null;
      if (hasAnswerInputs()) return null;                  // 还能填 = 还是答题页
      /* 只认「看得见」的失败提示。标题里写着「未达到及格线」但实际是
         display:none 模板时，绝不能因为分数/文字猜错就重做。 */
      return hasVisibleFail() ? 'fail' : 'done';
    } catch (e) { /* ... */ }
    return null;
  }

  /* 课程页最底下那排「上一节 / 下一节」。
     实测（用户截图）：章节测验页底部居中就有「上一节 / 下一节」两个蓝按钮。
     它比在课程树里算下标稳，所以流水线优先用它。
     传 doc / win 是为了能从子框架去找外层文档上的那个按钮。 */
  function findNextPageBtn(doc, win) {
    doc = doc || document;
    win = win || root;
    if (!doc || !doc.querySelector) return null;
    var ids = ['prevNextFocusNext', 'next', 'nextBtn'];
    for (var i = 0; i < ids.length; i++) {
      try {
        var e = doc.getElementById(ids[i]);
        if (e && isVisibleIn(e, win)) return e;
      } catch (x) { /* ... */ }
    }
    var sels = ['.jb_btn.nextChapter', '.nextChapter'];
    for (var j = 0; j < sels.length; j++) {
      try {
        var e2 = doc.querySelector(sels[j]);
        if (e2 && isVisibleIn(e2, win)) return e2;
      } catch (x2) { /* ... */ }
    }
    var all = [];
    try { all = slice(doc.querySelectorAll('a,button,div,span')); } catch (e3) { return null; }
    for (var k = 0; k < all.length; k++) {
      var el = all[k];
      if (isOwnUI(el)) continue;
      if (el.children && el.children.length) continue;
      if (!isVisibleIn(el, win)) continue;
      var s = String(el.textContent || '').replace(/\s/g, '');
      if (!s || s.length > 12) continue;
      if (/^(下一节|下一页|下一章|下一个)$/.test(s)) return el;
    }
    return null;
  }

  /* 结果页上的「重做 / 重新答题」按钮 */
  function findRework() {
    try {
      var cands = document.querySelectorAll('a,button,input[type=button],span[onclick],div[onclick]');
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (isOwnUI(el)) continue;
        if (el.offsetParent === null) continue;
        var s = String(el.textContent || el.value || '').replace(/\s+/g, '');
        if (/^(重做|重新做|再做一次|重新答题|重做此题|重新提交)$/.test(s)) return el;
      }
    } catch (e) { /* ... */ }
    return null;
  }

  root.FreeTikuChaoxing = {
    pageKind: pageKind,
    extractQuestions: extractQuestions,
    apply: apply,
    findSubmit: findSubmit,
    confirmDialog: confirmDialog,
    resultState: resultState,
    hasAnswerInputs: hasAnswerInputs,
    findRework: findRework,
    findNextPageBtn: findNextPageBtn,
    fireClick: fireClick,
    cleanStem: cleanStem,
    cleanOption: cleanOption,
    collectImages: collectImages,
    fontData: fontData,
    txt: txt
  };
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot
   : (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window));

/* ======================== pipeline.js ======================== */
/* ============================================================================
 *  pipeline.js —— 流水线：答完自动交卷 → 自动切到下一个章节测验 → 接着答
 *
 *  为什么这样分工（这是这个模块唯一需要理解的架构决定）：
 *    学习通的「课程树 + 任务点 iframe」只在最外层那一页（studentstudy）里，
 *    而题目在被嵌进去的那个 iframe 里。所以：
 *      · 最外层框架：只提供「点下一个」这一个服务，挂在 window.__ftkAdvance 上；
 *      · 题目所在框架：答题 → 交卷 → 调一次 __ftkAdvance.next()，让外层切过去。
 *    切断后 iframe 重新加载 → 脚本重新注入 → 又自动开答。
 *    每一轮都是全新的一页，不需要一个长跑的循环去猜「页面什么时候好了」，
 *    这是最不容易失步的做法（长循环最容易在换页时卡死或点错东西）。
 *
 *  选择器说明：
 *    ocsjs/ocsjs 是 Apache-2.0 项目，本项目在调研超星 DOM 时参考了它的公开入口，
 *    并在 THIRD_PARTY_NOTICES.md 中保留归属。具体实现按本项目的扫描结构
 *    重新组织，不直接复制它的函数。
 *  · 未完成的章节/任务点： class 含 `jobCount`
 *  · 当前章节： `h3.currents, h4.currents, h5.currents`
 *  · 章节树全部节点： `.noJob,.jobCount,.blue,.lock` 的父级 `h3/h4/h5`
 *  · 同一章内的任务点标签： `.tabtags span`
 *  · 任务点 iframe：父级链上能找到 `.ans-job-icon`；已完成则父级有 `ans-job-finished`
 * ==========================================================================*/
(function (root) {
  'use strict';

  /* 任务点类型：按 URL 里的模块路径归类。表驱动比一串 if 更容易核对。 */
  var MODULE_PATHS = [
    ['/ananas/modules/video', 'video'],
    ['/ananas/modules/audio', 'audio'],
    ['/ananas/modules/work', 'work'],
    ['/ananas/modules/ppt', 'ppt'],
    ['/ananas/modules/pdf', 'pdf'],
    ['/ananas/modules/innerbook/', 'book']
  ];

  function moduleType(url) {
    var text = String(url || '');
    for (var i = 0; i < MODULE_PATHS.length; i++) {
      if (text.indexOf(MODULE_PATHS[i][0]) >= 0) return MODULE_PATHS[i][1];
    }
    return '';
  }

  var TYPE_CN = {
    video: '视频', audio: '音频', work: '章节测验',
    ppt: 'PPT', pdf: '文档', book: '书本', '': '未知'
  };

  function typeCN(t) { return TYPE_CN[t] || t || '未知'; }

  function txt(el, n) {
    if (!el) return '';
    return String(el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, n || 40);
  }

  function hasCls(el, c) {
    if (!el || !el.className) return false;
    return (' ' + String(el.className) + ' ').indexOf(' ' + c + ' ') >= 0;
  }

  function srcOf(f) {
    try {
      if (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) {
        return String(f.contentWindow.location.href);
      }
    } catch (e) { /* 跨域读不到就退回 attribute */ }
    return String(f.getAttribute('src') || '');
  }

  /* ---------------------------------------- 新版课程树要用的几个小工具 */
  function byId(doc, id) {
    try {
      var el = doc.getElementById ? doc.getElementById(id) : null;
      if (!el && doc.querySelector) el = doc.querySelector('#' + id);
      return el ? String(el.value || '') : '';
    } catch (e) { return ''; }
  }

  /* onclick="getTeacherAjax('courseId','clazzId','chapterId')" -> chapterId
     这里按参数位置取第三个值，而不是依赖整串正则；页面多包一层空格也能读。 */
  function chapterIdFromOnclick(el) {
    try {
      var raw = String(el.getAttribute('onclick') || '');
      var open = raw.indexOf('(');
      var close = raw.lastIndexOf(')');
      if (open < 0 || close <= open) return '';
      var args = raw.slice(open + 1, close).split(',');
      if (args.length < 3) return '';
      return args[2].trim().replace(/^['"]|['"]$/g, '');
    } catch (e) { return ''; }
  }

  /* 新版课程树的完成状态：true=做完 / false=还有未完成 / null=读不出来。 */
  function modernFinished(container) {
    if (!container || !container.querySelector) return null;
    try {
      if (container.querySelector('.icon_Completed')) return true;

      var pending = container.querySelector('.jobUnfinishCount');
      if (pending) {
        /* 真实浏览器里 <span value="0"> 的 .value 是 undefined，优先读属性。 */
        var attr = pending.getAttribute ? pending.getAttribute('value') : null;
        var count = pending.value != null && pending.value !== '' ? pending.value : attr;
        return String(count == null ? '' : count).trim() === '0';
      }

      var orange = container.querySelector('.catalog_points_yi .orangeNew');
      if (orange) return String(orange.textContent || '').trim() === '0';
    } catch (e) { /* ... */ }
    return null;
  }

  /* 看得见吗（只查行内样式，不引 getComputedStyle，测试环境里不依赖那么重） */
  function visible(el) {
    if (!el) return false;
    try {
      if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
      var p = el;
      for (var n = 0; n < 4 && p; n++, p = p.parentNode) {
        if (p.style && (p.style.display === 'none' || p.style.visibility === 'hidden')) return false;
      }
    } catch (e) { /* ... */ }
    return true;
  }

  /* 新版课程树是 [onclick^="getTeacherAjax"] 的链接列表；把节点和完成态
     一次性读成普通数组，后面的 pickNext 就不用再关心页面结构。 */
  function readModernCatalog(doc) {
    var rows = [];
    var nodes = doc.querySelectorAll('[onclick^="getTeacherAjax"]');
    for (var i = 0; i < nodes.length; i++) {
      var link = nodes[i];
      var id = chapterIdFromOnclick(link);
      if (!id) continue;
      var label = link.querySelector ? (link.querySelector('.posCatalog_name') || link) : link;
      rows.push({
        el: link,
        host: link.parentNode,
        a: link,
        id: id,
        text: txt(label, 50),
        finish: modernFinished(link.parentNode)
      });
    }
    return rows;
  }

  /* 「当前章节还有任务点未完成」那个弹窗：能点掉就点掉，最后把 #workpop 藏起来 */
  function dismissUnfinishedDialog(doc) {
    if (!doc || !doc.querySelectorAll) return false;
    var pops = doc.querySelectorAll('#workpop, .jobFinishTip, .maskDiv');
    var hit = false;
    /* 必须先把「下一节」点掉再藏 #workpop —— 先藏的话，里面的 .jobFinishTip
       会因为祖先 display:none 被 visible() 判成不可见，反而永远点不到。 */
    for (var i = 0; i < pops.length && !hit; i++) {
      var pop = pops[i];
      if (pop.id === 'workpop') continue;
      var t = txt(pop, 120);
      if (t.indexOf('任务点未完成') < 0 && t.indexOf('还有任务点') < 0) continue;
      if (!visible(pop)) continue;
      var cand = pop.querySelectorAll('a, button');
      for (var j = 0; j < cand.length; j++) {
        var _t = String(cand[j].textContent || '').replace(/\s+/g, '');
        if ((_t === '去学习' || _t === '下一节') && visible(cand[j])) {
          clickEl(cand[j]);
          hit = true;
          break;
        }
      }
    }
    var wp = null;
    try { wp = doc.getElementById ? doc.getElementById('workpop') : null; } catch (e) { /* ... */ }
    if (wp) { try { wp.style.display = 'none'; } catch (e2) { /* ... */ } }
    return hit;
  }

  /* ------------------------------------------------------------------ 扫描 */
  /* 只读：把这一页有什么全都读出来。诊断按钮和流水线都用它，所以它绝不能点东西。*/
  function scan(doc) {
    doc = doc || root.document;
    var out = {
      chapters: [], tabs: [], points: [], cur: '',
      modern: [], modernMode: false, curId: '', courseId: '', clazzId: '',
      url: String(root.location && root.location.href || '')
    };
    var i, n, p;

    /* 未完成的章节：.jobCount，它的父级里有一个 <a>，点它就能进那一章 */
    var jc = doc.querySelectorAll('.jobCount');
    var seenHost = [];
    for (i = 0; i < jc.length; i++) {
      var box = jc[i], host = box.parentNode, a = null;
      for (n = 0, p = box.parentNode; n < 3 && p; n++, p = p.parentNode) {
        if (seenHost.indexOf(p) >= 0) break;
        if (p.querySelector) { a = p.querySelector('a'); if (a) { host = p; break; } }
      }
      if (host && seenHost.indexOf(host) >= 0) continue;   // 同一个 h4 里多个 .jobCount 别重复算
      if (host) seenHost.push(host);
      out.chapters.push({ el: box, host: host, a: a, text: txt(host, 50) });
    }

    /* 新版课程树优先：认出来就只用这一套，避免和新版、旧版选择器混在一起。 */
    var modernRows = readModernCatalog(doc);
    if (modernRows.length) {
      out.modern = modernRows;
      out.modernMode = true;
      out.chapters = modernRows;
    }

    var cur = doc.querySelector('h3.currents, h4.currents, h5.currents, .posCatalog_active');
    if (cur) {
      var cn = cur.querySelector ? (cur.querySelector('.posCatalog_name') || cur) : cur;
      out.cur = txt(cn, 60);
    }
    out.curId = byId(doc, 'curChapterId');
    out.courseId = byId(doc, 'curCourseId');
    out.clazzId = byId(doc, 'curClazzId');

    /* 同一章内的任务点标签。先找旧版 .tabtags，再退回新版 #prev_tab。 */
    var TAB_SELECTORS = ['.tabtags span', '#prev_tab .prev_ul li'];
    for (var ti = 0; ti < TAB_SELECTORS.length && !out.tabs.length; ti++) {
      var tabNodes = doc.querySelectorAll(TAB_SELECTORS[ti]);
      for (i = 0; i < tabNodes.length; i++) {
        out.tabs.push({
          el: tabNodes[i],
          text: txt(tabNodes[i], 30),
          cls: String(tabNodes[i].className || '')
        });
      }
    }

    /* 任务点 iframe */
    var ifr = doc.querySelectorAll('iframe');
    for (i = 0; i < ifr.length; i++) {
      var f = ifr[i], bx = null;
      for (n = 0, p = f.parentNode; n < 3 && p; n++, p = p.parentNode) {
        var tag = String(p.tagName || '').toUpperCase();
        if (tag === 'BODY' || tag === 'HTML') break;   // 别一路摸到 body——那会把所有任务点算成同一个框
        if (p.querySelector && p.querySelector('.ans-job-icon')) { bx = p; break; }
      }
      if (!bx) continue;
      var url = srcOf(f);
      out.points.push({
        el: f, box: bx, url: url, type: moduleType(url),
        finish: hasCls(bx, 'ans-job-finished'),
        text: txt(bx, 50)
      });
    }
    return out;
  }

  /* 这一页看起来是「课程学习页」吗（有课程树或任务点）？ */
  function looksLikeCoursePage(s) {
    return !!(s && (s.chapters.length || s.tabs.length || s.points.length));
  }

  /* ------------------------------------------------- 进度记录（防死循环） */
  /* sessionStorage 在同源框架间共享，正好用来跨页记住「这一轮已经试过哪些任务点」*/
  var K_ROUND = 'ftk_pipe_round', K_TRIED = 'ftk_pipe_tried';
  var K_FAILED = 'ftk_pipe_failed', K_REWORK = 'ftk_pipe_rework';
  /* 自动翻页总次数：正常课程远达不到；只在平台把「下一节」做成
     无限循环/每次换一个地址时兜底，保证一定停得下来。 */
  var K_NAV = 'ftk_pipe_nav', NAV_MAX = 500;

  function ssGet(k, d) { try { var v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ... */ } }

  function getRound() { return ssGet(K_ROUND, 0) || 0; }
  function bumpRound() { var n = getRound() + 1; ssSet(K_ROUND, n); return n; }
  function resetRound() {
    ssSet(K_ROUND, 0); ssSet(K_TRIED, []); ssSet(K_FAILED, []);
    ssSet(K_REWORK, 0); ssSet(K_NAV, 0);
  }
  function getTried() { var t = ssGet(K_TRIED, []); return Object.prototype.toString.call(t) === '[object Array]' ? t : []; }
  function markTried(url) {
    var t = getTried();
    if (url && t.indexOf(url) < 0) { t.push(url); if (t.length > 80) t = t.slice(-80); ssSet(K_TRIED, t); }
  }
  function triedBefore(url) { return !!url && getTried().indexOf(url) >= 0; }
  function triedCount() { return getTried().length; }

  /* 交卷没及格的测验单独记一笔：这类任务点再做一遍大概率还是不过
     （要么题库就是错的，要么题目本身判分严），先跳过、别原地打转。 */
  function getFailed() {
    var t = ssGet(K_FAILED, []);
    return Object.prototype.toString.call(t) === '[object Array]' ? t : [];
  }
  function markFailed(url) {
    var t = getFailed();
    if (url && t.indexOf(url) < 0) { t.push(url); if (t.length > 80) t = t.slice(-80); ssSet(K_FAILED, t); }
  }
  function failedBefore(url) { return !!url && getFailed().indexOf(url) >= 0; }
  function failedList() { return getFailed(); }

  /* 「重做」的总次数上限：做题框架每次重载都会重新注入脚本，
     只靠每一处地址的 key 挡不住地址每次都变一点的情况，所以再加一道总闸。 */
  function reworkCount() { return ssGet(K_REWORK, 0) || 0; }
  function bumpRework() { var n = reworkCount() + 1; ssSet(K_REWORK, n); return n; }

  /* 每次真正点「下一节/切章节」前加一。到上限就由 main.js 自动停，
     不靠「地址不重复」这种平台可能钻空子的假设。 */
  function navCount() { return ssGet(K_NAV, 0) || 0; }
  function bumpNav() { var n = navCount() + 1; ssSet(K_NAV, n); return n; }

  /* --------------------------------------------------- 最外层框架的服务 */
  function clickEl(el) {
    if (!el) return false;
    try { el.click(); return true; } catch (e) { /* 退回派发事件 */ }
    try {
      var Ev = root.MouseEvent || root.Event;
      el.dispatchEvent(new Ev('click', { bubbles: true, cancelable: true, view: root }));
      return true;
    } catch (e2) { return false; }
  }

  /* 任务点 iframe 与任务点标签不是严格一一对应：iframe 里可能夹着没有标签的附件，
     标签里也可能混进「统计 / 讨论」之类的页签。直接拿 s.tabs[i] 会在这种页面上
     点到隔壁任务点（线上事故：点「章节测验」却切到视频）。
     所以分三步对，宁可退回点任务点方框里的链接，也不乱点：
       ① 两边数量相同 —— 位置就是对应关系（最常见，最可靠）
       ② 数量不同 —— 先按标题文字匹配（一方包含另一方即可）
       ③ 还不行 —— 按「第几个同类型任务点」对，且只在同类型标签数
          与同类型任务点数一致时才敢用 */
  function tabWords(type) {
    if (type === 'video' || type === 'audio') return ['视频', '音频'];
    if (type === 'work') return ['测验', '作业', '测试'];
    if (type === 'ppt') return ['ppt', '幻灯片'];
    if (type === 'pdf' || type === 'doc') return ['文档', 'pdf'];
    if (type === 'book') return ['图书', '教材', 'book'];
    return [];
  }
  function tabClean(t) { return String(t || '').replace(/\s+/g, '').toLowerCase(); }
  function tabTypeMatch(tab, type) {
    var words = tabWords(type), t = tabClean(tab && tab.text), i;
    if (!t) return false;
    for (i = 0; i < words.length; i++) if (t.indexOf(words[i]) >= 0) return true;
    return false;
  }
  function pickTabFor(s, i, p) {
    var tabs = s.tabs || [], pts = s.points || [], j;
    if (!tabs.length || !p) return null;
    if (tabs.length === pts.length) return tabs[i] || null;

    var want = tabClean(p.text);
    if (want) {
      for (j = 0; j < tabs.length; j++) {
        var have = tabClean(tabs[j] && tabs[j].text);
        if (have && (have.indexOf(want) >= 0 || want.indexOf(have) >= 0)) return tabs[j];
      }
    }

    var same = [], samePts = 0, idx = 0;
    for (j = 0; j < tabs.length; j++) {
      if (tabs[j] && tabTypeMatch(tabs[j], p.type)) same.push(tabs[j]);
    }
    for (j = 0; j < pts.length; j++) {
      if (pts[j] && pts[j].type === p.type) samePts++;
    }
    if (same.length !== samePts) return null;      // 对不齐就别赌，交给方框里的链接
    for (j = 0; j < i; j++) {
      if (pts[j] && pts[j].type === p.type) idx++;
    }
    return same[idx] || null;
  }

  /* 在扫描结果里挑出「下一个该做的动作」 */
  function pickNext(s, opts) {
    opts = opts || {};
    var i, p;

    /* 1) 本章还有没做过的「章节测验」任务点 -> 切开它对应的任务点标签 */
    for (i = 0; i < s.points.length; i++) {
      p = s.points[i];
      if (p.type !== 'work' || p.finish) continue;
      if (triedBefore(p.url) || failedBefore(p.url)) continue;
      var tab = pickTabFor(s, i, p);
      if (tab && tab.el) return { what: 'task', desc: p.text || p.url, click: tab.el };
      /* 没有对应标签就退回点它自己那个框里的链接 */
      var a = p.box && p.box.querySelector ? p.box.querySelector('a') : null;
      if (a) return { what: 'task', desc: p.text || p.url, click: a };
    }

    /* 2) 本章没得做了 -> 进下一个还有未完成任务的章节。
          必须排掉「当前这一章」：它的 .jobCount 还在（本章还有没做完的东西），
          但那些题目我们已经试过一轮了，再点它一次就是原地打转。 */
    if (opts.allowChapter !== false) {
      var curHost = null;
      try { curHost = (root.document.querySelector('h3.currents, h4.currents, h5.currents') || {}).parentNode || null; }
      catch (e) { /* ... */ }
      var curBox = null;
      try { curBox = root.document.querySelector('h3.currents .jobCount, h4.currents .jobCount, h5.currents .jobCount'); }
      catch (e) { /* ... */ }
      /* 先找出「当前这一章」在树里的位置：只允许往后走，绝不回头。
         用户手动点走的那一章就是新的起点（他在哪，就从哪做到底）。 */
      var curIdx = -1;
      for (i = 0; i < s.chapters.length; i++) {
        var cc = s.chapters[i];
        if (curBox && cc.el === curBox) { curIdx = i; break; }
        if (s.modernMode && s.curId && cc.id === s.curId) { curIdx = i; break; }
      }
      for (i = 0; i < s.chapters.length; i++) {
        var ch = s.chapters[i];
        if (!ch.a) continue;
        if (curIdx >= 0 && i <= curIdx) continue;     // 已经在它后面了才算「下一个」
        if (curBox && ch.el === curBox) continue;                     // 老版：就是当前这一章，跳过
        if (s.modernMode && s.curId && ch.id === s.curId) continue;   // 新版：同上
        if (s.modernMode && ch.finish === true) continue;             // 新版看得出这章做完了
        var jump = (ch.id && s.courseId && s.clazzId)
          ? { courseId: s.courseId, clazzId: s.clazzId, chapterId: ch.id } : null;
        return { what: 'chapter', desc: ch.text, click: ch.a, jump: jump };
      }
      /* 只剩当前这一章挂着 .jobCount：说明本章确实还有没做完的，但能做的我们都试过了 */
      if (curBox) {
        return {
          what: 'stuck',
          desc: s.cur,
          why: '当前这一章还标着「有未完成的任务点」，但其中的章节测验都已经试过一轮了。' +
               '要么是别的类型（视频/文档）没做完，要么是刚才那几次其实没交上。'
        };
      }
    }
    return null;
  }

  /* 切章时优先走页面自己的 getTeacherAjax；没有这个入口，或者调用失败，
     再退回点击章节链接。两条路都只做「切过去」，不在这里答题。 */
  function goToChapter(act) {
    if (!act) return 'click';
    if (act.jump && typeof root.getTeacherAjax === 'function') {
      try {
        root.getTeacherAjax(act.jump.courseId, act.jump.clazzId, act.jump.chapterId);
        return 'getTeacherAjax';
      } catch (e) { /* 页面入口不可用时走点击 */ }
    }
    clickEl(act.click);
    return 'click';
  }

  /* 装在最外层框架上：给里面的答题框架调用 */
  function installAdvance(ctx) {
    var log = (ctx && ctx.log) || function () { };
    var api = {
      version: (ctx && ctx.version) || '',
      last: null,
      scan: function () { return scan(); },
      /* 返回 {ok, what, desc, why}；只点「章节测验」相关的元素，绝不动视频和考试 */
      next: function (opts) {
        var s = scan();
        if (!looksLikeCoursePage(s)) {
          api.last = { ok: false, why: '这一页没有课程树/任务点（拿不到「下一节」的位置）' };
          log(api.last.why, 'warn');
          return api.last;
        }
        var act = pickNext(s, opts);
        if (!act) {
          var left = 0;
          for (var i = 0; i < s.points.length; i++) if (s.points[i].type === 'work' && !s.points[i].finish) left++;
          api.last = {
            ok: false,
            why: left ? ('本章还有 ' + left + ' 个没做完的章节测验，但前面都试过一轮了（防止死循环，先停下）')
                      : '没有找到还没完成的章节测验了'
          };
          log(api.last.why, 'warn');
          return api.last;
        }
        if (act.what === 'stuck') {
          api.last = { ok: false, why: act.why, what: 'stuck' };
          log(act.why, 'warn');
          return api.last;
        }
        /* 换章：页面入口优先，点击兜底。 */
        var how = goToChapter(act);
        /* 换章时超星常弹「当前章节还有任务点未完成」，顺手点掉里面的「下一节」 */
        if (act.what === 'chapter') dismissUnfinishedDialog(root.document);
        api.last = { ok: true, what: act.what, desc: act.desc, how: how };
        log('切到' + (act.what === 'task' ? '下一个任务点：' : '下一章：') + act.desc, 'ok');
        return api.last;
      }
    };
    try { root.__ftkAdvance = api; } catch (e) { /* ... */ }
    /* 跨框架通道：window 上的属性在篡改猴沙箱里各层不是同一个对象，
       必须同时登记进 DOM 登记表（xframe.js），子框架才拿得到。 */
    try {
      var XA = root.FreeTikuX;
      if (XA && XA.set) XA.set('advance', api);
    } catch (e2) { /* ... */ }
    return api;
  }

  /* --------------------------------------------------- 答题框架里的调用 */
  function topWin() {
    try {
      if (root.top && root.top !== root && root.top.document) return root.top;
    } catch (e) { /* 跨域 */ }
    return null;
  }

  function advance(ctx) {
    var log = (ctx && ctx.log) || function () { };
    var max = (ctx && ctx.maxRounds) || 40;
    var n = bumpRound();
    if (n > max) {
      log('流水线已经跑了 ' + max + ' 轮，自动停下（防止无限刷）。点「重置轮数」可以继续。', 'err');
      return { ok: false, why: '轮数上限' };
    }
    markTried(String(root.location && root.location.href || ''));
    var t = topWin();
    var ax = null;
    try {
      var XB = root.FreeTikuX;
      if (XB && XB.get) ax = XB.get('advance');
    } catch (e) { ax = null; }
    if (!ax) ax = (t && t.__ftkAdvance) || null;
    if (!ax || typeof ax.next !== 'function') {
      log('这一页外面没有课程树（或跨域拿不到），没法自动切下一个。请手动点下一节。', 'warn');
      return { ok: false, why: '外面没有课程树服务' };
    }
    var r = ax.next({ allowChapter: (ctx && ctx.allowChapter) !== false });
    if (r && r.ok) log('第 ' + n + ' 轮：已让外层页面切过去。', 'ok');
    return r;
  }

  /* ------------------------------------------------------------- 诊断文本 */
  function report(s) {
    s = s || scan();
    var L = [];
    L.push('当前页：' + s.url);
    L.push('当前章节：' + (s.cur || '(读不到 h3/h4/h5.currents)'));
    L.push('任务点标签 .tabtags span：' + s.tabs.length + ' 个' +
           (s.tabs.length ? '　[' + s.tabs.map(function (t) { return t.text || '(空)'; }).join(' | ') + ']' : ''));
    L.push('任务点 iframe：' + s.points.length + ' 个' +
           (s.points.length ? '' : '　（一个都没认出来，可能这一页不是课程学习页）'));
    s.points.forEach(function (p, i) {
      L.push('  #' + (i + 1) + ' ' + typeCN(p.type) + (p.finish ? ' [已完成]' : ' [未完成]') +
             '　' + (p.text || '').slice(0, 30) +
             (p.type === 'work' && !p.finish && triedBefore(p.url) ? '　(已试过)' : ''));
    });
    L.push(s.modernMode
      ? ('课程树（新版 .posCatalog）：' + s.chapters.length + ' 章　当前章 id=' + (s.curId || '?') +
         (s.curId ? '' : '　⚠ 读不到 #curChapterId'))
      : ('未完成章节 .jobCount：' + s.chapters.length + ' 个' +
         (s.chapters.length ? '' : '　（没有未完成章节，或这一页不是课程学习页）')));
    s.chapters.slice(0, 6).forEach(function (c) {
      L.push('  · ' + (c.text || '(空)') + (c.a ? '' : '　⚠ 找不到可点的 <a>'));
    });
    L.push('已跑轮数：' + getRound() + '　记过的任务点：' + getTried().length +
           ' 个　自动翻页：' + navCount() + '/' + NAV_MAX + ' 次');
    return L.join('\n');
  }

  root.FreeTikuPipeline = {
    moduleType: moduleType,
    typeCN: typeCN,
    scan: scan,
    pickNext: pickNext,
    installAdvance: installAdvance,
    advance: advance,
    topWin: topWin,
    report: report,
    getRound: getRound,
    resetRound: resetRound,
    markTried: markTried,
    triedBefore: triedBefore,
    triedCount: triedCount,
    markFailed: markFailed,
    failedBefore: failedBefore,
    failedList: failedList,
    reworkCount: reworkCount,
    bumpRework: bumpRework,
    navCount: navCount,
    bumpNav: bumpNav,
    NAV_MAX: NAV_MAX,
    chapterIdFromOnclick: chapterIdFromOnclick,
    modernFinished: modernFinished,
    dismissUnfinishedDialog: dismissUnfinishedDialog
  };
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot
   : (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window));

/* ======================== video.js ======================== */
/* ============================================================================
 *  video.js —— 视频 / 音频任务点驱动器
 *
 *  这是本项目自己的实现。它只依赖页面里已经存在的媒体元素和任务点标记：
 *    · 任务点容器从 DOM 关系里找，不假设固定的 iframe 层级；
 *    · 是否完成以任务点标记为准，而不是以 <video> 的 ended 为准；
 *    · 播放期间把 playbackRate 固定住，最后几秒回到 1x 补齐观看时长；
 *    · 本地放完但任务点没变绿时，从头重播，次数有上限。
 *
 *  这样写是为了让播放器升级、页面换版式时，坏掉的只是选择器，而不是
 *  整个流程；测试也可以只给 DOM 和假时钟，不需要真实浏览器。
 * ==========================================================================*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); }
  else { root.FreeTikuVideo = factory(root); }
})(typeof __ftkRoot !== 'undefined' ? __ftkRoot
  : (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window), function (root) {
    'use strict';

    var WATCHDOG_SEC = 5;            // 多久检查一次「还在播吗 / 任务点绿了吗」
    var NOBOX_GIVEUP_SEC = 60;       // 一直找不到任务点容器时，最多等这么久
    var PAUSE_HINT_AT = 3;           // 连续几次发现暂停后提醒一次
    var ENDED_CONFIRM_SEC = 15;      // 本地播完后，等任务点变绿的宽限时间
    var MAX_REPLAY = 2;              // 任务点没绿时最多从头重播几次
    var RESTORE_LAST_SEC = 10;       // 最后 10 秒回到 1x
    var QUIZ_HIDE_SEC = 2;           // 视频弹题的扫描间隔
    var MAX_RATE = 16;               // 倍速上限
    var HARD_CAP_SEC = 45 * 60;      // 单节任务最长盯 45 分钟

    var state = {
      running: false,
      stopped: false,
      kind: '',
      rate: 1,
      replays: 0,
      done: false,
      why: '',
      startedAt: 0,
      promise: null,
      media: null,
      timers: [],
      observer: null,
      quizLogged: false,
      resolve: null
    };

    function noop() { }

    function className(el) {
      return ' ' + String((el && el.className) || '') + ' ';
    }

    function clampRate(v) {
      v = Number(v);
      if (!v || isNaN(v) || v <= 0) return 2;
      return Math.max(0.5, Math.min(MAX_RATE, v));
    }

    function findMedia(doc, kind) {
      try { return doc.documentElement.querySelector(kind); } catch (e) { return null; }
    }

    /* 播放器把倍速菜单删空，通常表示这一节不允许改速。 */
    function rateDisabled(doc) {
      try {
        return doc.querySelectorAll('.vjs-playback-rate .vjs-menu-content .vjs-menu-item').length === 0;
      } catch (e) {
        return false;
      }
    }

    /* 任务点容器可能叫 .ans-attach-ct，也可能只是带 .ans-job-icon 的普通框。 */
    function isTaskBox(el) {
      if (!el) return false;
      var c = className(el);
      if (/ans-attach-ct|ans-job-finished|ans-attach-online|icon_Completed/.test(c)) return true;
      if (/ans-attach|ans-job|task/i.test(c) && typeof el.querySelector === 'function') {
        try { return !!el.querySelector('.ans-job-icon'); } catch (e) { }
      }
      return false;
    }

    /* 先看媒体自己的祖先，再看当前框架 iframe 的父级链。
       媒体在播放器 iframe 里、任务点在外层时，第二种关系才是有效的。 */
    function mediaTaskBox(win, media) {
      win = win || root;

      var node = media;
      for (var depth = 0; node && depth < 8; depth++, node = node.parentElement) {
        if (isTaskBox(node)) return node;
      }

      try {
        var frame = win.frameElement;
        if (frame && frame.parentElement) {
          var cur = frame.parentElement;
          for (var up = 0; cur && up < 10; up++, cur = cur.parentElement) {
            var ownerDoc = cur.ownerDocument;
            if (ownerDoc && cur === ownerDoc.body) break;
            if (isTaskBox(cur)) return cur;
          }
        }
      } catch (e) { /* 跨域读不到 frameElement 时，只能放弃这一种关系 */ }

      return null;
    }

    /* 把 playbackRate 换成一个只读属性。页面自己的播放器仍会尝试写它，
       但写入会被忽略；unlockRate 再把这层属性删掉，交还给原生实现。 */
    function lockRate(media, rate) {
      try { delete media.playbackRate; } catch (e) { }
      try { media.playbackRate = rate; } catch (e) { }
      try {
        Object.defineProperty(media, 'playbackRate', {
          configurable: true,
          get: function () { return rate; },
          set: function () { }
        });
      } catch (e) { }
      return rate;
    }

    function unlockRate(media) {
      try { delete media.playbackRate; } catch (e) { }
    }

    function hideVideoQuiz(doc) {
      var hit = 0;
      try {
        var style = doc.getElementById('ftk-video-quiz-hide');
        if (!style) {
          style = doc.createElement('style');
          style.id = 'ftk-video-quiz-hide';
          style.textContent = '.ans-timelineobjects,.ans-timelineobjectsbg{display:none!important}';
          var host = doc.head || doc.documentElement;
          if (host) { host.appendChild(style); hit++; }
        }
        var overlay = doc.querySelector('.ans-timelineobjects');
        if (overlay && overlay.offsetParent !== null) { overlay.style.display = 'none'; hit++; }
        var backdrop = doc.querySelector('.ans-timelineobjectsbg');
        if (backdrop && backdrop.offsetParent !== null) { backdrop.style.display = 'none'; hit++; }
      } catch (e) { }
      return hit;
    }

    function detect(doc) {
      doc = doc || root.document;
      if (!doc) return null;
      var media = findMedia(doc, 'video');
      var kind = 'video';
      if (!media) {
        media = findMedia(doc, 'audio');
        kind = 'audio';
      }
      if (!media) return null;
      return { kind: kind, media: media };
    }

    /* 当前媒体所属的任务点容器。iframe 的父级链是视频模块最常见的结构；
       顶层页面则只在整页确实只有一个任务点时，才用 .ans-job-icon 兜底。 */
    function taskBox(win) {
      win = win || root;

      try {
        var frame = win.frameElement;
        if (frame && frame.parentElement) {
          var cur = frame.parentElement;
          for (var up = 0; cur && up < 10; up++, cur = cur.parentElement) {
            var ownerDoc = cur.ownerDocument;
            if (ownerDoc && cur === ownerDoc.body) break;
            if (isTaskBox(cur)) return cur;
          }
          /* 老页面可能没有 ans-* 标记，仍返回最近的父级，保留旧的完成检查。 */
          return frame.parentElement;
        }
      } catch (e) { }

      try {
        var top = win.top;
        if (top && top.document && top.document !== win.document) {
          var icons = top.document.querySelectorAll('.ans-job-icon');
          if (icons.length === 1) return icons[0].parentElement;
        }
      } catch (e2) { }

      return null;
    }

    /* 完成标记必须属于当前任务点。一个外层大框里可能还装着别的任务点，
       不能因为子孙里出现绿标就把当前媒体也判成完成。 */
    function hasOwnFinished(box) {
      try {
        var marks = box.querySelectorAll('.ans-job-finished, .icon_Completed');
        for (var i = 0; i < marks.length; i++) {
          var cur = marks[i].parentElement;
          while (cur && cur !== box) {
            if (isTaskBox(cur)) break;
            cur = cur.parentElement;
          }
          if (cur === box) return true;
        }
      } catch (e) { }
      return false;
    }

    function isFinished(box) {
      try {
        var cur = box;
        for (var up = 0; cur && up < 10; up++, cur = cur.parentElement) {
          var c = className(cur);
          if (/ans-job-finished|icon_Completed/.test(c)) return true;
          try {
            if (cur.classList && (cur.classList.contains('ans-job-finished') || cur.classList.contains('icon_Completed'))) return true;
          } catch (eClass) { }
        }
        if (box && box.querySelector && hasOwnFinished(box)) return true;
      } catch (e) { }
      return false;
    }

    /* ---------------------------------------------------------- 可见性 / 排序 */
    function shown(el) {
      try {
        if (!el) return false;
        var win = el.ownerDocument && el.ownerDocument.defaultView;
        var cs = win && win.getComputedStyle ? win.getComputedStyle(el, null) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
        if (!el.getBoundingClientRect) return true;
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
      } catch (e) {
        return true;
      }
    }

    function docShown(doc) {
      try {
        var win = doc && doc.defaultView;
        var frame = win && win.frameElement;
        if (frame && !shown(frame)) return false;
        return true;
      } catch (e) {
        return false;
      }
    }

    /* 任务点可能在不同 iframe 里，坐标要逐层加上 iframe 的位置才能比较。 */
    function positionOf(el) {
      var top = 0, left = 0;
      try {
        var r = el.getBoundingClientRect();
        top = Number(r && r.top) || 0;
        left = Number(r && r.left) || 0;
      } catch (e) { }

      try {
        var doc = el.ownerDocument;
        var win = doc && doc.defaultView;
        var topWin = null;
        try { topWin = root.top; } catch (eTop) { topWin = null; }
        for (var up = 0; win && win !== topWin && up < 8; up++) {
          var frame = win.frameElement;
          if (!frame) break;
          var fr = frame.getBoundingClientRect();
          top += Number(fr && fr.top) || 0;
          left += Number(fr && fr.left) || 0;
          try { win = win.parent; } catch (eParent) { break; }
        }
      } catch (e2) { }

      return { top: top, left: left };
    }

    function taskRecord(win, media) {
      try {
        var box = mediaTaskBox(win || root, media);
        if (box) return { box: box, finished: isFinished(box) };

        var href = '';
        try { href = String((win && win.location && win.location.href) || ''); } catch (eUrl) { href = ''; }
        if (/\/ananas\/modules\/(video|audio)\//.test(href)) {
          var fallback = taskBox(win || root);
          return { box: fallback, finished: fallback ? isFinished(fallback) : false };
        }

        var node = media;
        for (var up = 0; node && up < 8; up++, node = node.parentElement) {
          var c = className(node);
          if (node.id === 'reader' || /video-js|vjs-tech/.test(c)) {
            var playerBox = taskBox(win || root);
            return playerBox ? { box: playerBox, finished: isFinished(playerBox) } : null;
          }
        }
      } catch (e) { }
      return null;
    }

    function mediaFrames() {
      try {
        var X = root.FreeTikuX;
        var list = X && X.frames ? X.frames(null, 3) : null;
        if (list && list.length) return list;
      } catch (e) { }
      return [{ win: root, doc: root.document }];
    }

    /* 同一页可能并排放多个视频。按页面坐标从上到下、从左到右排，
       只让最上面那个未完成任务点开播，避免几个播放器互相暂停。 */
    function orderedTasks() {
      var frames = mediaFrames();
      var out = [];
      var seenBox = [];
      var seenMedia = [];

      for (var fi = 0; fi < frames.length; fi++) {
        var frame = frames[fi] || {};
        var doc = frame.doc || null;
        if (!doc) {
          try { doc = frame.win && frame.win.document; } catch (eDoc) { doc = null; }
        }
        if (!doc || !doc.querySelectorAll || !docShown(doc)) continue;

        var list = null;
        try { list = doc.querySelectorAll('video, audio'); } catch (eList) { list = null; }
        if (!list) continue;

        for (var mi = 0; mi < list.length; mi++) {
          var media = list[mi];
          var win = frame.win || root;
          var task = taskRecord(win, media);
          if (!task || task.finished) continue;
          if (!shown(task.box || media)) continue;

          if (task.box) {
            if (seenBox.indexOf(task.box) >= 0) continue;
            seenBox.push(task.box);
          } else {
            if (seenMedia.indexOf(media) >= 0) continue;
            seenMedia.push(media);
          }

          var pos = positionOf(task.box || media);
          out.push({
            win: win,
            doc: doc,
            media: media,
            box: task.box,
            kind: media.tagName === 'AUDIO' ? 'audio' : 'video',
            top: pos.top,
            left: pos.left,
            frameIndex: fi,
            mediaIndex: mi
          });
        }
      }

      out.sort(function (a, b) {
        return (a.top - b.top) || (a.left - b.left) ||
          (a.frameIndex - b.frameIndex) || (a.mediaIndex - b.mediaIndex);
      });
      return out;
    }

    function firstUnfinishedTask() {
      var list = orderedTasks();
      return list.length ? list[0] : null;
    }

    function isFirstUnfinished(win, media) {
      try {
        if (!media) return false;
        var list = orderedTasks();
        if (!list.length) return true;
        var task = taskRecord(win || root, media);
        if (!task) return true;
        if (list[0].box && task.box) return list[0].box === task.box;
        return list[0].media === media;
      } catch (e) {
        return true;
      }
    }

    function stop(reason, internal) {
      /* stopped 是用户停止的总闸：pause 监听不能再 resume，playing 监听
         也不再锁倍速。定时器和观察者一起清掉，播放器完全交还给用户。 */
      state.stopped = true;
      if (state.timers) {
        state.timers.forEach(function (timer) { try { clearInterval(timer); } catch (e) { } });
        state.timers = [];
      }
      if (state.observer) {
        try { state.observer.disconnect(); } catch (e) { }
        state.observer = null;
      }
      if (state.media) {
        try { unlockRate(state.media); } catch (e) { }
        try { state.media.pause(); } catch (e) { }
      }
      state.running = false;
      if (!internal && typeof state.resolve === 'function') {
        var finish = state.resolve;
        state.resolve = null;
        try { finish(false, reason || '用户停止'); } catch (e2) { }
      }
    }

    function drive(doc, opts) {
      opts = opts || {};
      var log = opts.log || noop;
      if (state.running) return state.promise;
      doc = doc || root.document;

      /* 已经完成的任务点不要再播：有些「暂无内容」页面仍保留旧播放器，
         重新播它会让流水线一直等一个永远不会完成的任务。 */
      try {
        var preBox = taskBox(root);
        if (preBox && isFinished(preBox)) {
          log('这个任务点已经完成了，不用再播。', 'dim');
          return Promise.resolve({ done: true, why: '任务点早就完成了', replays: 0, kind: 'none' });
        }
      } catch (ePre) { }

      var found = detect(doc);
      if (!found) return Promise.resolve({ done: false, why: '没找到 video/audio 元素' });

      var media = found.media;
      var rate = clampRate(opts.rate);
      /* 音频任务点没有 video.js 的倍速菜单，不能因为查不到菜单就误判成
         平台禁速，否则音频会被错误地压回 1x。 */
      if (rate > 1 && found.kind === 'video' && rateDisabled(doc)) {
        log('学习通这一节把倍速菜单去掉了，只能按 1x 播（硬改倍速会让任务点完不成）。', 'warn');
        rate = 1;
      }

      state.running = true;
      state.stopped = false;
      state.kind = found.kind;
      state.rate = rate;
      state.done = false;
      state.why = '';
      state.replays = 0;
      state.quizLogged = false;
      state.startedAt = Date.now();
      state.media = media;
      state.timers = [];
      state.observer = null;
      state.resolve = null;

      log('发现一个' + (found.kind === 'video' ? '视频' : '音频') + '，' + rate + 'x 开始播放。'
        + (rate > 2 ? '（提太猛有可能被服务器按「观看时长不足」打回）' : ''));

      state.promise = new Promise(function (resolve) {
        var box = taskBox(root);
        var isResolved = false;
        var hasEnded = false;
        var speedRestored = false;
        var pausedChecks = 0;
        var isResuming = false;

        function finish(done, why) {
          if (isResolved) return;
          isResolved = true;
          state.done = done;
          state.why = why || '';
          state.resolve = null;
          stop('', true);
          var userStop = !done && /用户停止/.test(why || '');
          var label = state.kind === 'video' ? '视频' : '音频';
          log(done ? ('任务点已完成（' + label + '）。')
            : (userStop ? '已停止播放（用户点了停止）。'
              : (label + '没做成：' + (why || '原因不明') + '。')),
            done ? 'ok' : (userStop ? 'dim' : 'warn'));
          resolve({ done: done, why: why || '', replays: state.replays, kind: state.kind });
        }
        state.resolve = finish;

        /* 找不到任务点标记时不能无限等，否则整条流水线会卡在空页面上。 */
        var noBoxSince = Date.now();
        var noBoxTimer = setInterval(function () {
          if (state.stopped || isResolved) { clearInterval(noBoxTimer); return; }
          if (taskBox(root)) { noBoxSince = Date.now(); return; }
          if (Date.now() - noBoxSince > NOBOX_GIVEUP_SEC * 1000) {
            clearInterval(noBoxTimer);
            finish(false, '找不到任务点标记（等了 ' + NOBOX_GIVEUP_SEC + ' 秒），先往下走');
          }
        }, 3000);
        state.timers.push(noBoxTimer);

        function applyRate(r) {
          lockRate(media, r);
        }

        function playMedia() {
          try {
            media.muted = true;
            var p = media.play();
            if (p && p.catch) p.catch(function () { });
          } catch (e) { }
        }

        function resume() {
          if (state.stopped || hasEnded || isResolved || isResuming) return;
          isResuming = true;
          try { playMedia(); } finally { isResuming = false; }
        }

        function checkFinished() {
          if (state.stopped) return false;
          if (isFinished(box)) {
            try { media.pause(); } catch (e) { }
            finish(true, '任务点已完成');
            return true;
          }
          return false;
        }

        if (box) {
          try {
            state.observer = new MutationObserver(function () { checkFinished(); });
            state.observer.observe(box, { attributes: true, attributeFilter: ['class'], subtree: true });
          } catch (e) { /* 没有 MutationObserver 就靠看门狗 */ }
          if (checkFinished()) return;
        }

        function onEnded() {
          if (state.stopped) return;
          hasEnded = true;
          log('已播放到结尾，等 15 秒看任务点是否完成…');

          var waited = 0;
          var timer = setInterval(function () {
            waited += 0.5;
            if (state.stopped || isResolved) { clearInterval(timer); return; }
            if (checkFinished()) { clearInterval(timer); return; }
            if (waited < ENDED_CONFIRM_SEC) return;

            clearInterval(timer);
            if (state.replays >= MAX_REPLAY) {
              finish(false, '重播了 ' + state.replays + ' 次任务点仍未完成');
              return;
            }

            state.replays++;
            log('本地放完了但任务点没完成，第 ' + state.replays + ' 次从头重播（顺带降回 1x）。', 'warn');
            hasEnded = false;
            speedRestored = true;
            pausedChecks = 0;
            unlockRate(media);
            try { media.currentTime = 0; } catch (e) { }
            media.muted = true;
            playMedia();
          }, 500);
          state.timers.push(timer);
        }

        media.addEventListener('playing', function () {
          if (state.stopped) return;
          pausedChecks = 0;
          applyRate(speedRestored ? 1 : rate);
        });
        media.addEventListener('pause', function () {
          if (state.stopped || media.ended || isResolved) return;
          resume();
        });
        media.addEventListener('ended', onEnded);
        media.addEventListener('timeupdate', function () {
          if (state.stopped || speedRestored || isResolved) return;
          if (media.duration && media.duration - media.currentTime < RESTORE_LAST_SEC) {
            speedRestored = true;
            applyRate(1);
            log('快到结尾了，倍速降回 1x，把剩下的观看时长补齐。');
          }
        });

        var watchdog = setInterval(function () {
          if (state.stopped || isResolved) return;
          if (checkFinished()) return;
          if (Date.now() - state.startedAt > HARD_CAP_SEC * 1000) {
            finish(false, '盯了 ' + Math.round(HARD_CAP_SEC / 60) + ' 分钟还没完成');
            return;
          }
          if (media.paused && !hasEnded) {
            pausedChecks++;
            if (pausedChecks === PAUSE_HINT_AT) log('好像被暂停了，一直在重试播放…（资源加载慢？）', 'warn');
            resume();
          }
        }, WATCHDOG_SEC * 1000);
        state.timers.push(watchdog);

        var quizTimer = setInterval(function () {
          if (state.stopped || isResolved) return;
          var hit = hideVideoQuiz(doc);
          if (hit && !state.quizLogged) {
            state.quizLogged = true;
            log('视频里弹出题目了，先藏起来继续播。', 'dim');
          }
        }, QUIZ_HIDE_SEC * 1000);
        state.timers.push(quizTimer);

        applyRate(rate);
        playMedia();
      });

      return state.promise;
    }

    function status() {
      return {
        running: state.running,
        kind: state.kind,
        rate: state.rate,
        replays: state.replays,
        done: state.done,
        why: state.why
      };
    }

    function report() {
      var s = status();
      var lines = [];
      lines.push('媒体类型：' + (s.kind || '（还没开始）'));
      lines.push('倍速：' + (s.rate || 1) + 'x    重播次数：' + s.replays);
      lines.push('状态：' + (s.running ? '正在播放' : (s.done ? '已完成' : '没在跑')) + (s.why ? '（' + s.why + '）' : ''));
      var box = taskBox(root);
      lines.push('任务点容器：' + (box ? (box.className || '(无 class)') : '找不到（window.frameElement 不可用）'));
      lines.push('任务点已完成：' + (isFinished(box) ? '是' : '否'));
      return lines.join('\n');
    }

    return {
      detect: detect,
      drive: drive,
      stop: stop,
      status: status,
      report: report,
      lockRate: lockRate,
      unlockRate: unlockRate,
      rateDisabled: rateDisabled,
      hideVideoQuiz: hideVideoQuiz,
      taskBox: taskBox,
      isFinished: isFinished,
      isTaskBox: isTaskBox, mediaTaskBox: mediaTaskBox,
      orderedTasks: orderedTasks,
      firstUnfinishedTask: firstUnfinishedTask,
      isFirstUnfinished: isFirstUnfinished,
      clampRate: clampRate,
      findMedia: findMedia,
      _const: {
        WATCHDOG_SEC: WATCHDOG_SEC,
        ENDED_CONFIRM_SEC: ENDED_CONFIRM_SEC,
        MAX_REPLAY: MAX_REPLAY,
        NOBOX_GIVEUP_SEC: NOBOX_GIVEUP_SEC,
        RESTORE_LAST_SEC: RESTORE_LAST_SEC,
        MAX_RATE: MAX_RATE,
        HARD_CAP_SEC: HARD_CAP_SEC
      }
    };
  });

/* ======================== main.js ======================== */
﻿/* ============================================================================
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

})();
