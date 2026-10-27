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