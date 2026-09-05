/**
 * HTML → Markdown conversion for the fetch_url tool.
 *
 * The conversion itself is Turndown (with the GFM plugin for tables and
 * strikethrough). What this module adds is the part specific to feeding a
 * language model: narrowing the document to its main content region, dropping
 * page furniture (scripts, styles, navigation, footers, asides) in the DOM,
 * link/image resolution against the page URL, and a compact list/whitespace
 * style. Pages are attacker-controlled: every pass here is linear in the page
 * size, and a DOM failure (pathological nesting) degrades to a tag strip.
 */

import gfmPlugin from "@joplin/turndown-plugin-gfm";
import TurndownService from "turndown";

/** Elements whose entire content is noise for a reader */
const DROP_ELEMENTS = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"canvas",
	"iframe",
	"object",
	"embed",
	"video",
	"audio",
	"head",
	"title",
	"nav",
	"footer",
	"aside",
	"form",
	"button",
	"select",
	"dialog",
];
const DROP_ELEMENT_SET = new Set(DROP_ELEMENTS);

const NAMED_ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	thinsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	bull: "•",
	middot: "·",
	times: "×",
	rarr: "→",
	larr: "←",
	eacute: "é",
	egrave: "è",
	agrave: "à",
	ccedil: "ç",
	uuml: "ü",
	ouml: "ö",
	auml: "ä",
	szlig: "ß",
};

/**
 * Decode HTML character references (named, decimal, hexadecimal) in a text
 * fragment, without a DOM. Used for the <title>; Turndown handles the body.
 *
 * @param {string} text - Text with HTML entities
 * @returns {string} Decoded text
 */
export function decodeHtmlEntities(text) {
	return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ref) => {
		const lower = ref.toLowerCase();
		if (lower.startsWith("#x")) {
			const code = Number.parseInt(lower.slice(2), 16);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? safeFromCodePoint(code)
				: match;
		}
		if (lower.startsWith("#")) {
			const code = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? safeFromCodePoint(code)
				: match;
		}
		const named = NAMED_ENTITIES[lower];
		return named !== undefined ? named : match;
	});
}

function safeFromCodePoint(code) {
	try {
		return String.fromCodePoint(code);
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Linear HTML scanning
//
// Everything below runs on attacker-controlled input BEFORE (or instead of)
// the real parser, so it must be linear whatever the markup: no regex that can
// rescan from every "<" of a malformed page. One hand-written tokenizer feeds
// the region selection, the depth estimate, the fallback converter and the
// title extraction.
// ---------------------------------------------------------------------------

/**
 * Elements whose content is not markup until their closer: raw text that is
 * never shown (script, style, xmp) and escapable raw text that is (title,
 * textarea) — the latter is reported through onText.
 */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "xmp"]);
const RCDATA_ELEMENTS = new Set(["title", "textarea"]);

/** Elements that never have a closing tag */
const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/**
 * Openers that implicitly close a same-family element still open on top of
 * the stack (unclosed <li>, <p>, <td>, <tr>, <option>... are everyday HTML):
 * opener → names it closes when found on top.
 */
const IMPLICIT_CLOSERS = {
	li: ["li"],
	p: ["p"],
	dt: ["dt", "dd"],
	dd: ["dt", "dd"],
	option: ["option"],
	td: ["td", "th"],
	th: ["td", "th"],
	tr: ["td", "th", "tr"],
	tbody: ["td", "th", "tr", "tbody", "thead", "tfoot"],
	thead: ["td", "th", "tr", "tbody", "thead", "tfoot"],
	tfoot: ["td", "th", "tr", "tbody", "thead", "tfoot"],
};

/** Characters that end a tag name in the HTML tokenizer: ASCII whitespace, "/", ">", NUL */
function isTagNameTerminator(code) {
	return code === 32 || (code >= 9 && code <= 13) || code === 47 || code === 62 || code === 0;
}

/**
 * Single-pass HTML tokenizer. Comments, doctype/processing instructions and
 * raw-text element bodies are skipped; text runs go to onText, tags to onTag
 * (name lowercased). Either callback may return false to stop the scan.
 *
 * Linear by construction: the next ">" is looked up once and cached, so a "<"
 * with no later ">" costs nothing extra; an unterminated tag or raw-text
 * element swallows the rest of the input, as the HTML tokenizer does.
 *
 * @param {string} html - Markup
 * @param {(tag: {name: string, closing: boolean, selfClosing: boolean, start: number, end: number, attrs: string}) => (boolean|void)} onTag
 * @param {(text: string) => (boolean|void)} onText
 */
