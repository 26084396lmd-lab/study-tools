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