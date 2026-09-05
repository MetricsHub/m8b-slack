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

/** Elements whose content is raw text (no tags inside) until their closer */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp"]);

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

function isTagNameChar(code) {
	return (
		(code >= 97 && code <= 122) || // a-z
		(code >= 65 && code <= 90) || // A-Z
		(code >= 48 && code <= 57) || // 0-9
		code === 45 || // -
		code === 58 // :
	);
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
 * @param {(tag: {name: string, closing: boolean, selfClosing: boolean}) => (boolean|void)} onTag
 * @param {(text: string) => (boolean|void)} onText
 */
function tokenizeHtml(html, onTag, onText) {
	const length = html.length;
	let lower = null; // lowercased copy, built once, only when a raw-text element shows up
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
				const end = html.indexOf("-->", lt + 4);
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
		let nameEnd = nameStart + 1;
		while (nameEnd < length && isTagNameChar(html.charCodeAt(nameEnd))) nameEnd++;

		const gt = gtAfter(nameEnd);
		if (gt === -1) return; // unterminated tag: the rest of the input is lost, as in browsers
		const name = html.slice(nameStart, nameEnd).toLowerCase();
		const selfClosing = !closing && gt > nameEnd && html.charCodeAt(gt - 1) === 47;
		if (onTag({ name, closing, selfClosing }) === false) return;
		pos = gt + 1;

		if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
			// Raw text until the matching closer (or the end of input)
			if (lower === null) lower = html.toLowerCase();
			const close = lower.indexOf(`</${name}`, pos);
			if (close === -1) return;
			const closeGt = gtAfter(close);
			if (onTag({ name, closing: true, selfClosing: false }) === false) return;
			pos = closeGt === -1 ? length : closeGt + 1;
		}
	}
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
 * Text content of a fragment (tags dropped, raw-text bodies skipped), linear.
 */
function textOfHtml(html) {
	const parts = [];
	tokenizeHtml(
		html,
		() => undefined,
		(text) => {
			parts.push(text);
		}
	);
	return decodeHtmlEntities(parts.join(" ")).replace(/\s+/g, " ").trim();
}

/**
 * Narrow the document to the region worth reading: a single <main>, else a
 * single <article>, else the <body>, else everything. Index scans only.
 */
function selectContentRegion(html) {
	const lower = html.toLowerCase();
	for (const tag of ["main", "article"]) {
		const start = lower.indexOf(`<${tag}`);
		if (start === -1 || lower.indexOf(`<${tag}`, start + 1) !== -1) continue;
		const end = lower.lastIndexOf(`</${tag}`);
		const region = end > start ? html.slice(start, end) : html.slice(start);
		if (hasTextOfAtLeast(region, 200)) return region;
	}
	const bodyStart = lower.indexOf("<body");
	if (bodyStart === -1) return html;
	const bodyEnd = lower.lastIndexOf("</body");
	return bodyEnd > bodyStart ? html.slice(bodyStart, bodyEnd) : html.slice(bodyStart);
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
 * closed by their siblings. Stops as soon as the cap is exceeded, so the
 * stack — and each closer's search through it — stays bounded.
 */
function estimateMaxNestingDepth(html) {
	const stack = [];
	let max = 0;
	tokenizeHtml(
		html,
		({ name, closing, selfClosing }) => {
			if (closing) {
				const index = stack.lastIndexOf(name);
				if (index !== -1) stack.length = index;
				return true;
			}
			if (selfClosing || VOID_ELEMENTS.has(name)) return true;
			const closes = IMPLICIT_CLOSERS[name];
			if (closes) {
				while (stack.length > 0 && closes.includes(stack[stack.length - 1])) stack.pop();
			}
			stack.push(name);
			if (stack.length > max) max = stack.length;
			return max <= MAX_DOM_DEPTH;
		},
		() => undefined
	);
	return max;
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
			if (skipping) {
				if (name === skipping && !selfClosing) {
					skipDepth += closing ? -1 : 1;
					if (skipDepth === 0) skipping = null;
				}
				return true;
			}
			if (!closing && !selfClosing && FALLBACK_DROP.has(name)) {
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
	const source = String(html ?? "");
	const title = source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
	const raw = title?.[1] || source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i)?.[1] || "";
	return textOfHtml(raw);
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

	// Region first (linear string scan), then a real HTML parse: the DOM handles
	// comments, broken markup and unterminated tags; DROP_ELEMENTS are removed
	// as nodes, whatever their nesting
	source = selectContentRegion(source);

	// Hostile nesting depth: the parser's cost grows quadratically with it and
	// the converter recurses per level. Refuse the DOM route up front.
	if (estimateMaxNestingDepth(source) > MAX_DOM_DEPTH) {
		return stripTagsFallback(source);
	}

	let markdown;
	try {
		markdown = createConverter(baseUrl).turndown(source);
	} catch {
		// Parser failure or stack exhaustion on input the estimate let through:
		// degrade to plain text rather than fail the whole read
		return stripTagsFallback(source);
	}

	// Post-pass: compact list markers (Turndown pads them to a 4-column
	// indent), punctuation glued back to the word it follows, no runs of
	// blank lines. Fenced code blocks are left untouched (private-use code
	// points delimit the placeholders; real text never contains them).
	const codeBlocks = [];
	markdown = markdown.replace(/```[\s\S]*?```/g, (block) => {
		codeBlocks.push(block);
		return `${codeBlocks.length - 1}`;
	});
	markdown = markdown
		.replace(/^(\s*)-\s{2,}(?=\S)/gm, "$1- ")
		.replace(/^(\s*\d+\.)\s{2,}(?=\S)/gm, "$1 ")
		.replace(/ +([,.;:!?)\]])/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/(\d+)/g, (_m, index) => codeBlocks[Number(index)] || "");

	return markdown.trim();
}
