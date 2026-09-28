import { describe, it, expect } from 'vitest';
import { inlineSpans, parseNote } from './notes';

describe('inlineSpans', () => {
  it('splits bold from plain text', () => {
    expect(inlineSpans('**Rent** is shared')).toEqual([
      { text: 'Rent', bold: true },
      { text: ' is shared', bold: false },
    ]);
    expect(inlineSpans('no markup')).toEqual([{ text: 'no markup', bold: false }]);
  });
});

describe('parseNote', () => {
  it('reads headings, paragraphs and bullets', () => {
    const blocks = parseNote('# Plan\nFirst line\nsame paragraph\n\n- one\n- **two**\n  continued\n\nAfter');
    expect(blocks.map((b) => b.type)).toEqual(['h', 'p', 'ul', 'p']);
    expect(blocks[0].level).toBe(1);
    expect(blocks[1].spans[0].text).toBe('First line same paragraph');
    expect(blocks[2].items).toHaveLength(2);
    expect(blocks[2].items[1].map((s) => s.text).join('')).toBe('two continued');
  });

  it('keeps markup-looking text as text', () => {
    const [p] = parseNote('<script>alert(1)</script>');
    expect(p.spans[0].text).toBe('<script>alert(1)</script>');
  });

  it('is empty for an empty note', () => {
    expect(parseNote('')).toEqual([]);
  });
});