function tokenizeHtml(html, onTag, onText) {
	const length = html.length;
	let pos = 0;
	// Cache: no ">" exists in [nextGtFrom, nextGt); nextGt === -1 means none at all
	// after nextGtFrom. A query inside that span is answered without scanning, and
	// each rescan starts past the previous answer, so the scans never overlap.
	let nextGt = -1;
	let nextGtFrom = Number.POSITIVE_INFINITY;
	const gtAfter = (index) => {
		if (index >= nextGtFrom && (nextGt === -1 || index <= nextGt)) return nextGt;
		nextGt = html.indexOf(">", index);
		nextGtFrom = index;
		return nextGt;
	};

	while (pos < length) {
		const lt = html.indexOf("<", pos);
		if (lt === -1) {
			if (onText(html.slice(pos)) === false) return;
			break;
		}
		if (lt > pos && onText(html.slice(pos, lt)) === false) return;

		const next = html.charCodeAt(lt + 1);
		if (next === 33 || next === 63) {
			// <!-- comment -->, <!doctype>, <![CDATA[ ]]>, <?xml ?>
			if (html.startsWith("<!--", lt)) {
				pos = findCommentEnd(html, lt + 4);
			} else {
				const gt = gtAfter(lt);
				pos = gt === -1 ? length : gt + 1;
			}
			continue;
		}

		const closing = next === 47; // "/"
		const nameStart = lt + (closing ? 2 : 1);
		const first = html.charCodeAt(nameStart);
		const startsWithLetter = (first >= 97 && first <= 122) || (first >= 65 && first <= 90);
		if (!startsWithLetter) {
			// A stray "<": text
			if (onText("<") === false) return;
			pos = lt + 1;
			continue;
		}
		// Tag name state: everything up to ASCII whitespace, "/", ">" or NUL is
		// the name ("<x_y>" is the element x_y, not x)
		let nameEnd = nameStart + 1;
		while (nameEnd < length && !isTagNameTerminator(html.charCodeAt(nameEnd))) nameEnd++;

		// The tag ends at the first ">" outside a quoted attribute value (a ">"
		// inside title="...>..." does not end the tag, as in the HTML tokenizer).
		// End tags get the same treatment: the tokenizer parses (and discards)
		// attributes on malformed closers, so `</span title=">">` is one closer
		const gt = findTagEnd(html, nameEnd);
		if (gt === -1) return; // unterminated tag: the rest of the input is lost, as in browsers
		// ASCII case folding only, as the tokenizer does: "<xİ>" and "</xi̇>" are
		// different elements to the parser and must stay different here
		const name = asciiLower(html.slice(nameStart, nameEnd));
		// The "/>" slash only means something on void elements (and in foreign
		// content); the HTML parser opens <div/> like <div>. Reported as a fact,
		// consumers decide.
		const selfClosing = !closing && gt > nameEnd && html.charCodeAt(gt - 1) === 47;
		const tag = { name, closing, selfClosing, start: lt, end: gt + 1, attrs: "" };
		if (!closing && gt > nameEnd) tag.attrs = html.slice(nameEnd, selfClosing ? gt - 1 : gt);
		if (onTag(tag) === false) return;
		pos = gt + 1;

		if (!closing && (RAW_TEXT_ELEMENTS.has(name) || RCDATA_ELEMENTS.has(name))) {
			// Not markup until the matching closer (or the end of input). The closer
			// is "</name" followed by ">", "/" or whitespace: "</scripture>" inside
			// a script is script text, as in the HTML tokenizer. Each miss resumes
			// past the previous candidate, so the search stays linear.
			const close =
				name === "script" ? findScriptCloser(html, pos) : findRawTextCloser(html, name, pos);
			const bodyEnd = close === -1 ? length : close;
			if (RCDATA_ELEMENTS.has(name) && bodyEnd > pos) {
				if (onText(html.slice(pos, bodyEnd)) === false) return;
			}
			if (close === -1) return;
			const closeGt = findTagEnd(html, close + 2 + name.length);
			const closeEnd = closeGt === -1 ? length : closeGt + 1;
			const closer = {
				name,
				closing: true,
				selfClosing: false,
				start: close,
				end: closeEnd,
				attrs: "",
			};
			if (onTag(closer) === false) return;
			pos = closeEnd;
		}
	}
}

