// Small helpers for laying out plain text in fixed-width terminal cells.

export const reset = '\x1b[0m';
export const sgr = (codes, text) => `\x1b[${codes}m${text}${reset}`;

export function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // ZWJ, variation selectors
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function width(text) {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0));
  return w;
}

// Truncate (with an ellipsis) or pad `text` to exactly `cols` cells.
export function fit(text, cols) {
  if (cols <= 0) return '';
  if (width(text) <= cols) return text + ' '.repeat(cols - width(text));
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > cols - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…' + ' '.repeat(cols - 1 - w);
}

// Keep the end of a path visible when it is too long: "…/sites/shop".
export function fitLeft(text, cols) {
  if (width(text) <= cols) return fit(text, cols);
  const chars = [...text];
  let out = '';
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = charWidth(chars[i].codePointAt(0));
    if (w + cw > cols - 1) break;
    out = chars[i] + out;
    w += cw;
  }
  return fit('…' + out, cols);
}
