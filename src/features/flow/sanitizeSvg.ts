'use client';

/**
 * SVG sanitization for compiled flow diagrams (T065-R03, T065-R06).
 *
 * Mermaid draws by writing a *string* of SVG into the page. Treating that string
 * as trusted would make every escape in the compiler load-bearing forever: the
 * compiler already turns a note saying `<img onerror=...>` into text, but Mermaid
 * parses its own input, re-emits what it parsed, and the result is markup this
 * application did not author. So the rule here is the same one `compileFlow`
 * states from the other side — **the picture is a picture**, and nothing in it
 * may load a resource, run a handler, or reach the DOM outside its own `<svg>`.
 *
 * Three properties are deliberate, and each exists because of a specific way an
 * SVG sanitizer gets this wrong:
 *
 *  1. **Allow-list, not block-list (`ALLOWED_TAGS`).** A block-list of "script,
 *     iframe, …" fails the day the browser adds a tag. `foreignObject` is absent
 *     from the allow-list even though Mermaid can emit it for HTML labels: the
 *     contract forbids it outright, and `MermaidRenderer` disables HTML labels so
 *     it is never needed. Dropping it is not the same as dropping the label text —
 *     `KEEP_CONTENT` keeps the words.
 *  2. **Event attributes forbidden by prefix.** The set of `on*` names grows with
 *     the platform, so it is matched, not enumerated — the same reasoning as the
 *     markmap sanitizer, and the same reason it is installed as a DOMPurify hook
 *     rather than trusted to the attribute list alone.
 *  3. **A returned *string*, produced once (`sanitizeSvgString`).** The display
 *     path and the export path call the same function, so "what is on screen" and
 *     "what was downloaded" cannot drift apart (T065-C06, T068). Nothing
 *     downstream re-assembles the SVG from unsanitized pieces — that would undo
 *     this function while leaving it looking present.
 *
 * ## Two measured traps behind the rules below
 *
 * Both were observed in a real browser, not derived from the API docs, and both
 * made a sanitized string that still loaded a remote document:
 *
 *  - **`USE_PROFILES` discards `ALLOWED_TAGS`/`ALLOWED_ATTR`.** DOMPurify applies
 *    the profile *after* those options and rebuilds both sets from the profile
 *    (measured: `<use>`, `<a>`, `<image>`, `<style>` and `foreignObject` all
 *    survived, and the `data-*` attributes Mermaid emits came through). The
 *    explicit sets in `sanitizeSvgString` therefore document this module's intent
 *    but are not what is enforced; the hooks below are, and the removal checks are
 *    what proves the difference.
 *  - **A `url(…)` value is not a URI attribute.** `marker-end="url(http://evil…)"`
 *    and `<style>@import url(http://evil…)</style>` both produced a *real request*
 *    from the sanitized output — the profile keeps `filter`, `clip-path`, `mask`,
 *    `marker-end` and `<style>`, and DOMPurify's protocol check never looks inside
 *    functional notation. Hence the two value-shaped rules in `ensureHooks`.
 *
 * `findUnsafeSvgMarkup` exists for the one case DOMPurify cannot speak to: an
 * exported file the user is about to keep. It is a *read-only* predicate over the
 * final string, used by tests and by the export guard, and it never repairs —
 * a string that fails it is reported, not silently edited.
 */
import DOMPurify from 'dompurify';

/**
 * Tags a sanitized flow SVG may contain.
 *
 * The set is "what Mermaid's flowchart renderer actually emits for shapes, lines,
 * arrowheads and text", minus everything that can execute, embed or navigate.
 * `foreignObject` is pointedly not here (T065-R03), and neither is `a`, `image`,
 * `use` or `style`: the first three can reference an external resource and the
 * last can reference one through `@import`/`url()`.
 *
 * **This list is intent, not the enforcement point.** Measured: passing
 * `USE_PROFILES` makes DOMPurify rebuild `ALLOWED_TAGS`/`ALLOWED_ATTR` from the
 * profile and silently ignore these two arrays, so several entries here *are*
 * reachable in the output today (`title`, `desc`, `clippath` survive; see the
 * module docblock). It is kept because it states the module's contract for a
 * reader and for the tests that assert the contract, and because the removal
 * checks in `findUnsafeSvgMarkup` are what actually hold the line.
 */
export const SVG_ALLOWED_TAGS = [
  'svg',
  'g',
  'defs',
  'marker',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'clippath',
] as const;

