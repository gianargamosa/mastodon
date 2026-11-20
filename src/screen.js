// Turns rows of a headless xterm buffer back into ANSI text for the main pane.

function color(isRGB, isPalette, value, base) {
  if (isRGB) return `;${base + 8};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  if (isPalette) {
    if (value < 8) return `;${base + value}`;
    if (value < 16) return `;${base + 60 + value - 8}`;
    return `;${base + 8};5;${value}`;
  }
  return '';
}

function attributes(cell) {
  let codes = '';
  if (cell.isBold()) codes += ';1';
  if (cell.isDim()) codes += ';2';
  if (cell.isItalic()) codes += ';3';
  if (cell.isUnderline()) codes += ';4';
  if (cell.isBlink()) codes += ';5';
  if (cell.isInverse()) codes += ';7';
  if (cell.isInvisible()) codes += ';8';
  if (cell.isStrikethrough()) codes += ';9';
  codes += color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 30);
  codes += color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 40);
  return codes;
}

// Row `y` of the visible screen, `scrollOffset` lines up from the bottom,
// clipped to `cols` cells, with columns `selected.from` to `selected.to`
// (exclusive) shown inverted. The result always ends with attributes reset and
// the rest of the line erased, which also stands in for trailing blanks.
export function renderRow(term, y, cols, scrollOffset = 0, selected = null) {
  const buffer = term.buffer.active;
  const line = buffer.getLine(buffer.baseY - scrollOffset + y);
  let out = '';
  let current = '';
  let used = 0;
  let kept = 0; // where the row's content ends: trailing plain blanks are left to \x1b[K

  if (line) {
    const cell = buffer.getNullCell();
    const limit = Math.min(cols, term.cols);
    for (let x = 0; x < limit; x++) {
      if (!line.getCell(x, cell)) break;
      const w = cell.getWidth();
      if (w === 0) continue; // second half of a wide character
      if (used + w > cols) break;
      const inverted = selected && x >= selected.from && x < selected.to;
      const attrs = attributes(cell) + (inverted ? ';7' : '');
      if (attrs !== current) {
        out += `\x1b[0${attrs}m`;
        current = attrs;
      }
      const chars = cell.getChars();
      out += chars || ' ';
      used += w;
      if ((chars && chars !== ' ') || attrs) kept = out.length;
    }
  }
  return out.slice(0, kept) + '\x1b[0m\x1b[K';
}
