const entityMap: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function fromValidCodePoint(value: number) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : "";
}

export function toPlainText(value: string | undefined | null) {
  if (!value) return "";
  return value
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|blockquote|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized.startsWith("#x")) {
        const codePoint = Number.parseInt(normalized.slice(2), 16);
        return fromValidCodePoint(codePoint);
      }
      if (normalized.startsWith("#")) {
        const codePoint = Number.parseInt(normalized.slice(1), 10);
        return fromValidCodePoint(codePoint);
      }
      return entityMap[normalized] ?? "";
    })
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitTelegramText(text: string, limit = 4096) {
  const characters = Array.from(text);
  if (characters.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = characters;
  while (remaining.length) {
    if (remaining.length <= limit) {
      chunks.push(remaining.join(""));
      break;
    }
    let end = limit;
    const candidate = remaining.slice(0, limit).join("");
    const paragraphBreak = candidate.lastIndexOf("\n\n");
    const lineBreak = candidate.lastIndexOf("\n");
    const space = candidate.lastIndexOf(" ");
    const preferred = Math.max(paragraphBreak, lineBreak, space);
    if (preferred >= Math.floor(limit * 0.6)) {
      end = Array.from(candidate.slice(0, preferred + 1)).length;
    }
    chunks.push(remaining.slice(0, end).join("").trim());
    remaining = remaining.slice(end);
    while (remaining[0] === " " || remaining[0] === "\n") remaining.shift();
  }
  return chunks.filter(Boolean);
}
