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
// @ts-expect-error domino ships global-style typings that tsc cannot import as a module
import domino from "@mixmark-io/domino";
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
	const source = String(text ?? "");
	if (!source.includes("&")) return source;
	// The HTML parser's complete rules (every named reference, legacy
	// semicolon-less forms, numeric overrides): the text is parsed as a quoted
	// attribute value — its own quotes escaped — so nothing in it can be read as
	// markup, and the decoded value is read back. Linear in the text length.
	try {
		const doc = domino.createDocument(
			`<!DOCTYPE html><html><head><meta name="m8b" content="${source.replace(/"/g, "&quot;")}"></head></html>`
		);
		const decoded = doc.querySelector('meta[name="m8b"]')?.getAttribute("content");
		if (typeof decoded === "string") return decoded;
	} catch {
		// Parser failure: the small table below still covers the common references
	}
	return decodeWithTable(source);
}

/** Table-driven fallback decoder (the common references only) */
function decodeWithTable(text) {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ref) => {
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
const RAW_TEXT_ELEMENTS = new Set([
	"script",
	"style",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
	"plaintext", // to the end of input: there is no closer
]);
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
const HEADINGS = ["h1", "h2", "h3", "h4", "h5", "h6"];
const IMPLICIT_CLOSERS = {
	li: ["li"],
	p: ["p"],
	// A heading start tag closes an open paragraph or heading (<h1>Title<h2>...)
	h1: ["p", ...HEADINGS],
	h2: ["p", ...HEADINGS],
	h3: ["p", ...HEADINGS],
	h4: ["p", ...HEADINGS],
	h5: ["p", ...HEADINGS],
	h6: ["p", ...HEADINGS],
	dt: ["dt", "dd"],
	dd: ["dt", "dd"],
	option: ["option"],
	optgroup: ["option", "optgroup"],
};

/** Table parts whose start tags follow the table insertion modes (see tableStart) */
const TABLE_PARTS = new Set([
	"td",
	"th",
	"tr",
	"tbody",
	"thead",
	"tfoot",
	"caption",
	"colgroup",
	"col",
]);

/** Elements that decide the table insertion mode: the nearest one on the stack */
const TABLE_CONTEXT = new Set([
	"td",
	"th",
	"tr",
	"tbody",
	"thead",
	"tfoot",
	"caption",
	"colgroup",
	"table",
	"template",
	"html",
]);

/**
 * ASCII whitespace as the HTML tokenizer defines it: tab, LF, FF, CR and
 * space — NOT the vertical tab (U+000B), which is an ordinary character there
 * ("<input\u000b>" is the non-void element "input\u000b", not an <input>).
 */
function isTokenizerWhitespace(code) {
	return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/**
 * Characters that end a tag name in the HTML tokenizer: ASCII whitespace, "/"
 * and ">". A NUL does NOT end it — the tokenizer appends U+FFFD to the name
 * and goes on, so "<input\u0000>" is the non-void element "input\uFFFD".
 */
function isTagNameTerminator(code) {
	return isTokenizerWhitespace(code) || code === 47 || code === 62;
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
 * @param {(tag: {name: string, closing: boolean, selfClosing: boolean, start: number, end: number, attrs: string, rawText: boolean}) => (boolean|void)} onTag
 *   Called per tag; return false to stop. `rawText` tells whether the body that
 *   follows is tokenized as raw text/RCDATA — clear it for a tag that opens in
 *   foreign content, where the parser never switches state.
 * @param {(text: string) => (boolean|void)} onText
 * @param {{inForeign?: () => boolean}} [options] - `inForeign` tells whether the
 *   parser would be in foreign content (svg/math) at this point; there, and only
 *   there, "<![CDATA[" opens a CDATA section that runs to "]]>"
 */
function tokenizeHtml(html, onTag, onText, options = {}) {
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
			// <!-- comment -->, <!doctype>, <?xml ?> — and <![CDATA[ ]]>, a CDATA
			// section (text through "]]>") in foreign content only; in HTML it is a
			// bogus comment that ends at the first ">"
			if (html.startsWith("<!--", lt)) {
				pos = findCommentEnd(html, lt + 4);
			} else if (next === 33 && startsWithAsciiCI(html, lt + 2, "doctype")) {
				// A DOCTYPE's quoted identifiers may contain ">" (`SYSTEM "x><textarea>"`)
				pos = findDoctypeEnd(html, lt + 9);
			} else if (html.startsWith("<![CDATA[", lt) && options.inForeign?.()) {
				const end = html.indexOf("]]>", lt + 9);
				const bodyEnd = end === -1 ? length : end;
				if (bodyEnd > lt + 9 && onText(html.slice(lt + 9, bodyEnd)) === false) return;
				pos = end === -1 ? length : end + 3;
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
		const { gt, selfClosing: slashBeforeGt } = findTagEnd(html, nameEnd);
		if (gt === -1) return; // unterminated tag: the rest of the input is lost, as in browsers
		// ASCII case folding only, as the tokenizer does: "<xİ>" and "</xi̇>" are
		// different elements to the parser and must stay different here
		const name = asciiLower(html.slice(nameStart, nameEnd));
		// The "/>" slash only means something on void elements (and in foreign
		// content); the HTML parser opens <div/> like <div>. Reported as a fact,
		// consumers decide.
		const selfClosing = !closing && slashBeforeGt;
		const tag = { name, closing, selfClosing, start: lt, end: gt + 1, attrs: "", rawText: false };
		if (!closing && gt > nameEnd) tag.attrs = html.slice(nameEnd, selfClosing ? gt - 1 : gt);
		// The switch to raw text / RCDATA is the tree builder's, and only for HTML
		// elements: inside foreign content (svg, math) a <textarea> or <style> is
		// an ordinary element whose content is markup. A consumer tracking the
		// namespace clears `rawText` before returning to keep tokenizing tags.
		tag.rawText = !closing && (RAW_TEXT_ELEMENTS.has(name) || RCDATA_ELEMENTS.has(name));
		if (onTag(tag) === false) return;
		pos = gt + 1;

		if (tag.rawText) {
			if (name === "plaintext") {
				// The rest of the document is text (the fallback converter shows it)
				if (pos < length) onText(html.slice(pos));
				return;
			}
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
			const closeGt = findTagEnd(html, close + 2 + name.length).gt;
			const closeEnd = closeGt === -1 ? length : closeGt + 1;
			const closer = {
				name,
				closing: true,
				selfClosing: false,
				start: close,
				end: closeEnd,
				attrs: "",
				rawText: false,
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
 * End of a tag whose attributes begin at `from`: the index of the ">" that
 * ends it (-1 when the tag never ends) and whether it ended in the tokenizer's
 * self-closing-start-tag state — a "/" right before the ">" met where an
 * attribute name could start or end, NOT one inside an unquoted value
 * (`<svg a=x/>` has the value "x/" and opens an svg). Follows the attribute
 * states: a quote opens a quoted value only right after "=", where it hides
 * any ">" until the matching quote; a quote in attribute-name position is
 * just a character. Every character is visited once, so the scan is linear.
 *
 * @param {string} html - Markup
 * @param {number} from - Index right after the tag name
 * @returns {{gt: number, selfClosing: boolean}}
 */
function findTagEnd(html, from) {
	const length = html.length;
	// HTML tokenizer states (simplified): 0 before attribute name, 1 attribute
	// name, 2 after attribute name, 3 before attribute value, 4 unquoted value
	let state = 0;
	let slash = false; // the previous character was a "/" in self-closing position
	for (let i = from; i < length; i++) {
		const code = html.charCodeAt(i);
		const whitespace = isTokenizerWhitespace(code);
		if (code === 62 && state !== 4) return { gt: i, selfClosing: slash }; // ">" ends the tag
		slash = false;
		switch (state) {
			case 0: // before attribute name
				if (whitespace) break;
				if (code === 47) {
					slash = true; // "/" here: self-closing start tag state
					break;
				}
				// "=" here STARTS a name (parse error in the spec), it is not an assignment
				state = 1;
				break;
			case 1: // attribute name
				if (whitespace) state = 2;
				else if (code === 47) {
					slash = true;
					state = 2;
				} else if (code === 61) state = 3;
				break;
			case 2: // after attribute name
				if (whitespace) break;
				if (code === 47) {
					slash = true;
					break;
				}
				if (code === 61) state = 3;
				else state = 1; // a new attribute starts
				break;
			case 3: // before attribute value
				if (whitespace) break;
				if (code === 34 || code === 39) {
					// Quoted value: skip to the matching quote (none → unterminated tag)
					const close = html.indexOf(code === 34 ? '"' : "'", i + 1);
					if (close === -1) return { gt: -1, selfClosing: false };
					i = close;
					state = 0;
				} else {
					state = 4; // unquoted value starts ("/" included)
				}
				break;
			default: // 4: unquoted value — a "/" is part of the value
				if (code === 62) return { gt: i, selfClosing: false };
				if (whitespace) state = 0;
				break;
		}
	}
	return { gt: -1, selfClosing: false };
}

/**
 * Whether `html` at `index` spells `needle` (ASCII lowercase) with ASCII
 * case-insensitive comparison, whatever follows.
 */
function startsWithAsciiCI(html, index, needle) {
	for (let i = 0; i < needle.length; i++) {
		let code = html.charCodeAt(index + i);
		if (code >= 65 && code <= 90) code += 32;
		if (code !== needle.charCodeAt(i)) return false;
	}
	return true;
}

/**
 * Index just past the ">" that ends a DOCTYPE whose text starts at `from`
 * (right after "<!doctype"), with the tokenizer's DOCTYPE states: the name
 * runs to whitespace or ">"; a PUBLIC or SYSTEM keyword then introduces
 * quoted identifiers (two at most for PUBLIC, one for SYSTEM) in which a ">"
 * is an ordinary character; anything else is a bogus DOCTYPE that ends at the
 * next ">". An unterminated DOCTYPE swallows the rest of the input.
 *
 * @param {string} html - Markup
 * @param {number} from - Index right after "<!doctype"
 * @returns {number}
 */
function findDoctypeEnd(html, from) {
	const length = html.length;
	let i = from;
	const skipWhitespace = () => {
		while (i < length && isTokenizerWhitespace(html.charCodeAt(i))) i++;
	};
	const toNextGt = () => {
		const gt = html.indexOf(">", i);
		return gt === -1 ? length : gt + 1;
	};
	skipWhitespace();
	while (i < length && !isTokenizerWhitespace(html.charCodeAt(i)) && html.charCodeAt(i) !== 62) i++;
	skipWhitespace();
	let identifiers = 0;
	if (startsWithAsciiCI(html, i, "public")) identifiers = 2;
	else if (startsWithAsciiCI(html, i, "system")) identifiers = 1;
	else return toNextGt(); // no keyword (or ">" right here): the DOCTYPE ends at the next ">"
	i += 6;
	for (let n = 0; n < identifiers; n++) {
		skipWhitespace();
		const quote = html.charCodeAt(i);
		if (quote !== 34 && quote !== 39) return toNextGt(); // no (further) identifier
		const close = html.indexOf(quote === 34 ? '"' : "'", i + 1);
		if (close === -1) return length; // unterminated identifier
		i = close + 1;
	}
	return toNextGt();
}

/**
 * Value of an attribute in a raw attribute string (quoted or bare), or null.
 * Bounded by the attribute string itself, which the tokenizer has already
 * delimited with the tag's own ">".
 */
function attributeValue(attrs, name) {
	// Attributes are read in order with the tokenizer's grammar, so a quoted
	// value is never mistaken for the next attribute (`title="a href=x" href=y`
	// has href y). The first attribute of that name wins, as in the parser; one
	// present without a value is the empty string; absent is null.
	const attribute =
		/([^\t\n\f\r =/>"']+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'>]+)))?/g;
	for (const match of String(attrs || "").matchAll(attribute)) {
		if (asciiLower(match[1]) === name) return match[2] ?? match[3] ?? match[4] ?? "";
	}
	return null;
}

/**
 * Whether the text the converter will expose reaches a minimum length (stops
 * early): character references decoded, whitespace (non-breaking spaces
 * included) not counted, and nothing counted inside the elements the
 * converter drops or the parser keeps as raw text.
 */
function hasTextOfAtLeast(html, minimum) {
	let count = 0;
	const tree = createTreeTracker();
	tokenizeHtml(
		html,
		(tag) => tree.handle(tag),
		(text) => {
			if (tree.dropped || tree.inTemplate) return true;
			const visible = text.includes("&") ? decodeHtmlEntities(text) : text;
			count += visible.replace(/[\s\u00a0]+/g, "").length;
			return count < minimum;
		},
		tree.tokenizerOptions
	);
	return count >= minimum;
}

/** Start/end tags that still mean something inside an open <select> */
const SELECT_CONTENT = new Set(["option", "optgroup", "script", "template"]);

/** Row-group elements */
const TABLE_SECTIONS = new Set(["tbody", "thead", "tfoot"]);

/** Elements allowed inside <head>: any other start tag ends an unclosed <head> */
const HEAD_ELEMENTS = new Set([
	"head",
	"html",
	"title",
	"meta",
	"link",
	"style",
	"script",
	"base",
	"noscript",
	"template",
]);

/**
 * Simulation of the parser's stack of open elements — the one model behind
 * every pre-parser pass (depth estimate, region selection, title, base URL),
 * so they all agree on what the DOM will contain. It applies the tree
 * builder's rules that decide nesting and namespaces:
 *
 * - end tags pop to their element only when it is in scope (a closer below a
 *   scope boundary is ignored); the generic algorithm stops at special
 *   elements; formatting end tags obey the adoption agency (nothing popped);
 *   </form> removes only the form; </body> and </html> pop nothing;
 * - everyday unclosed <li>/<p>/<td>... are closed by their siblings, an
 *   unclosed <head> by the first non-head start tag;
 * - svg/math open foreign content, in which every start tag (HTML void names
 *   and <textarea>/<style>/<script> included) is a foreign element with
 *   children; "/>" closes it at once; a breakout start tag (div, p, font
 *   color=..., ...) and the </p> and </br> end tags pop the foreign elements
 *   and are reprocessed as HTML, where "/>" means nothing; end tags pop to
 *   the matching foreign element; integration points (svg foreignObject/desc/
 *   title, MathML mi/mo/mn/ms/mtext and annotation-xml with an HTML encoding)
 *   make their children HTML again; namespaces are bound per element.
 *
 * Also counts what the callers need: the depth, the list/blockquote nesting
 * (Turndown multiplies the output by it), whether the current position is
 * inside an element the converter drops, inside a <template>, or in foreign
 * content. `handle` returns false once a cap is exceeded: the page is
 * hostile, the caller stops scanning and the DOM route is refused.
 */
function createTreeTracker() {
	const stack = []; // element names (lowercase)
	const ns = []; // "svg" | "math" for foreign elements, null for HTML ones
	const integration = []; // the element is an integration point: its children are HTML
	let depth = 0;
	let prefixDepth = 0;
	let prefixes = 0; // list/blockquote ancestors currently open
	let dropped = 0; // ancestors the converter drops
	let templates = 0;
	let hostile = false;

	const isForeign = (i) => ns[i] !== null && !integration[i];
	/** The current node is a foreign (svg/math) element, integration point or not */
	const topIsForeign = () => stack.length > 0 && ns[stack.length - 1] !== null;
	/** Namespace the next token is processed in: that of the current node */
	const mode = () => {
		const top = stack.length - 1;
		return top >= 0 && isForeign(top) ? ns[top] : "html";
	};
	const openCounts = new Map(); // element name → how many are open
	const forget = (i) => {
		if (ns[i] === null && PREFIXING.has(stack[i])) prefixes--;
		if (DROP_ELEMENT_SET.has(stack[i])) dropped--;
		if (stack[i] === "template") templates--;
		openCounts.set(stack[i], openCounts.get(stack[i]) - 1);
	};
	const popTo = (index) => {
		for (let i = index; i < stack.length; i++) forget(i);
		stack.length = index;
		ns.length = index;
		integration.length = index;
	};
	const removeAt = (index) => {
		forget(index);
		stack.splice(index, 1);
		ns.splice(index, 1);
		integration.splice(index, 1);
	};
	const push = (name, namespace, isIntegration) => {
		stack.push(name);
		ns.push(namespace);
		integration.push(isIntegration);
		if (namespace === null && PREFIXING.has(name)) prefixes++;
		if (DROP_ELEMENT_SET.has(name)) dropped++;
		if (name === "template") templates++;
		openCounts.set(name, (openCounts.get(name) || 0) + 1);
		if (stack.length > depth) depth = stack.length;
		if (prefixes > prefixDepth) prefixDepth = prefixes;
		if (depth > MAX_DOM_DEPTH || prefixDepth > MAX_PREFIX_DEPTH) hostile = true;
	};
	/** Leave foreign content: pop until the current node is HTML or an integration point */
	const popForeign = () => {
		while (stack.length > 0 && isForeign(stack.length - 1)) popTo(stack.length - 1);
	};
	/**
	 * Start tag of a table part (td, th, tr, tbody, thead, tfoot, caption,
	 * colgroup, col) under the table insertion modes, decided by the nearest
	 * table-context element on the stack: a cell, row, row group, caption or
	 * colgroup that cannot contain the token is closed and the token
	 * reprocessed one level up; in the table itself the stack is cleared back
	 * to the table and the containers the source omits are inserted (the
	 * <tbody> a row lacks, the <tbody> and <tr> a cell lacks, the <colgroup>
	 * a <col> lacks). Outside any table the token is ignored, as in body.
	 * Returns false when the token is inside a <template> (inserted as written).
	 *
	 * @param {string} name - Tag name
	 * @returns {boolean} Handled
	 */
	const tableStart = (name) => {
		let i = stack.length - 1;
		while (i >= 0 && !(ns[i] === null && TABLE_CONTEXT.has(stack[i]))) i--;
		const context = i >= 0 ? stack[i] : null;
		if (context === null || context === "html") return true; // no table: ignored
		if (context === "template") return false;
		if (context === "td" || context === "th") {
			popTo(i); // close the cell, reprocess in the row
			return tableStart(name);
		}
		if (context === "tr") {
			if (name === "td" || name === "th") {
				popTo(i + 1); // clear back to the row
				push(name, null, false);
				return true;
			}
			popTo(i); // anything else closes the row
			return tableStart(name);
		}
		if (TABLE_SECTIONS.has(context)) {
			if (name === "td" || name === "th") {
				popTo(i + 1);
				push("tr", null, false); // the row the cell lacks
				push(name, null, false);
				return true;
			}
			if (name === "tr") {
				popTo(i + 1);
				push("tr", null, false);
				return true;
			}
			popTo(i); // caption, colgroup, col or another section close this one
			return tableStart(name);
		}
		if (context === "caption") {
			popTo(i); // acts as </caption>
			return tableStart(name);
		}
		if (context === "colgroup") {
			if (name === "col") return true; // void, inserted in the colgroup
			popTo(i);
			return tableStart(name);
		}
		// In the table itself: clear back to it, then insert (with implied containers)
		popTo(i + 1);
		if (name === "td" || name === "th") {
			push("tbody", null, false);
			push("tr", null, false);
			push(name, null, false);
		} else if (name === "tr") {
			push("tbody", null, false);
			push("tr", null, false);
		} else if (name === "col") {
			push("colgroup", null, false); // the colgroup the col lacks; col itself is void
		} else {
			push(name, null, false); // caption, colgroup, tbody, thead, tfoot
		}
		return true;
	};
	/**
	 * Index of the <select> the parser is "in select" for — the current node
	 * is a select, or an option/optgroup inside one — else -1
	 */
	const openSelectIndex = () => {
		for (let i = stack.length - 1; i >= 0; i--) {
			if (ns[i] !== null) return -1;
			if (stack[i] === "select") return i;
			if (stack[i] !== "option" && stack[i] !== "optgroup") return -1;
		}
		return -1;
	};

	/**
	 * Feed a tag. Returns false once the page exceeded a cap (stop scanning).
	 * @param {{name: string, closing: boolean, selfClosing: boolean, attrs: string, rawText: boolean}} tag
	 * @returns {boolean}
	 */
	const handle = (tag) => {
		const { name, closing, selfClosing, attrs } = tag;
		let current = mode();
		// In a MathML text integration point (mi, mo, mn, ms, mtext) the children
		// are HTML — except <mglyph> and <malignmark>, which stay MathML
		if (current === "html" && !closing && (name === "mglyph" || name === "malignmark")) {
			const top = stack.length - 1;
			if (top >= 0 && ns[top] === "math" && MATHML_TEXT_INTEGRATION.has(stack[top])) {
				current = "math";
			}
		}
		if (current !== "html") {
			if (!closing) {
				if (
					FOREIGN_BREAKOUT.has(name) &&
					(name !== "font" || hasAnyAttribute(attrs, FONT_BREAKOUT_ATTRIBUTES))
				) {
					// The breakout pops the foreign elements; the token is then
					// REPROCESSED under the HTML rules below ("<div/>" opens a div)
					popForeign();
				} else {
					// Any other start tag is a foreign element — an HTML void name
					// (<input>) or a raw-text name (<textarea>, <style>) included: it has
					// children, and the tokenizer stays in the data state
					tag.rawText = false;
					if (selfClosing) return !hostile; // "<path/>" is empty
					const top = stack.length - 1;
					// <svg> below a MathML <annotation-xml> is SVG; anything else keeps
					// the namespace it is inserted in
					const namespace =
						name === "svg" && stack[top] === "annotation-xml" && ns[top] === "math"
							? "svg"
							: current;
					push(name, namespace, isIntegrationPoint(name, attrs, namespace));
					return !hostile;
				}
			} else if (name === "p" || name === "br") {
				// </p> and </br> break out too, then follow the HTML end-tag rules
				popForeign();
			} else {
				// A foreign end tag pops to its element when one is open above the
				// nearest HTML element; otherwise the HTML rules decide
				for (let i = stack.length - 1; i >= 0; i--) {
					if (ns[i] === null) break;
					if (stack[i] === name) {
						popTo(i);
						return !hostile;
					}
				}
			}
		}

		// HTML rules
		// "In select": while a <select> is the current node (or an option/optgroup
		// inside it), the parser IGNORES almost every other token — no element is
		// inserted for a stray <base>, <title> or <div> there — until the select
		// is closed by </select>, another <select>, or an <input>/<textarea>/<hr>
		const selectIndex = openSelectIndex();
		if (selectIndex !== -1) {
			if (!closing) {
				if (name === "select") {
					popTo(selectIndex); // a nested <select> acts as </select>
					return !hostile;
				}
				if (name === "hr") {
					// <hr> is inserted INSIDE the select, closing an open option/optgroup:
					// void, so nothing is pushed and the select stays open
					while (stack.length - 1 > selectIndex) popTo(stack.length - 1);
					return !hostile;
				}
				if (name === "input" || name === "keygen" || name === "textarea") {
					popTo(selectIndex); // acts as </select>, then the token is reprocessed
				} else if (!SELECT_CONTENT.has(name)) {
					tag.rawText = false; // an ignored <title> never switches the tokenizer
					return !hostile;
				}
			} else if (name === "select") {
				popTo(selectIndex);
				return !hostile;
			} else if (!SELECT_CONTENT.has(name)) {
				return !hostile;
			}
		}
		if (
			!closing &&
			stack.length > 0 &&
			stack[stack.length - 1] === "head" &&
			!HEAD_ELEMENTS.has(name)
		) {
			popTo(stack.length - 1); // an unclosed <head> ends at the first body start tag
		}
		// </body> and </html> only change the parser's insertion mode: nothing is
		// popped, the open elements stay nested. Extra <body>/<html> start tags
		// are ignored by the parser as well.
		if (name === "body" || name === "html") {
			if (!closing && !stack.includes(name)) push(name, null, false);
			return !hostile;
		}
		if (closing) {
			// Pop to the matching open element, unless a scope boundary (object,
			// table, td, template, ...) sits above it: the parser then ignores the
			// end tag and everything stays open. Special elements have their own
			// end-tag rules ("in scope": stop at the scope boundaries; </li> adds
			// ul/ol, </p> adds button). Any other end tag uses the generic algorithm,
			// which gives up at the first SPECIAL element it meets
			// (`<span><div></span>` leaves the div open). The stack is capped, so
			// this walk is bounded.
			const special = SPECIAL_ELEMENTS.has(name);
			const extraBoundary = name === "li" ? LIST_SCOPE : name === "p" ? BUTTON_SCOPE : null;
			let index = -1;
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i] === name) {
					index = i;
					break;
				}
				if (special) {
					if (SCOPE_BOUNDARY.has(stack[i]) || extraBoundary?.has(stack[i])) break;
				} else if (SPECIAL_ELEMENTS.has(stack[i])) {
					break;
				}
			}
			if (index !== -1) {
				if (FORMATTING_ELEMENTS.has(name) && index !== stack.length - 1) {
					// Adoption agency: the end tag of a formatting element that is not
					// the current node leaves the block elements above it open and
					// RECONSTRUCTS the formatting element inside them, so the DOM only
					// gets deeper. Nothing is popped: the estimate stays an upper bound
					return !hostile;
				}
				if (name === "form" && index !== stack.length - 1) {
					// </form> removes only the form element; the descendants above it
					// stay open (`<form><nav></form>` keeps the nav open)
					removeAt(index);
					return !hostile;
				}
				popTo(index);
			}
			return !hostile;
		}
		if (name === "svg" || name === "math") {
			if (!selfClosing) push(name, name, false); // an empty <svg/> opens nothing
			return !hostile;
		}
		// Table parts first: a <col> (void) still inserts the colgroup it lacks
		if (TABLE_PARTS.has(name) && tableStart(name)) return !hostile;
		// "<div/>" opens a div: the slash is only meaningful on void elements
		if (VOID_ELEMENTS.has(name)) return !hostile;
		const closes = IMPLICIT_CLOSERS[name];
		if (closes) {
			while (stack.length > 0 && closes.includes(stack[stack.length - 1])) {
				popTo(stack.length - 1);
			}
		}
		push(name, null, false);
		return !hostile;
	};

	return {
		handle,
		/** Options for tokenizeHtml(): CDATA sections are opaque in foreign content */
		/**
		 * Options for tokenizeHtml(): a CDATA section opens whenever the current
		 * node is a foreign element — an integration point (foreignObject) INCLUDED,
		 * its children being HTML notwithstanding: the tokenizer's rule looks at the
		 * adjusted current node's namespace, not at the insertion mode
		 */
		tokenizerOptions: { inForeign: () => topIsForeign() },
		/** Deepest nesting seen so far */
		get depth() {
			return depth;
		},
		/** Deepest list/blockquote nesting seen so far */
		get prefixDepth() {
			return prefixDepth;
		},
		/** A cap was exceeded: the page is hostile */
		get hostile() {
			return hostile;
		},
		/** The next token is processed in foreign content (svg/math) */
		get inForeign() {
			return mode() !== "html";
		},
		/** The element just opened (the current node) is in the svg or MathML namespace */
		get topIsForeign() {
			return topIsForeign();
		},
		/** Inside a <template> (an inert fragment) */
		get inTemplate() {
			return templates > 0;
		},
		/** "In select": the parser ignores most tokens here */
		get inSelect() {
			return openSelectIndex() !== -1;
		},
		/** Inside an element the converter drops (nav, footer, form, svg, ...) */
		get dropped() {
			return dropped > 0;
		},
		/**
		 * How many elements of that name are open. Comparing before and after a
		 * tag tells whether the tag REALLY opened or closed one (an end tag the
		 * parser ignores, or a start tag it discards, changes nothing).
		 * @param {string} name
		 */
		openCount(name) {
			return openCounts.get(name) || 0;
		},
	};
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
	// The tree simulation says whether the element sits under a dropped one, and
	// whether a tag REALLY opened or closed it: an end tag the parser ignores
	// (`<main><table></main>` — the table is a scope boundary) does not end the
	// region, while a </div> that pops an open <main> with it does
	const tree = createTreeTracker();
	const names = Object.keys(marks);
	// Open instances per name, each flagged accepted (opened outside a dropped
	// element) or not: only an accepted instance's pop ends the region, so a
	// <main> inside a <nav> after the real one neither counts nor extends it
	const instances = Object.fromEntries(names.map((name) => [name, []]));
	tokenizeHtml(
		html,
		(tag) => {
			const before = names.map((name) => tree.openCount(name));
			if (!tree.handle(tag)) return false;
			names.forEach((name, index) => {
				const mark = marks[name];
				const open = instances[name];
				const after = tree.openCount(name);
				for (let k = before[index]; k < after; k++) {
					// A MathML/SVG element that happens to be named main is no region
					const accepted = !tree.dropped && !tree.topIsForeign;
					open.push(accepted);
					if (accepted) {
						mark.opens++;
						if (mark.start === -1) mark.start = tag.start;
					}
				}
				for (let k = after; k < before[index]; k++) {
					if (open.pop()) mark.end = tag.start; // an accepted instance was popped here
				}
			});
		},
		() => undefined,
		tree.tokenizerOptions
	);
	if (tree.hostile) return html;

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
export const MAX_DOM_DEPTH = 512;

/** Longest URL emitted for a link or image (browsers accept ~2 KB in practice) */
const MAX_URL_CHARS = 2048;

/**
 * Total URL characters emitted per document. Bounds the only expansion step
 * of the conversion (relative hrefs resolved against a long base URL).
 */
const MAX_URL_CHARS_PER_DOCUMENT = 300000;

/**
 * Estimate the maximum element nesting depth the parser would build, and how
 * deep lists and blockquotes nest (Turndown prefixes every line per ancestor,
 * so that depth multiplies the output), with the tree simulation of
 * createTreeTracker(). Stops as soon as either cap is exceeded, so the stack —
 * and each end tag's search through it — stays bounded.
 *
 * Exported for tests only: the estimate is the guard, so tests pin its value
 * on parser corner cases rather than infer it from timing.
 *
 * @param {string} html - Markup
 * @returns {{depth: number, prefixDepth: number}}
 */
export function estimateNesting(html) {
	const tree = createTreeTracker();
	tokenizeHtml(
		html,
		(tag) => tree.handle(tag),
		() => undefined,
		tree.tokenizerOptions
	);
	return { depth: tree.depth, prefixDepth: tree.prefixDepth };
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

/**
 * The parser's "special" category. The generic end-tag algorithm (used for
 * elements without their own end-tag rules, e.g. </span>) walks the stack and
 * gives up as soon as it meets a special element, so `<span><div></span>`
 * leaves the div open and nesting.
 */
const SPECIAL_ELEMENTS = new Set([
	"address",
	"applet",
	"area",
	"article",
	"aside",
	"base",
	"basefont",
	"bgsound",
	"blockquote",
	"body",
	"br",
	"button",
	"caption",
	"center",
	"col",
	"colgroup",
	"dd",
	"details",
	"dir",
	"div",
	"dl",
	"dt",
	"embed",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"frame",
	"frameset",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"hgroup",
	"hr",
	"html",
	"iframe",
	"img",
	"input",
	"keygen",
	"li",
	"link",
	"listing",
	"main",
	"marquee",
	"menu",
	"meta",
	"nav",
	"noembed",
	"noframes",
	"noscript",
	"object",
	"ol",
	"p",
	"param",
	"plaintext",
	"pre",
	"script",
	"search",
	"section",
	"select",
	"source",
	"style",
	"summary",
	"table",
	"tbody",
	"td",
	"template",
	"textarea",
	"tfoot",
	"th",
	"thead",
	"title",
	"tr",
	"track",
	"ul",
	"wbr",
	"xmp",
]);

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

/** Deepest list/blockquote nesting the DOM route accepts (real pages stay far below) */
const MAX_PREFIX_DEPTH = 16;

/**
 * Integration points: foreign elements whose children are parsed as HTML.
 * Bound to their namespace — an svg <desc> is one, a MathML <desc> is not.
 */
const SVG_INTEGRATION = new Set(["foreignobject", "desc", "title"]);
const MATHML_TEXT_INTEGRATION = new Set(["mi", "mo", "mn", "ms", "mtext"]);

/** Encodings that make a MathML <annotation-xml> an HTML integration point */
const INTEGRATION_ENCODINGS = new Set(["text/html", "application/xhtml+xml"]);

/**
 * Whether a start tag opens an integration point in its namespace: an svg
 * foreignObject, desc or title; a MathML text element (mi, mo, mn, ms,
 * mtext); or a MathML <annotation-xml> whose encoding attribute is text/html
 * or application/xhtml+xml (ASCII case-insensitive) — without that encoding
 * it is an ordinary MathML element and its children stay foreign.
 *
 * @param {string} name - Tag name
 * @param {string} attrs - Raw attribute text of the tag
 * @param {"svg"|"math"|null} namespace - Namespace the element is inserted in
 * @returns {boolean}
 */
function isIntegrationPoint(name, attrs, namespace) {
	if (namespace === "svg") return SVG_INTEGRATION.has(name);
	if (namespace !== "math") return false;
	if (MATHML_TEXT_INTEGRATION.has(name)) return true;
	if (name !== "annotation-xml") return false;
	const encoding = attributeValue(attrs, "encoding");
	return encoding !== null && INTEGRATION_ENCODINGS.has(asciiLower(encoding.trim()));
}

/**
 * HTML start tags that end foreign content (svg, math) in the HTML parser:
 * everything after them is ordinary HTML again and counts towards depth.
 * `font` is only a breakout when it carries one of FONT_BREAKOUT_ATTRIBUTES
 * (a bare <font> stays a foreign element).
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

/** Attributes that make a <font> start tag a breakout from foreign content */
const FONT_BREAKOUT_ATTRIBUTES = new Set(["color", "face", "size"]);

/**
 * Whether a tag's attribute string (as sliced by the tokenizer) names one of
 * `names`. Attribute names are ASCII case-insensitive; a value-less attribute
 * (`<font color>`) counts. Single pass over the string.
 *
 * @param {string} attrs - Raw attribute text of a start tag
 * @param {Set<string>} names - Lowercase attribute names
 * @returns {boolean}
 */
function hasAnyAttribute(attrs, names) {
	if (!attrs) return false;
	const attribute =
		/([^\t\n\f\r =/>"']+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"[^"]*"|'[^']*'|[^\t\n\f\r "'>]+))?/g;
	for (const match of attrs.matchAll(attribute)) {
		if (names.has(asciiLower(match[1]))) return true;
	}
	return false;
}

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
 * @param {string} html - Full document
 * @returns {string} Title text, or "" when the document has none
 */
export function extractHtmlTitle(html) {
	// One tokenizer pass: the first <title> wins; the first <h1> is the fallback
	const source = String(html ?? "");
	let title = null;
	let heading = null;
	let collecting = null; // "title" | "h1" while inside the element being captured
	let buffer = [];
	// The tree simulation tells what each element is: a <title> in svg/math is a
	// graphic's label and anything in a <template> is inert (neither is a
	// page-title candidate — but <svg><foreignObject><title> is HTML again, and
	// <svg><div><title> too, the div having broken out); the heading fallback
	// skips the elements the converter drops (a menu's <h1> is not the title)
	const tree = createTreeTracker();
	tokenizeHtml(
		source,
		(tag) => {
			const { name, closing } = tag;
			// What the element IS depends on where it is inserted: judge <title>
			// by the state before the tag (its parent's namespace); one the parser
			// ignores (inside an open <select>) is no title at all
			const inert = tree.inTemplate || tree.inForeign || tree.inSelect;
			const openBefore = collecting ? tree.openCount(collecting) : 0;
			if (!tree.handle(tag)) return false;
			if (collecting) {
				// The element ends where the tree pops it: its own end tag, a start
				// tag that closes it implicitly (<h2> after an unclosed <h1>), or a
				// same-name start tag that replaces it (<h1>A<h1>B)
				const ended = tree.openCount(collecting) < openBefore || (!closing && name === collecting);
				if (ended) {
					const text = buffer.join(" ");
					if (collecting === "title") title = text;
					else heading = text;
					collecting = null;
					buffer = [];
					return title === null; // stop once the title is known
				}
				return true;
			}
			if (closing) return true;
			if (name === "title" && title === null && !inert) collecting = "title";
			else if (name === "h1" && heading === null && !tree.inForeign && !tree.dropped) {
				collecting = "h1";
			}
			return true;
		},
		(text) => {
			if (collecting) buffer.push(text);
			return true;
		},
		tree.tokenizerOptions
	);
	return decodeHtmlEntities(title ?? heading ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Whether a text starts like an HTML document: an optional BOM and whitespace,
 * any number of comments (ended by "-->", "--!>" or the abrupt "<!-->" and
 * "<!--->", exactly as the tokenizer ends them), then "<!doctype html",
 * "<html", "<head" or "<body". Only the leading structure counts: a text that
 * merely contains "<html>" somewhere is the plain text it claims to be.
 * Linear: each comment is skipped once.
 *
 * @param {string} text - Decoded body
 * @returns {boolean}
 */
export function startsLikeHtmlDocument(text) {
	const source = String(text ?? "");
	let pos = 0;
	for (;;) {
		while (
			pos < source.length &&
			(isTokenizerWhitespace(source.charCodeAt(pos)) || source[pos] === "\uFEFF")
		) {
			pos++;
		}
		if (!source.startsWith("<!--", pos)) break;
		const end = findCommentEnd(source, pos + 4);
		if (end >= source.length) return false; // unterminated, or nothing after it
		pos = end;
	}
	return /^<(?:!doctype[\t\n\f\r ]+html|html|head|body)(?:[\t\n\f\r />]|$)/i.test(
		source.slice(pos, pos + 64)
	);
}

/**
 * Character encoding declared by a <meta> element in the leading bytes of an
 * HTML document (`<meta charset=...>`, or the http-equiv Content-Type form),
 * or null. One tokenizer pass: a "<meta" inside a comment, a script/style
 * body or a quoted attribute value is text, not a declaration — and a "<!--"
 * inside a quoted attribute value does not start a comment.
 *
 * @param {string} head - Leading bytes of the document, decoded as latin1
 * @returns {string|null}
 */
/**
 * A meta-declared encoding label the decoder can use, or null: unknown labels
 * are ignored (the prescan skips them), and a UTF-16 label is read as UTF-8 —
 * an ASCII-readable <meta> cannot be in a UTF-16 document (the prescan's rule).
 *
 * @param {string|null|undefined} label
 * @returns {string|null}
 */
function usableEncodingLabel(label) {
	const trimmed = String(label ?? "").trim();
	if (!trimmed) return null;
	if (/^utf-?16(?:le|be)?$/i.test(trimmed)) return "utf-8";
	try {
		new TextDecoder(trimmed);
		return trimmed;
	} catch {
		return null;
	}
}

export function sniffMetaCharset(head) {
	let found = null;
	tokenizeHtml(
		String(head ?? ""),
		({ name, closing, attrs }) => {
			if (closing || name !== "meta") return true;
			// A label no decoder knows is skipped and the scan goes on, as the
			// prescan does: a later usable declaration still counts
			const charset = usableEncodingLabel(attributeValue(attrs, "charset"));
			if (charset) {
				found = charset;
				return false;
			}
			const httpEquiv = attributeValue(attrs, "http-equiv");
			const content = attributeValue(attrs, "content");
			if (httpEquiv !== null && httpEquiv.trim().toLowerCase() === "content-type" && content) {
				const inContent = usableEncodingLabel(
					content.match(/charset\s*=\s*["']?\s*([a-z0-9_-]+)/i)?.[1]
				);
				if (inContent) {
					found = inContent;
					return false;
				}
			}
			return true;
		},
		() => undefined
	);
	return found;
}

/**
 * Effective base URL of a document: its first <base href> (resolved against
 * the response URL, as browsers do), else the response URL itself. One
 * tokenizer pass that stops at the first live <base href>.
 *
 * @param {string} html - Full document
 * @param {string|undefined} responseUrl - URL the document was fetched from
 * @returns {string|undefined}
 */
function documentBaseUrl(html, responseUrl) {
	let base = responseUrl;
	// A <base> inside <template> (a separate document fragment) or in foreign
	// content (an svg:base is not an HTML base) does not establish the document
	// base. The tree simulation knows breakouts and integration points:
	// <svg><div><base> is live, the div having left the svg
	const tree = createTreeTracker();
	tokenizeHtml(
		html,
		(tag) => {
			// ...and a <base> the parser ignores (inside an open <select>) is not one
			const inert = tree.inTemplate || tree.inForeign || tree.inSelect;
			if (!tree.handle(tag)) return false;
			if (inert || tag.closing || tag.name !== "base") return true;
			// A <base> without href (target only) does not count: keep looking.
			// Attribute values are raw source: character references are decoded
			// ("&amp;" in the source is "&" in the URL), as the parser does
			const rawHref = attributeValue(tag.attrs, "href");
			if (rawHref === null) return true;
			const href = decodeHtmlEntities(rawHref).trim();
			try {
				// Judged on the parsed URL (tabs/newlines stripped by the parser):
				// only an http(s) base can be a base for links
				const parsed = responseUrl ? new URL(href, responseUrl) : new URL(href);
				if (parsed.protocol === "http:" || parsed.protocol === "https:") {
					base = parsed.toString();
				}
			} catch {
				// Malformed base: keep the response URL
			}
			return false; // the first <base href> wins, as in browsers
		},
		() => undefined,
		tree.tokenizerOptions
	);
	return base;
}

/** Schemes never emitted as link or image targets */
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "vbscript:"]);

function resolveUrl(href, baseUrl) {
	const clean = String(href || "").trim();
	if (!clean) return null;
	try {
		// The scheme is judged on the PARSED URL: WHATWG parsing strips tabs and
		// newlines, so "java\tscript:" becomes "javascript:" and must be caught
		const url = baseUrl ? new URL(clean, baseUrl) : new URL(clean);
		return BLOCKED_SCHEMES.has(url.protocol) ? null : url.toString();
	} catch {
		// Unparsable (relative without a base, garbage): keep the raw text unless
		// it spells a blocked scheme once the characters the parser drops are gone
		const collapsed = clean.replace(/[\t\n\r]/g, "").toLowerCase();
		return /^(?:javascript|data|vbscript)\s*:/.test(collapsed) ? null : clean;
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
/**
 * Split Markdown text into alternating [text, code, text, code, ..., text]
 * segments on inline code spans, with CommonMark's rule: a backtick run opens
 * a span that the next run of exactly the same length closes (a longer or
 * shorter run inside is content); an unmatched run is text, and so is a
 * backslash-escaped backtick (how Turndown writes a literal one). Linear: the
 * runs are collected in one pass and matched with one cursor per run length.
 *
 * @param {string} text
 * @returns {string[]} Even indexes are text, odd indexes are code spans
 */
function splitInlineCode(text) {
	const runs = [];
	for (let i = text.indexOf("`"); i !== -1; ) {
		let length = 0;
		while (text.charCodeAt(i + length) === 96) length++;
		if (i === 0 || text.charCodeAt(i - 1) !== 92) runs.push({ start: i, length });
		i = text.indexOf("`", i + length);
	}
	const byLength = new Map(); // run length → indexes of the runs with it
	runs.forEach((run, index) => {
		if (!byLength.has(run.length)) byLength.set(run.length, []);
		byLength.get(run.length).push(index);
	});
	const cursors = new Map();
	const parts = [];
	let plain = 0;
	let r = 0;
	while (r < runs.length) {
		const { start, length } = runs[r];
		const list = byLength.get(length);
		let c = cursors.get(length) || 0;
		while (c < list.length && list[c] <= r) c++;
		cursors.set(length, c);
		if (c >= list.length) {
			r++; // no closing run of that length: literal backticks
			continue;
		}
		const close = runs[list[c]];
		parts.push(text.slice(plain, start), text.slice(start, close.start + length));
		plain = close.start + length;
		r = list[c] + 1;
	}
	parts.push(text.slice(plain));
	return parts;
}

/** Whitespace and punctuation cleanup of a prose segment (never applied to code) */
function tidyProse(text) {
	return text
		.replace(/^(\s*)-\s{2,}(?=\S)/gm, "$1- ")
		.replace(/^(\s*\d+\.)\s{2,}(?=\S)/gm, "$1 ")
		.replace(/ +([,.;:!?)\]])/g, "$1")
		.replace(/\n{3,}/g, "\n\n");
}

function tidyMarkdown(markdown) {
	const out = [];
	let prose = [];
	let inFence = false;
	const flush = () => {
		if (prose.length === 0) return;
		// Inline code spans are content: "div :hover" or "a ; b" must not lose
		// their spaces, so only the text between spans is tidied
		out.push(
			splitInlineCode(prose.join("\n"))
				.map((segment, index) => (index % 2 === 0 ? tidyProse(segment) : segment))
				.join("")
		);
		prose = [];
	};
	// A fence closes only with a backtick run at least as long as the opener:
	// Turndown lengthens the fence around code that itself contains ```
	let fenceLength = 0;
	for (const line of markdown.split("\n")) {
		const fence = line.match(/^\s*(`{3,})\s*(\S*)\s*$/);
		if (!inFence && fence) {
			flush();
			out.push(line);
			inFence = true;
			fenceLength = fence[1].length;
			continue;
		}
		if (inFence && fence && fence[1].length >= fenceLength && !fence[2]) {
			out.push(line);
			inFence = false;
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
