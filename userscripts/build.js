/* build.js —— 把 src/ 下的模块拼成一个可直接安装的 Tampermonkey 用户脚本
 * 用法：node build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const OUT_NAME = '学习小助手.user.js';

// 顺序有讲究：beacon 必须在最前（它只负责报信），core 紧随其后（panel/chaoxing/main 都依赖它）
// video 要在 main 之前（main 开视频时调它）
const FILES = ['beacon.js', 'xframe.js', 'core.js', 'panel.js', 'chaoxing.js', 'pipeline.js', 'video.js', 'main.js'];

function read(f) { return fs.readFileSync(path.join(SRC, f), 'utf8'); }

function main() {
  const header = read('header.txt').trimEnd();
  const parts = FILES.map(f => {
    const code = read(f).trimEnd();
    return '/* ======================== ' + f + ' ======================== */\n' + code;
  });

  const out = [
    header,
    '',
    '/* SPDX-License-Identifier: GPL-3.0-or-later',
    ' * Copyright (C) 2026 FreeTikuHelper contributors',
    ' * This userscript is free software under the GNU GPL v3 or later.',
    ' * See LICENSE and THIRD_PARTY_NOTICES.md in the source repository. */',
    '',
    '(function () {',
    "  'use strict';",
    '',
    '  /* 所有模块共用的挂载对象。',
    '     以前 core.js 挂到 globalThis、其余模块读 unsafeWindow —— 这两者在篡改猴沙箱里',
    '     不一定是同一个对象，一旦不一致，main 就会「模块没挂上」直接 return：',
    '     页面上没有徽标、黑窗口也没有任何回执，正是之前那个「怎么都没有」的样子。',
    '     现在由本构建器统一提供一个，四个模块都挂到它上面。 */',
    '  var __ftkRoot = (typeof window !== "undefined" ? window : globalThis);',
    '  var __ftkStuck = "";',
    '',
    parts.join('\n\n'),
    '',
    '})();',
    ''
  ].join('\n');

  fs.mkdirSync(DIST, { recursive: true });
  const dest = path.join(DIST, OUT_NAME);
  fs.writeFileSync(dest, out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log('已生成：' + path.relative(path.join(__dirname, '..', '..'), dest) + '  (' + kb + ' KB)');
  console.log('模块：' + FILES.join(' + '));
}

main();