/** ASCII-only lowercasing (the HTML tokenizer folds A-Z and nothing else) */
function asciiLower(text) {
	return text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
}

/**
 * Whether `html` at `index` spells `needle` (an ASCII lowercase string) with
 * ASCII case-insensitive comparison, followed by a tag-name terminator or the
 * end of input.
 */
function matchesAsciiCI(html, index, needle) {
	for (let i = 0; i < needle.length; i++) {
		let code = html.charCodeAt(index + i);
		if (code >= 65 && code <= 90) code += 32;
		if (code !== needle.charCodeAt(i)) return false;
	}
	const after = index + needle.length;
	return after >= html.length || isTagNameTerminator(html.charCodeAt(after));
}

/**
 * Index of the "</script" that closes a script element whose body starts at
 * `from`, following the tokenizer's script data states: after "<!--" the
 * data is "escaped", a "<script" inside it enters the "double escaped" state
 * where "</script" does NOT close the element (it only leaves double escaped),
 * and "-->" ends the escape. Linear: every "<" is examined once and the
 * "-->" lookup is cached.
 *
 * @returns {number} Index of the closing "</script", or -1
 */
function findScriptCloser(html, from) {
	const length = html.length;
	let pos = from;
	let escaped = false;
	let doubleEscaped = false;
	let nextDashes = -2; // cached indexOf("-->") result, valid while pos <= nextDashes
	for (;;) {
		const lt = html.indexOf("<", pos);
		if (escaped) {
			if (nextDashes !== -1 && nextDashes < pos) nextDashes = html.indexOf("-->", pos);
			if (nextDashes !== -1 && (lt === -1 || nextDashes < lt)) {
				escaped = false;
				doubleEscaped = false;
				pos = nextDashes + 3;
				continue;
			}
		}
		if (lt === -1) return -1;
		if (html.charCodeAt(lt + 1) === 47 && matchesAsciiCI(html, lt + 2, "script")) {
			if (!doubleEscaped) return lt;
			doubleEscaped = false; // back to the escaped state; the element stays open
			pos = lt + 8;
			continue;
		}
		if (!escaped && html.startsWith("<!--", lt)) {
			escaped = true;
			pos = lt + 4;
			continue;
		}
		if (escaped && !doubleEscaped && matchesAsciiCI(html, lt + 1, "script")) {
			doubleEscaped = true;
			pos = lt + 7;
			continue;
		}
		pos = lt + 1;
		if (pos >= length) return -1;
	}
}

/**
 * Index of the "</name" closer of a raw-text element, searched from `from`
 * with an ASCII case-insensitive comparison on the original string (no
 * lowercased copy: lowercasing can change string length — "İ" becomes two
 * code units — and shift every index). The closer must be followed by ">",
 * "/", whitespace or the end of input. Each "</" is examined once.
 *
 * @returns {number} Index of "</", or -1
 */
function findRawTextCloser(html, name, from) {
	const length = html.length;
	let search = from;
	for (;;) {
		const lt = html.indexOf("</", search);
		if (lt === -1) return -1;
		let matches = true;
		for (let i = 0; i < name.length; i++) {
			let code = html.charCodeAt(lt + 2 + i);
			if (code >= 65 && code <= 90) code += 32; // ASCII upper → lower
			if (code !== name.charCodeAt(i)) {
				matches = false;
				break;
			}
		}
		if (matches) {
			const after = lt + 2 + name.length;
			if (after >= length || isTagNameTerminator(html.charCodeAt(after))) return lt;
		}
		search = lt + 2;
	}
}

/**
 * Index just past the end of a comment whose body starts at `from` (right
 * after "<!--"), following the HTML tokenizer's comment end states: "-->" and
 * "--!>" end a comment, and so do the abrupt forms "<!-->" and "<!--->". An
 * unterminated comment swallows the rest of the input. Linear: each "--" is
 * examined once.
 */
