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