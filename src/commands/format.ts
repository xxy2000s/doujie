export function commandTitle(title: string, subtitle?: string): string {
  return [`## ${title}`, subtitle ? `_${subtitle}_` : ''].filter(Boolean).join('\n\n');
}

export function commandSection(title: string, lines: string[]): string {
  const body = lines.filter(Boolean).join('\n');
  return body ? `### ${title}\n${body}` : '';
}

export function field(label: string, value: string | number): string {
  return `- **${label}:** ${value}`;
}

export function bullet(value: string): string {
  return `- ${value}`;
}

export function numbered(index: number, title: string, lines: string[] = []): string {
  const body = lines.filter(Boolean).map((line) => `  ${line}`).join('\n');
  return body ? `${index}. ${title}\n${body}` : `${index}. ${title}`;
}

export function shortId(id: string, head = 8, tail = 6): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

export function compact(value: string | null | undefined, max = 80): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

export function joinBlocks(blocks: string[]): string {
  return blocks.filter(Boolean).join('\n\n');
}
