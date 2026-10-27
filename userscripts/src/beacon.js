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