/**
 * Attributes a sanitized flow SVG may contain.
 *
 * Every entry is geometry, paint or text placement. `href`, `xlink:href`, `src`
 * and `style` are absent: the first three are the ways an SVG loads something,
 * and `style` can carry a `url()` or an `@import`. `data-*` is off too — the
 * renderer's own node ids are read from React state and the source panel, never
 * from an attribute inside the picture (T065-C05).
 *
 * Same caveat as `SVG_ALLOWED_TAGS`: with `USE_PROFILES` in play DOMPurify
 * rebuilds this set from the profile, so the array states intent while the value
 * hooks and the removal checks do the enforcing.
 */
export const SVG_ALLOWED_ATTR = [
  'id',
  'class',
  'transform',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'points',
  'viewBox',
  'preserveAspectRatio',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'marker-end',
  'marker-start',
  'marker-mid',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'letter-spacing',
  'role',
  'aria-label',
  'aria-hidden',
  'xmlns',
] as const;

/**
 * Named tags that must be gone even if a future allow-list edit adds one back.
 *
 * Redundant with `SVG_ALLOWED_TAGS` today, and kept on purpose: the contract names
 * these five, so the rule is stated where a reader looks for it rather than only
 * implied by an omission. This list *is* enforced — it is passed as `FORBID_TAGS`,
 * which `USE_PROFILES` does not override (measured: `<script>`, `<object>` and
 * `<embed>` are removed by it while the profile alone would keep them).
 */
export const SVG_FORBIDDEN_TAGS = ['script', 'foreignobject', 'iframe', 'object', 'embed'] as const;

/** Any `on*` attribute. Matched by prefix because the platform keeps adding names. */
export const SVG_FORBIDDEN_ATTR_PATTERN = /^on/iu;

/** Protocols an inline reference is allowed to use. Nothing else is a resource. */
const SAFE_URL_PATTERN = /^(?:#|data:image\/(?:png|jpe?g|gif|webp);base64,)/iu;

/**
 * A `url(...)` argument that is not an internal `#fragment`.
 *
 * Measured, not assumed: with `USE_PROFILES: {svg: true, svgFilters: true}` the
 * reference-bearing attributes DOMPurify's SVG profile allows — `filter`,
 * `clip-path`, `mask`, `marker-end`, `fill` — keep a `url(http://…)` value, and a
 * browser really loads it. `marker-end="url(http://evil.example/m.svg#m)"` produced
 * a real request for `http://evil.example/m.svg` from the sanitized string, so the
 * "no external request" half of T065-C01 cannot rest on the allow-list alone.
 *
 * Only a fragment is treated as internal. A bare relative `url(x.svg#p)` is
 * *also* refused even though it points at this origin: Mermaid only ever emits
 * `url(#…)` for its markers and clip paths, so refusing the rest costs the picture
 * nothing and removes the "same-origin but still a load" case from the argument.
 */
const REMOTE_URL_IN_VALUE = /\burl\s*\(\s*["']?\s*(?![#]|data:image\/(?:png|jpe?g|gif|webp);base64,)/iu;

/** `@import` in a retained `<style>`. The one CSS at-rule that loads a document. */
const STYLE_IMPORT = /@import/iu;

/* -------------------------------------------------------------------------- */
/* String scanning helpers (for the read-only predicate)                       */
/* -------------------------------------------------------------------------- */

/** One element's start tag: `<name …>` and `<name … />`. */
const ELEMENT_TAG = /<[a-z][^>]*>/giu;

/** `name="value"` / `name='value'` / `name=value` inside a start tag. */
const ATTR_IN_TAG = /([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu;

/** A `<style>` element's text content. */
const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu;

/**
 * Attributes whose *value is a URI*.
 *
 * The protocol check applies here and nowhere else: these are the attributes a
 * browser resolves into a load or a navigation.
 */
const REFERENCE_VALUE_ATTRS = new Set(['href', 'xlink:href', 'src']);

/**
 * Attributes whose value may contain `url(…)` functional notation.
 *
 * `fill`/`stroke` are included because `fill="url(#g)"` is how Mermaid paints a
 * gradient; a fragment is allowed and a remote document is not.
 */
const URL_VALUE_ATTRS = new Set([
  'filter',
  'clip-path',
  'mask',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'fill',
  'stroke',
  'style',
  'cursor',
]);

/** Every start tag in a document, so attributes can be read per element. */
function elementsOf(svg: string): string[] {
  return [...svg.matchAll(ELEMENT_TAG)].map((match) => match[0]);
}

/** Attribute pairs of one start tag, with the quoting variants normalised. */
function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(ATTR_IN_TAG)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes.set((match[1] ?? '').toLowerCase(), decodeEntities(value));
  }
  return attributes;
}

/** The five predefined XML entities, plus numeric forms. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/giu, (_all, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);?/gu, (_all, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

/** Does this attribute or stylesheet text ask the browser to load something? */
function referencesRemoteResource(value: string): boolean {
  return REMOTE_URL_IN_VALUE.test(value);
}

let hooksInstalled = false;

/**
 * Install the sanitizer hooks once per page.
 *
 * `ALLOWED_ATTR` already excludes handlers; the hook is what keeps the rule true
 * for an attribute name only known at runtime, and it survives a later widening of
 * the allow-list that nobody connected to this rule. It is also the only place the
 * two *value-shaped* references are caught, and both were measured fetching a real
 * remote document before this rule existed:
 *
 *  - `url(…)` inside `filter` / `clip-path` / `mask` / `marker-end` / `style`;
 *  - `@import` inside a `<style>` element.
 */
function ensureHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (SVG_FORBIDDEN_ATTR_PATTERN.test(data.attrName)) {
      data.keepAttr = false;
      data.forceKeepAttr = false;
      return;
    }
    const value = (data.attrValue ?? '').trim();
    // A reference attribute is re-checked here rather than trusted, because the
    // failure this defends against is a *future* allow-list entry.
    if (REFERENCE_ATTRS.has(data.attrName.toLowerCase()) && !SAFE_URL_PATTERN.test(value)) {
      data.keepAttr = false;
      data.forceKeepAttr = false;
      return;
    }
    // `url(…)` is functional notation rather than a URI attribute, so DOMPurify's
    // own protocol check never sees the address inside it.
    if (referencesRemoteResource(value)) {
      data.keepAttr = false;
      data.forceKeepAttr = false;
    }
  });

  /**
   * Neutralise a `<style>` that would load something.
   *
   * The element is *emptied* rather than removed, and that distinction is the
   * whole point: Mermaid paints the diagram from the CSS in this block (`#id .node
   * rect{fill:…}`, the font stack, the edge-dash keyframes), so dropping the element
   * would change the picture. Dropping only the offending declarations leaves an
   * inert element and the same diagram.
   *
   * A stylesheet that reaches this branch is not something the locked Mermaid build
   * produces — its own block is internal CSS only — so this is a threshold for
   * material that got further than it should have, not a routine rewrite of the
   * library's stylesheet.
   */
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if ((data.tagName ?? '').toLowerCase() !== 'style') return;
    const css = node.textContent ?? '';
    if (STYLE_IMPORT.test(css) || referencesRemoteResource(css)) {
      node.textContent = '';
    }
  });
}


