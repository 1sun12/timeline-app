// Markdown with Obsidian-style [[wikilinks]].
// Notes can come from someone else's shared file, so rendered HTML is always
// sanitized: the webview can call the app's backend, script must never run.
import { Marked } from "marked";
import DOMPurify from "dompurify";

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** Titles a note links to, in order, without duplicates. */
export function linksIn(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(WIKILINK)) seen.add(m[1].trim());
  return [...seen];
}

export const titleKey = (t: string) => t.trim().toLowerCase();

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Render a note body. `exists` decides whether a link is live or dangling. */
export function render(body: string, exists: (title: string) => boolean): string {
  const md = new Marked({ gfm: true, breaks: true });
  md.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start: (src: string) => src.indexOf("[["),
        tokenizer(src: string) {
          const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(src);
          if (m) return { type: "wikilink", raw: m[0], title: m[1].trim(), label: (m[2] ?? m[1]).trim() };
        },
        renderer(tok) {
          const cls = exists(tok.title) ? "wikilink" : "wikilink missing";
          return `<a class="${cls}" data-note="${escapeHtml(tok.title)}">${escapeHtml(tok.label)}</a>`;
        },
      },
    ],
  });
  return DOMPurify.sanitize(md.parse(body) as string, { ADD_ATTR: ["data-note"] });
}