function findCommentEnd(html, from) {
	const length = html.length;
	// Abrupt closings: <!--> and <!--->
	if (html.charCodeAt(from) === 62) return from + 1;
	if (html.charCodeAt(from) === 45 && html.charCodeAt(from + 1) === 62) return from + 2;
	let search = from;
	for (;;) {
		const dashes = html.indexOf("--", search);
		if (dashes === -1) return length;
		if (html.charCodeAt(dashes + 2) === 62) return dashes + 3; // -->
		if (html.charCodeAt(dashes + 2) === 33 && html.charCodeAt(dashes + 3) === 62) {
			return dashes + 4; // --!>
		}
		search = dashes + 1;
	}
}

/**
 * Index of the ">" that ends a start tag whose attributes begin at `from`, or
 * -1 when the tag never ends. Follows the HTML tokenizer's attribute states:
 * a quote opens a quoted value only right after "=", where it hides any ">"
 * until the matching quote; a quote in attribute-name position is just a
 * character. Every character is visited once, so the scan is linear and
 * cannot be made to rescan.
 */
function findTagEnd(html, from) {
	const length = html.length;
	// HTML tokenizer states (simplified): 0 before attribute name, 1 attribute
	// name, 2 after attribute name, 3 before attribute value, 4 unquoted value
	let state = 0;
	for (let i = from; i < length; i++) {
		const code = html.charCodeAt(i);
		const whitespace = code === 32 || (code >= 9 && code <= 13);
		if (code === 62 && state !== 4) return i; // ">" ends the tag in every state but an unquoted value
		switch (state) {
			case 0: // before attribute name
				if (whitespace || code === 47) break;
				// "=" here STARTS a name (parse error in the spec), it is not an assignment
				state = 1;
				break;
			case 1: // attribute name
				if (whitespace || code === 47) state = 2;
				else if (code === 61) state = 3;
				break;
			case 2: // after attribute name
				if (whitespace || code === 47) break;
				if (code === 61) state = 3;
				else state = 1; // a new attribute starts
				break;
			case 3: // before attribute value
				if (whitespace) break;
				if (code === 34 || code === 39) {
					// Quoted value: skip to the matching quote (none → unterminated tag)
					const close = html.indexOf(code === 34 ? '"' : "'", i + 1);
					if (close === -1) return -1;
					i = close;
					state = 0;
				} else {
					state = 4; // unquoted value starts
				}
				break;
			default: // 4: unquoted value
				if (code === 62) return i;
				if (whitespace) state = 0;
				break;
		}
	}
	return -1;
}

/**
 * Value of an attribute in a raw attribute string (quoted or bare), or null.
 * Bounded by the attribute string itself, which the tokenizer has already
 * delimited with the tag's own ">".
 */
