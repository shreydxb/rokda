// Household notes are plain text with a little markdown: "# " and "## "
// headings, "- " bullets, blank lines between paragraphs, and **bold**.
// Parsed into blocks the screen renders as elements, never as HTML, so a
// note can hold anything without it being run as markup.

// "**bold** and plain" -> [{ text: 'bold', bold: true }, { text: ' and plain', bold: false }]
export function inlineSpans(text) {
  const spans = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index), bold: false });
    spans.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), bold: false });
  return spans;
}

export function parseNote(body = '') {
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', spans: inlineSpans(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: 'ul', items: list });
    list = null;
  };
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'h', level: heading[1].length, spans: inlineSpans(heading[2]) });
    } else if (bullet) {
      flushPara();
      (list ??= []).push(inlineSpans(bullet[1]));
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // An indented line continues the bullet above it.
      const lastItem = list[list.length - 1];
      lastItem.push(...inlineSpans(' ' + line.trim()));
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}
