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
const IMPLICIT_CLOSERS = {
	li: ["li"],
	p: ["p"],
	dt: ["dt", "dd"],
	dd: ["dt", "dd"],
	option: ["option"],
	optgroup: ["option", "optgroup"],
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
 * @param {(tag: {name: string, closing: boolean, selfClosing: boolean, start: number, end: number, attrs: string, rawText: boolean}) => (boolean|void)} onTag
 *   Called per tag; return false to stop. `rawText` tells whether the body that
 *   follows is tokenized as raw text/RCDATA — clear it for a tag that opens in
 *   foreign content, where the parser never switches state.
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
			if (name === "plaintext") return; // the rest of the document is text
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
	// Attributes are read in order with the tokenizer's grammar, so a quoted
	// value is never mistaken for the next attribute (`title="a href=x" href=y`
	// has href y). The first attribute of that name wins, as in the parser; one
	// present without a value is the empty string; absent is null.
	const attribute = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
	for (const match of String(attrs || "").matchAll(attribute)) {
		if (asciiLower(match[1]) === name) return match[2] ?? match[3] ?? match[4] ?? "";
	}
	return null;
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

/** Start/end tags that still mean something inside an open <select> */
const SELECT_CONTENT = new Set(["option", "optgroup", "script", "template"]);

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
	/** Namespace the next token is processed in: that of the current node */
	const mode = () => {
		const top = stack.length - 1;
		return top >= 0 && isForeign(top) ? ns[top] : "html";
	};
	const forget = (i) => {
		if (ns[i] === null && PREFIXING.has(stack[i])) prefixes--;
		if (DROP_ELEMENT_SET.has(stack[i])) dropped--;
		if (stack[i] === "template") templates--;
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
		if (stack.length > depth) depth = stack.length;
		if (prefixes > prefixDepth) prefixDepth = prefixes;
		if (depth > MAX_DOM_DEPTH || prefixDepth > MAX_PREFIX_DEPTH) hostile = true;
	};
	/** Leave foreign content: pop until the current node is HTML or an integration point */
	const popForeign = () => {
		while (stack.length > 0 && isForeign(stack.length - 1)) popTo(stack.length - 1);
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
		const current = mode();
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
				if (name === "input" || name === "keygen" || name === "textarea" || name === "hr") {
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
	// The tree simulation says whether the element sits under a dropped one
	const tree = createTreeTracker();
	tokenizeHtml(
		html,
		(tag) => {
			if (!tree.handle(tag)) return false;
			const mark = marks[tag.name];
			if (!mark || tree.dropped) return;
			if (tag.closing) {
				mark.end = tag.start; // the last closer wins
			} else {
				mark.opens++;
				if (mark.start === -1) mark.start = tag.start;
			}
		},
		() => undefined
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
		() => undefined
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
	const attribute = /([^\s=/>"']+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;
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
			if (!tree.handle(tag)) return false;
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
		}
	);
	return decodeHtmlEntities(title ?? heading ?? "")
		.replace(/\s+/g, " ")
		.trim();
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
export function sniffMetaCharset(head) {
	let found = null;
	tokenizeHtml(
		String(head ?? ""),
		({ name, closing, attrs }) => {
			if (closing || name !== "meta") return true;
			const charset = attributeValue(attrs, "charset");
			if (charset?.trim()) {
				found = charset.trim();
				return false;
			}
			const httpEquiv = attributeValue(attrs, "http-equiv");
			const content = attributeValue(attrs, "content");
			if (httpEquiv !== null && httpEquiv.trim().toLowerCase() === "content-type" && content) {
				const inContent = content.match(/charset\s*=\s*["']?\s*([a-z0-9_-]+)/i);
				if (inContent) {
					found = inContent[1];
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
		() => undefined
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