const REFERENCE_ATTRS = new Set(['href', 'xlink:href', 'src', 'style', 'fill', 'stroke']);

/**
 * Sanitize one SVG document string.
 *
 * `RETURN_DOM_FRAGMENT` is off and a string comes back, because both callers need
 * a string: React assigns it to the canvas, and the export writes it to a file. A
 * fragment would have to be serialized again, and that second serialization is a
 * second place for the picture to differ from the sanitized one.
 *
 * `SVG_FORBIDDEN_TAGS` is passed as `FORBID_TAGS` and is *also* part of
 * `ALLOWED_TAGS`'s complement; see the module docblock on why the profile makes
 * the ALLOWED_* sets advisory. `USE_PROFILES.svgFilters` is what lets Mermaid's
 * `<filter>`/`<feDropShadow>` drop shadow through, and it is also what keeps
 * `filter`/`marker-*` — so the value-level hook above is load-bearing rather than
 * belt-and-braces.
 */
export function sanitizeSvgString(svg: string): string {
  ensureHooks();
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ALLOWED_TAGS: [...SVG_ALLOWED_TAGS],
    ALLOWED_ATTR: [...SVG_ALLOWED_ATTR],
    FORBID_TAGS: [...SVG_FORBIDDEN_TAGS],
    // A sanitized tree has no reference attributes left, but leaving this on means
    // an allow-list mistake still cannot produce a `javascript:` URL.
    ALLOW_UNKNOWN_PROTOCOLS: false,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: true,
    // Keeps the words when a disallowed wrapper is dropped, so removing a
    // `foreignObject` cannot make a node's label disappear from the picture.
    KEEP_CONTENT: true,
    WHOLE_DOCUMENT: false,
  });
}

