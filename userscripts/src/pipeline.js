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