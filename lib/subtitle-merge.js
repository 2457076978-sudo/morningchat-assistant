/* 字幕分句合并器 v2.0 —— B站字幕行 -> 句（纯函数，UMD，node 可测）
 * 规则：行间空隙 > gapSec 或上一行以句末标点结尾 -> 断句 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.mxMergeSubs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const END_MARK = /[.?!。？！…]$/;
  return function mergeSubs(lines, gapSec) {
    gapSec = gapSec == null ? 0.45 : gapSec;
    const out = [];
    for (const ln of (lines || [])) {
      if (ln == null || typeof ln.from !== 'number') continue;
      const text = (ln.content || '').trim();
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && ln.from - last.end <= gapSec && !END_MARK.test(last.text)) {
        last.end = Math.max(last.end, ln.to || ln.from);
        last.text += ' ' + text;
      } else {
        out.push({ start: ln.from, end: ln.to || ln.from, text: text });
      }
    }
    return out;
  };
});