/**
 * Read-only scan for markup that must never appear in a kept SVG (T065-C06).
 *
 * Deliberately a string predicate rather than a second sanitizer: the question
 * "is this file safe to hand to the user?" is asked *after* sanitization, and
 * answering it by sanitizing again would hide a sanitizer that had stopped
 * working. It reports; it does not repair.
 *
 * ## Why it parses instead of searching the raw string
 *
 * The first version of this predicate ran `/javascript\s*:/` over the whole
 * document text, and that turned out to abort a *legitimate* render: a note whose
 * own words mention `javascript:alert(1)` becomes a `<text>` node during rendering,
 * the naive scan flagged the label, and `renderFlowSvg` — which fails closed on a
 * problem — refused to draw the whole diagram (measured, and now a case in
 * `tests/browser/flow-render-security.test.ts`). A predicate that cannot tell a URL
 * from a label is not measuring the thing T065-C06 asks about.
 *
 * So the scan is scoped to where a reference actually lives:
 *
 *  - a **reference-bearing attribute value** (`href`, `xlink:href`, `src`, and the
 *    presentation attributes that take `url(…)`), which is the only place a browser
 *    turns a string into a load or a navigation;
 *  - a **`<style>` element's content**, for `@import` and `url(…)`;
 *  - a **tag name** that must not exist, and an `on*` attribute name.
 *
 * Prose is not parsed for protocols at all. That is not a hole: text cannot become a
 * URL, and a SMIL element that *could* write one (`<set>`/`<animate>` rewriting
 * `href`) does not survive `sanitizeSvgString` — measured, the whole element is
 * dropped — so any path that reaches this predicate with such a write has already
 * lost the element that would perform it.
 *
 * **Known limit, deliberately not closed here:** a CSS *escape* (`\68 ttp://…`,
 * where `\68` is `h`) is valid CSS and the browser will load it, but neither
 * `@import` nor a literal `url(` appears in the text, so the stylesheet scan above
 * does not flag it. Closing it means *tokenising* CSS here instead of matching it,
 * and that reintroduces exactly the class of false positive this predicate was
 * rewritten to remove — a label merely containing `url(//…)` used to refuse the
 * whole diagram, which is a bug users could see. It is also not reachable today:
 * labels are emitted as `<text>` (`htmlLabels: false`), so note text cannot land in
 * a `<style>` element's content, and the theme CSS comes from the pinned
 * `MERMAID_CONFIG`. And this predicate is a re-check, not the primary barrier — the
 * value-level hook in `ensureHooks` is. Recorded so the next reader does not mistake
 * this scan for a complete CSS check.
 *
 * Exported so a test can assert the rule on an SVG built by any path, including one
 * this module never produced.
 */
export function findUnsafeSvgMarkup(svg: string): string[] {
  const found: string[] = [];

  for (const tag of SVG_FORBIDDEN_TAGS) {
    // `<script`, `</script`, and `<foreignobject` in any namespace prefix form.
    if (new RegExp(`<\\s*[a-z0-9:._-]*${tag}[\\s/>]`, 'iu').test(svg)) {
      found.push(`包含 <${tag}> 标签`);
    }
  }

  if (/<[^>]*\son[a-z]+\s*=/iu.test(svg)) {
    found.push('包含 on* 事件属性');
  }

  // ---- Reference-bearing attributes ----
  //
  // `attributename="href"` is how SMIL addresses another attribute, so both the
  // attribute and its value are read on the same element: `<set attributeName="href"
  // to="javascript:…">` is a URL write, not prose.
  for (const element of elementsOf(svg)) {
    const attributes = attributesOf(element);

    for (const [name, value] of attributes) {
      const trimmed = value.trim();
      if (trimmed.length === 0) continue;

      if (REFERENCE_VALUE_ATTRS.has(name)) {
        const isJavascript = /^javascript\s*:/iu.test(trimmed);
        if (isJavascript) {
          found.push(`属性 ${name} 使用了 javascript: 协议`);
        } else if (!SAFE_URL_PATTERN.test(trimmed)) {
          found.push(`引用了外部资源：${trimmed.slice(0, 60)}`);
        }
        continue;
      }

      // Functional notation: `filter`, `clip-path`, `mask`, `marker-*`, `style`.
      // Only a `#fragment` is a reference to this document.
      if (URL_VALUE_ATTRS.has(name) && referencesRemoteResource(trimmed)) {
        found.push(`属性 ${name} 引用了外部资源：${trimmed.slice(0, 60)}`);
      }
    }

    // A SMIL element pointed at a reference attribute is another way to write one.
    const target = attributes.get('attributename')?.trim().toLowerCase();
    if (target !== undefined && REFERENCE_VALUE_ATTRS.has(target)) {
      const written = `${attributes.get('to') ?? ''} ${attributes.get('values') ?? ''}`;
      if (/javascript\s*:/iu.test(written)) {
        found.push(`动画把 ${target} 写成 javascript: 协议`);
      } else if (/(?:https?:)?\/\//iu.test(written)) {
        found.push(`动画把 ${target} 写成外部地址`);
      }
    }
  }

  // ---- Stylesheet content ----
  for (const match of svg.matchAll(STYLE_ELEMENT)) {
    const css = decodeEntities(match[1] ?? '');
    if (STYLE_IMPORT.test(css) || referencesRemoteResource(css)) {
      found.push('包含外部样式引用');
      break;
    }
  }

  return found;
}
