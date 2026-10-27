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