function attributeValue(attrs, name) {
	const match = new RegExp(
		`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
		"i"
	).exec(attrs);
	if (!match) return null;
	return match[1] ?? match[2] ?? match[3] ?? null;
}

/**
 * Whether the text outside tags reaches a minimum length (stops early).
 */
function hasTextOfAtLeast(html, minimum) {
	let count = 0;
	tokenizeHtml(
		html,
		() => undefined,
		(text) => {
			count += text.trim().length;
			return count < minimum;
		}
	);
	return count >= minimum;
}

/**
 * Narrow the document to the region worth reading: a single <main>, else a
 * single <article>, else the <body>, else everything. One tokenizer pass
 * records where the exact main/article/body tags are (a <main-menu> custom
 * element or a "<main" inside a script is not a <main>).
 */
function selectContentRegion(html) {
	const marks = {
		main: { opens: 0, start: -1, end: -1 },
		article: { opens: 0, start: -1, end: -1 },
		body: { opens: 0, start: -1, end: -1 },
	};
	// A <main> inside a <template>, <nav>, <footer>... is not the page's content:
	// slicing it out would also detach it from the ancestor Turndown removes.
	// Open dropped elements are counted per name (constant time per tag: no
	// stack a flood of unmatched closers could make this rescan); a closer with
	// nothing open of its name is ignored, as the parser ignores it
	const openDropped = new Map();
	let droppedDepth = 0;
	tokenizeHtml(
		html,
		({ name, closing, selfClosing, start }) => {
			if (DROP_ELEMENT_SET.has(name)) {
				// A void dropped element (<embed>) has no content and never closes
				if (VOID_ELEMENTS.has(name)) return;
				const open = openDropped.get(name) || 0;
				if (closing) {
					if (open > 0) {
						openDropped.set(name, open - 1);
						droppedDepth--;
					}
				} else if (!(selfClosing && (name === "svg" || name === "math"))) {
					openDropped.set(name, open + 1);
					droppedDepth++;
				}
				return;
			}
			const mark = marks[name];
			if (!mark || droppedDepth > 0) return;
			if (closing) {
				mark.end = start; // the last closer wins
			} else {
				mark.opens++;
				if (mark.start === -1) mark.start = start;
			}
		},
		() => undefined
	);

	for (const tag of ["main", "article"]) {
		const { opens, start, end } = marks[tag];
		if (opens !== 1) continue;
		const region = end > start ? html.slice(start, end) : html.slice(start);
		if (hasTextOfAtLeast(region, 200)) return region;
	}
	const body = marks.body;
	if (body.start === -1) return html;
	return body.end > body.start ? html.slice(body.start, body.end) : html.slice(body.start);
}

/**
 * Deepest element nesting the DOM route accepts. The HTML tree builder walks
 * the open-element stack per tag (quadratic in depth) and Turndown recurses
 * per level; browsers cap the DOM at a few hundred levels for the same
 * reason. Real pages sit far below this; only hostile ones exceed it.
 */
const MAX_DOM_DEPTH = 512;

/** Longest URL emitted for a link or image (browsers accept ~2 KB in practice) */
const MAX_URL_CHARS = 2048;

/**
 * Total URL characters emitted per document. Bounds the only expansion step
 * of the conversion (relative hrefs resolved against a long base URL).
 */
const MAX_URL_CHARS_PER_DOCUMENT = 300000;

/**
 * Estimate the maximum element nesting depth the parser would build, with the
 * parser's rules that matter for depth: a closer only pops elements when its
 * element is actually open (an unmatched </span> is ignored, so <div></span>
 * repeated nests), and everyday unclosed <li>/<p>/<td>... are implicitly
 * closed by their siblings. Also tracks how deep lists and blockquotes nest
 * (Turndown prefixes every line per ancestor, so that depth multiplies the
 * output). Stops as soon as either cap is exceeded, so the stack — and each
 * closer's search through it — stays bounded.
 *
 * @param {string} html - Markup
 * @returns {{depth: number, prefixDepth: number}}
 */
function estimateNesting(html) {
	const stack = [];
	let depth = 0;
	let prefixDepth = 0;
	let prefixes = 0; // list/blockquote ancestors currently open
	// Foreign content (svg, math) honours "/>" and is dropped by the converter
	// anyway: skipped as a whole so inline icons and charts never count. HTML
	// "breakout" tags inside it pop the foreign content in the parser and are
	// processed as ordinary HTML, so they are counted.
	let foreign = null;
	let foreignDepth = 0;
	tokenizeHtml(
		html,
		({ name, closing, selfClosing }) => {
			if (foreign) {
				if (name === foreign && !(selfClosing && !closing)) {
					foreignDepth += closing ? -1 : 1;
					if (foreignDepth === 0) foreign = null;
					return true;
				}
				if (closing) return true;
				if (FOREIGN_INTEGRATION.has(name)) {
					// HTML integration point (foreignObject, desc, annotation-xml, ...):
					// its children are parsed as HTML. Conservative: count it and
					// everything after it as HTML (the svg closer, when it comes, pops
					// nothing — its name is not on the stack)
					foreign = null;
				} else if (!FOREIGN_BREAKOUT.has(name)) {
					return true;
				} else {
					foreign = null; // the breakout closed the foreign subtree: fall through
				}
			}
			if (closing) {
				// Pop to the matching open element, unless a scope boundary (object,
				// table, td, template, ...) sits above it: the parser then ignores
				// the end tag and everything stays open. The stack is capped, so this
				// walk is bounded.
				// </li> uses list-item scope (ul/ol are boundaries too), </p> button scope
				const extraBoundary = name === "li" ? LIST_SCOPE : name === "p" ? BUTTON_SCOPE : null;
				let index = -1;
				for (let i = stack.length - 1; i >= 0; i--) {
					if (stack[i] === name) {
						index = i;
						break;
					}
					if (SCOPE_BOUNDARY.has(stack[i]) || extraBoundary?.has(stack[i])) break;
				}
				if (index !== -1) {
					if (FORMATTING_ELEMENTS.has(name) && index !== stack.length - 1) {
						// Adoption agency: the end tag of a formatting element that is not
						// the current node reconstructs the formatting element and leaves
						// the block elements above it open. Only that element leaves the
						// estimate; `<b><div></b>` repeated keeps nesting, as in the parser.
						stack.splice(index, 1);
						return true;
					}
					for (let i = index; i < stack.length; i++) if (PREFIXING.has(stack[i])) prefixes--;
					stack.length = index;
				}
				return true;
			}
			if (name === "svg" || name === "math") {
				if (!selfClosing) {
					foreign = name;
					foreignDepth = 1;
				}
				return true;
			}
			// "<div/>" opens a div: the slash is only meaningful on void elements
			if (VOID_ELEMENTS.has(name)) return true;
			const closes = IMPLICIT_CLOSERS[name];
			if (closes) {
				while (stack.length > 0 && closes.includes(stack[stack.length - 1])) {
					if (PREFIXING.has(stack[stack.length - 1])) prefixes--;
					stack.pop();
				}
			}
			stack.push(name);
			if (PREFIXING.has(name)) prefixes++;
			if (stack.length > depth) depth = stack.length;
			if (prefixes > prefixDepth) prefixDepth = prefixes;
			return depth <= MAX_DOM_DEPTH && prefixDepth <= MAX_PREFIX_DEPTH;
		},
		() => undefined
	);
	return { depth, prefixDepth };
}

/**
 * Elements Turndown renders with a per-line prefix (list indentation, "> ").
 * Nesting them multiplies the output: every line of a deep list repeats the
 * indentation of all its ancestors, so a small page could expand a lot.
 */
const PREFIXING = new Set(["ul", "ol", "blockquote"]);

/**
 * Elements that bound "has an element in scope" in the HTML parser: an end
 * tag whose element sits below one of these on the stack is ignored (so
 * `<div><object></div>` keeps both open and keeps nesting).
 */
const SCOPE_BOUNDARY = new Set([
	"applet",
	"caption",
	"html",
	"table",
	"td",
	"th",
	"marquee",
	"object",
	"template",
	"select",
]);

/** Additional boundaries of list-item scope (</li>) and button scope (</p>) */
const LIST_SCOPE = new Set(["ul", "ol"]);
const BUTTON_SCOPE = new Set(["button"]);

/** Formatting elements, whose end tags go through the adoption agency algorithm */
const FORMATTING_ELEMENTS = new Set([
	"a",
	"b",
	"big",
	"code",
	"em",
	"font",
	"i",
	"nobr",
	"s",
	"small",
	"strike",
	"strong",
	"tt",
	"u",
]);

/**
 * Elements inside svg/math whose children the HTML parser builds as HTML
 * (integration points): svg foreignObject/desc/title, MathML annotation-xml
 * and the text elements. Counted conservatively as HTML from there on.
 */
const FOREIGN_INTEGRATION = new Set([
	"foreignobject",
	"desc",
	"title",
	"annotation-xml",
	"mi",
	"mo",
	"mn",
	"ms",
	"mtext",
]);

/** Deepest list/blockquote nesting the DOM route accepts (real pages stay far below) */
const MAX_PREFIX_DEPTH = 16;

/**
 * HTML start tags that end foreign content (svg, math) in the HTML parser:
 * everything after them is ordinary HTML again and counts towards depth.
 */
const FOREIGN_BREAKOUT = new Set([
	"b",
	"big",
	"blockquote",
	"body",
	"br",
	"center",
	"code",
	"dd",
	"div",
	"dl",
	"dt",
	"em",
	"embed",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"hr",
	"i",
	"img",
	"li",
	"listing",
	"menu",
	"meta",
	"nobr",
	"ol",
	"p",
	"pre",
	"ruby",
	"s",
	"small",
	"span",
	"strong",
	"strike",
	"sub",
	"sup",
	"table",
	"tt",
	"u",
	"ul",
	"var",
	"font",
]);

/** Elements whose content is dropped by the fallback converter */
const FALLBACK_DROP = new Set([...DROP_ELEMENTS, "title"]);

/** Elements that start or end a line in the fallback converter */
const FALLBACK_BLOCKS = new Set([
	"p",
	"div",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"tr",
	"br",
	"section",
	"article",
	"blockquote",
	"pre",
	"ul",
	"ol",
	"table",
	"dt",
	"dd",
	"hr",
]);

/**
 * Last-resort conversion when the DOM route is refused (hostile nesting
 * depth) or fails (parser error, stack exhaustion): drop noise elements,
 * strip the other tags, keep the text. Single pass, linear.
 */
function stripTagsFallback(html) {
	const parts = [];
	let skipping = null; // name of the noise element being skipped
	let skipDepth = 0;
	tokenizeHtml(
		html,
		({ name, closing, selfClosing }) => {
			// "<nav/>" opens a nav like the parser does: the slash only counts on
			// foreign content (svg, math), where an empty element really is empty
			const emptyForeign = selfClosing && (name === "svg" || name === "math");
			if (skipping) {
				if (name === skipping && !emptyForeign) {
					skipDepth += closing ? -1 : 1;
					if (skipDepth === 0) skipping = null;
				}
				return true;
			}
			if (!closing && !emptyForeign && FALLBACK_DROP.has(name) && !VOID_ELEMENTS.has(name)) {
				skipping = name;
				skipDepth = 1;
				return true;
			}
			if (FALLBACK_BLOCKS.has(name)) parts.push("\n");
			else parts.push(" ");
			return true;
		},
		(text) => {
			if (!skipping) parts.push(text);
		}
	);
	return decodeHtmlEntities(parts.join(""))
		.replace(/[ \t\r\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Extract the document title (<title>, else the first <h1>).
 *
 * @param {string} html - Raw HTML document
 * @returns {string} Title text, or "" when none is found
 */
export function extractHtmlTitle(html) {
	// One tokenizer pass: the first <title> wins; the first <h1> is the fallback
	const source = String(html ?? "");
	let title = null;
	let heading = null;
	let collecting = null; // "title" | "h1" while inside the element being captured
	let buffer = [];
	tokenizeHtml(
		source,
		({ name, closing }) => {
			if (collecting) {
				if (name === collecting && closing) {
					const text = buffer.join(" ");
					if (collecting === "title") title = text;
					else heading = text;
					collecting = null;
					buffer = [];
					return title === null; // stop once the title is known
				}
				return true;
			}
			if (!closing && name === "title" && title === null) collecting = "title";
			else if (!closing && name === "h1" && heading === null) collecting = "h1";
			return true;
		},
		(text) => {
			if (collecting) buffer.push(text);
			return true;
		}
	);
	return decodeHtmlEntities(title ?? heading ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Effective base URL of a document: its first <base href> (resolved against
 * the response URL, as browsers do), else the response URL itself. One
 * tokenizer pass that stops at the first <base> or at the end of <head>.
 *
 * @param {string} html - Full document
 * @param {string|undefined} responseUrl - URL the document was fetched from
 * @returns {string|undefined}
 */
function documentBaseUrl(html, responseUrl) {
	let base = responseUrl;
	tokenizeHtml(
		html,
		({ name, closing, attrs }) => {
			if (name === "base" && !closing) {
				// A <base> without href (target only) does not count: keep looking.
				// Attribute values are raw source: character references are decoded
				// ("&amp;" in the source is "&" in the URL), as the parser does
				const rawHref = attributeValue(attrs, "href");
				if (rawHref === null) return true;
				const href = decodeHtmlEntities(rawHref);
				if (!/^(?:javascript|data|vbscript):/i.test(href.trim())) {
					try {
						base = responseUrl ? new URL(href.trim(), responseUrl).toString() : href.trim();
					} catch {
						// Malformed base: keep the response URL
					}
				}
				return false; // the first <base href> wins, as in browsers
			}
			// <base> belongs in <head>: past it (or into the body) there is none
			return !((name === "head" && closing) || name === "body");
		},
		() => undefined
	);
	return base;
}

function resolveUrl(href, baseUrl) {
	const clean = String(href || "").trim();
	if (!clean || /^(?:javascript|data|vbscript):/i.test(clean)) return null;
	if (!baseUrl) return clean;
	try {
		return new URL(clean, baseUrl).toString();
	} catch {
		return clean;
	}
}

/**
 * Build a Turndown service tuned for model consumption.
 *
 * @param {string|undefined} baseUrl - Page URL used to resolve relative links
 */
function createConverter(baseUrl) {
	const service = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "*",
		strongDelimiter: "**",
		linkStyle: "inlined",
		br: "",
	});
	service.use(gfmPlugin.gfm);
	service.remove(DROP_ELEMENTS);

	// Resolving relative hrefs is the one step where output can outgrow the
	// input (thousands of short hrefs × a long base URL): each URL is capped
	// and the URLs emitted per document share a budget; past it, links keep
	// their label only. Everything else Turndown emits is bounded by the input.
	let urlBudget = MAX_URL_CHARS_PER_DOCUMENT;
	const emitUrl = (raw) => {
		const target = resolveUrl(raw, baseUrl);
		if (!target || target.length > MAX_URL_CHARS || target.length > urlBudget) return null;
		urlBudget -= target.length;
		return target;
	};

	// Links: absolute URLs, no duplicate of the label, no javascript: targets
	service.addRule("absoluteLinks", {
		filter: (node) => node.nodeName === "A" && Boolean(node.getAttribute("href")),
		replacement: (content, node) => {
			const label = content.replace(/\s+/g, " ").trim();
			if (!label) return "";
			const href = String(node.getAttribute("href") || "").trim();
			if (href.startsWith("#")) return label;
			const target = emitUrl(href);
			if (!target || label === target) return label;
			return `[${label}](${target})`;
		},
	});

	// Images: keep the alt text and an absolute URL; drop decorative ones
	service.addRule("absoluteImages", {
		filter: "img",
		replacement: (_content, node) => {
			const alt = String(node.getAttribute("alt") || "")
				.replace(/\s+/g, " ")
				.trim();
			const src = emitUrl(node.getAttribute("src"));
			if (!alt && !src) return "";
			return src ? `![${alt}](${src})` : `[image: ${alt}]`;
		},
	});

	return service;
}

/**
 * Convert an HTML document to Markdown.
 *
 * @param {string} html - Raw HTML document or fragment
 * @param {Object} [options]
 * @param {string} [options.baseUrl] - Page URL used to resolve relative links
 * @returns {string} Markdown text
 */
export function htmlToMarkdown(html, { baseUrl } = {}) {
	let source = String(html ?? "");
	if (!source.trim()) return "";

	// <base href> (first one wins, as in browsers) changes what relative links
	// resolve against; it lives in the head, which the region selection drops
	const effectiveBase = documentBaseUrl(source, baseUrl);

	// Region first (linear tokenizer pass), then a real HTML parse: the DOM
	// handles comments, broken markup and unterminated tags; DROP_ELEMENTS are
	// removed as nodes, whatever their nesting
	source = selectContentRegion(source);

	// Hostile nesting: the parser's cost grows quadratically with element depth
	// and the converter recurses per level; nested lists and quotes multiply
	// the output by their depth. Refuse the DOM route up front in both cases.
	const nesting = estimateNesting(source);
	if (nesting.depth > MAX_DOM_DEPTH || nesting.prefixDepth > MAX_PREFIX_DEPTH) {
		return stripTagsFallback(source);
	}

	let markdown;
	try {
		markdown = createConverter(effectiveBase).turndown(source);
	} catch {
		// Parser failure or stack exhaustion on input the estimate let through:
		// degrade to plain text rather than fail the whole read
		return stripTagsFallback(source);
	}

	return tidyMarkdown(markdown).trim();
}

/**
 * Post-pass on Turndown's output: compact list markers (Turndown pads them to
 * a 4-column indent), punctuation glued back to the word it follows, no runs
 * of blank lines. Fenced code blocks are left untouched: the text is split at
 * fence lines (Turndown escapes backticks in prose, so fences are its own) and
 * only the prose segments are rewritten. No placeholder that page text could
 * collide with, and the output can never grow.
 */
function tidyMarkdown(markdown) {
	const out = [];
	let prose = [];
	let inFence = false;
	const flush = () => {
		if (prose.length === 0) return;
		out.push(
			prose
				.join("\n")
				.replace(/^(\s*)-\s{2,}(?=\S)/gm, "$1- ")
				.replace(/^(\s*\d+\.)\s{2,}(?=\S)/gm, "$1 ")
				.replace(/ +([,.;:!?)\]])/g, "$1")
				.replace(/\n{3,}/g, "\n\n")
		);
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		if (/^\s*```/.test(line)) {
			if (!inFence) flush();
			out.push(line);
			inFence = !inFence;
			continue;
		}
		if (inFence) out.push(line);
		else prose.push(line);
	}
	flush();
	// No normalization over the recombined text: blank lines inside fenced
	// code blocks are content (prose segments were normalized in flush)
	return out.join("\n");
}
