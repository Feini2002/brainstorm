/**
 * DOM sanitization for Markmap node content (T057-R02).
 *
 * Markmap's transformer produces each node's `content` as an **HTML string**,
 * because upstream it parses general Markdown that may contain inline HTML,
 * links, images and KaTeX. It renders that string with `.html(...)` on a
 * `foreignObject` inside the SVG, which means whatever the string contains
 * becomes live DOM in the user's page.
 *
 * For this application that is the wrong trust level twice over:
 *
 *   - the input is *model output arranged from untrusted notes*, so a node label
 *     is attacker-influenced text, not authored markup;
 *   - `compileMindmap` escapes every label precisely so that a note saying
 *     `<img src=...>` is *displayed*, not fetched. Sanitizing here is what keeps
 *     that true after the transformer has re-interpreted the label as markup.
 *
 * So the sanitizer is an allow-list, not a blocklist: formatting that a label
 * could legitimately want (`strong`, `em`, `code`, `del`, `sub`, `sup`, `mark`,
 * `ins`) survives, and everything that can load a resource or run code — `a`,
 * `img`, `svg`, `iframe`, `object`, `embed`, `style`, `script`, `foreignObject` —
 * does not. Event attributes are forbidden by *prefix*, since the browser's set
 * of `on*` names grows and a name list would quietly stop covering it.
 *
 * The transformed tree is sanitized **before** `setData`, so the library never
 * receives the original HTML. Sanitizing afterwards would mean the unsafe string
 * had already been assigned to a live element.
 */
import DOMPurify from 'dompurify';
import type { Transformer } from 'markmap-lib/no-plugins';

/**
 * Node shape as `markmap-lib` produces it, derived from the installed package
 * instead of importing `markmap-common` (a transitive dependency this project
 * does not declare). `import type` is erased at build time, so this adds nothing
 * to the browser bundle.
 */
export type TransformedRoot = ReturnType<Transformer['transform']>['root'];

/** A transformed node with our own annotation merged into its payload. */
type MarkedNode = Omit<TransformedRoot, 'payload'> & {
  payload?: Record<string, unknown>;
};

/**
 * The tag allow-list, exported so it can be asserted without a DOM.
 *
 * Deliberately excludes `a`: the contract says links are removed, and a
 * sanitized `href` is still a navigation the user did not ask for.
 */
export const MINDMAP_ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'code',
  'pre',
  'del',
  's',
  'sub',
  'sup',
  'mark',
  'ins',
  'span',
  'blockquote',
  'ul',
  'ol',
  'li',
] as const;

/**
 * Attributes allowed on the elements above.
 *
 * `class` is kept because Markmap styles its own generated wrappers with it;
 * nothing else is needed, and `href`/`src`/`xlink:href` are absent on purpose.
 */
export const MINDMAP_ALLOWED_ATTR = ['class'] as const;

/**
 * Anything named `on*` is an event handler. Forbidden by pattern rather than by a
 * list of names, because the browser's set grows over time.
 */
export const MINDMAP_FORBIDDEN_ATTR_PATTERN = /^on/iu;

let hooksInstalled = false;

/**
 * Install the attribute hook once per page.
 *
 * `ALLOWED_ATTR` already excludes handlers, but the hook makes the rule hold even
 * if someone later widens the allow-list without noticing the interaction, and it
 * is the only place that can reject an attribute whose name is only known at
 * runtime.
 */
function ensureHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (MINDMAP_FORBIDDEN_ATTR_PATTERN.test(data.attrName)) {
      data.keepAttr = false;
      data.forceKeepAttr = false;
    }
  });
}

/** Sanitize one node's HTML content. */
export function sanitizeNodeContent(html: string): string {
  ensureHooks();
  // A string is the expected shape: Markmap assigns the result through `.html()`,
  // so returning a DOM fragment would only have to be serialized again.
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...MINDMAP_ALLOWED_TAGS],
    ALLOWED_ATTR: [...MINDMAP_ALLOWED_ATTR],
    // `ALLOW_DATA_ATTR`/`ALLOW_ARIA_ATTR` are off: neither is needed for display
    // and both are a channel a label could use to smuggle structured data out.
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // A sanitized tree has no URL-bearing attributes left, but leaving this on
    // means a future allow-list mistake still cannot produce a `javascript:` URL.
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
  });
}

/**
 * Sanitize a whole transformed tree, returning a new tree.
 *
 * A copy rather than in-place mutation: the transformer's result belongs to the
 * library, and mutating it would make "what the compiler produced" and "what we
 * display" the same object — exactly the distinction being defended. `payload`
 * survives (Markmap stores fold state there) along with our `mmId` annotation.
 */
export function sanitizeTree(root: TransformedRoot): TransformedRoot {
  const source = root as MarkedNode;
  const copy: MarkedNode = {
    ...source,
    content: sanitizeNodeContent(source.content),
    children: source.children.map((child) => sanitizeTree(child) as MarkedNode),
  };
  return copy as TransformedRoot;
}

/** Count nodes in a transformed tree, so tests can prove nothing was dropped. */
export function countTreeNodes(root: TransformedRoot): number {
  return 1 + root.children.reduce((total, child) => total + countTreeNodes(child), 0);
}
