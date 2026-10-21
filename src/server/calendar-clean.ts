/**
 * Deterministic title cleanup for calendar events (no AI): HTML entities left in the provider's
 * text are decoded and the leading release-type tag Bank of Korea puts in front of its titles
 * ("[보도자료]", "[보도참고자료]") is split off into `releaseType`.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  middot: '·',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
};
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g;
function decodeOnce(value: string) {
  return value.replace(ENTITY, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name] ?? NAMED[name.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? '', 16);
    if (
      !Number.isInteger(code) ||
      code < 32 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return whole;
    return String.fromCodePoint(code);
  });
}
/** Decodes entities (twice, because feeds often double-encode "&amp;#39;"), then drops markup. */
export function decodeEntities(value: string): string {
  let current = value;
  for (let pass = 0; pass < 2; pass++) {
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}
const LEADING_TAGS = /^(?:\s*\[([^\]\n]{1,16})\])+\s*/;
const TAG = /\[([^\]\n]{1,16})\]/g;
export type CleanedTitle = {
  title: string;
  /** Leading release-type tag without brackets ("보도자료"), when the title had one. */
  releaseType?: string;
};
export function cleanTitle(raw: string): CleanedTitle {
  let text = decodeEntities(raw)
    .normalize('NFC')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
  let releaseType: string | undefined;
  const leading = LEADING_TAGS.exec(text);
  if (leading) {
    const tags = [...leading[0].matchAll(TAG)].map((match) => match[1].trim()).filter(Boolean);
    const rest = text.slice(leading[0].length).trim();
    // A title that is only tags keeps them; otherwise the first tag is the release type.
    if (rest && tags.length) {
      releaseType = tags[0];
      text = rest;
    }
  }
  text = text.replace(/\s+/g, ' ').trim();
  return { title: text, ...(releaseType ? { releaseType } : {}) };
}
/** True when the title still needs deterministic cleanup. */
export const needsCleanup = (title: string) => {
  const cleaned = cleanTitle(title);
  return cleaned.title !== title || cleaned.releaseType !== undefined;
};
