// Plain-text rendering of a Taiga read result: same data as the JSON minus syntax and noise, to save tokens.
// Null / empty values are omitted; strings keep their exact text (multi-line ones as an indented block).

const INLINE_MAX = 80;

const isEmpty = (v: unknown) =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

const isScalar = (v: unknown) => v === null || typeof v !== "object";
const inlineScalar = (v: unknown) => typeof v === "string" && (v.includes("\n") || v.length > INLINE_MAX) ? false : isScalar(v);

const pad = (n: number) => "  ".repeat(n);
const block = (s: string, depth: number) => s.split(/\r?\n/).map((l) => pad(depth) + l).join("\n");

// Arrays of scalars (or of scalar tuples such as tags) collapse to one line.
function flatList(a: unknown[]): string | undefined {
  const parts: string[] = [];
  for (const x of a) {
    if (isScalar(x)) { if (x !== null) parts.push(String(x)); continue; }
    if (Array.isArray(x) && x.every(isScalar)) { parts.push(x.filter((y) => y !== null).join("/")); continue; }
    return undefined;
  }
  const line = parts.join(", ");
  return line.length <= INLINE_MAX * 2 && !line.includes("\n") ? line : undefined;
}

function renderObject(o: Record<string, unknown>, depth: number): string[] {
  const inline: string[] = [];
  const rest: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (isEmpty(v)) continue;
    if (inlineScalar(v)) { inline.push(`${k}: ${v}`); continue; }
    if (Array.isArray(v)) {
      const flat = flatList(v);
      if (flat !== undefined) { inline.push(`${k}: ${flat}`); continue; }
      rest.push(`${pad(depth)}${k}:`, ...renderValue(v, depth + 1));
    } else if (typeof v === "object") {
      rest.push(`${pad(depth)}${k}:`, ...renderObject(v as Record<string, unknown>, depth + 1));
    } else {
      rest.push(`${pad(depth)}${k}:`, block(String(v), depth + 1));
    }
  }
  return [...(inline.length ? [pad(depth) + inline.join(" | ")] : []), ...rest];
}

function renderValue(v: unknown, depth: number): string[] {
  if (Array.isArray(v)) {
    return v.flatMap((x) => {
      if (isEmpty(x)) return [];
      if (isScalar(x)) return [`${pad(depth)}- ${x}`];
      const lines = Array.isArray(x) ? renderValue(x, depth + 1) : renderObject(x as Record<string, unknown>, depth + 1);
      return lines.length ? [`${pad(depth)}- ${lines[0].trimStart()}`, ...lines.slice(1)] : [];
    });
  }
  if (v && typeof v === "object") return renderObject(v as Record<string, unknown>, depth);
  return [block(String(v), depth)];
}

export function renderText(value: unknown): string {
  return renderValue(value, 0).join("\n");
}
