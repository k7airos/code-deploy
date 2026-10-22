import stringWidth from "string-width";

const segmenter = new Intl.Segmenter();

// 日志按显示宽度折行（中文占两格）；制表符展开，其余控制字符丢弃，保证行数可预测以便滚动。
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const lines = text.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const rows: string[] = [];
  for (const line of lines) {
    if (stringWidth(line) <= max) { rows.push(line); continue; }
    let row = "";
    let used = 0;
    for (const { segment } of segmenter.segment(line)) {
      const size = stringWidth(segment);
      if (used + size > max && row) { rows.push(row); row = ""; used = 0; }
      row += segment; used += size;
    }
    rows.push(row);
  }
  return rows;
}

// 按显示宽度截断，超出时以省略号结尾。
export function truncate(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = stringWidth(segment);
    if (used + size > width - 1) break;
    out += segment; used += size;
  }
  return `${out}…`;
}

export { stringWidth };
