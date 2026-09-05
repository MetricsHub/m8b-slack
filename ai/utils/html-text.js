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

/**
 * Narrow the document to the region worth reading: a single <main>, else a
 * single <article>, else the <body>, else everything. Plain index scans only:
 * linear in the page size whatever the nesting depth (the page is
 * attacker-controlled; noise elements are removed later, in the DOM).
 */
function selectContentRegion(html) {
	const lower = html.toLowerCase();
	for (const tag of ["main", "article"]) {
		const opens = html.match(new RegExp(`<${tag}\\b`, "gi"));
		if (!opens || opens.length !== 1) continue;
		const start = lower.indexOf(`<${tag}`);
		const end = lower.lastIndexOf(`</${tag}`);
		const region = end > start ? html.slice(start, end) : html.slice(start);
		if (region.replace(/<[^>]+>/g, "").trim().length > 200) return region;
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
 * Estimate the maximum element nesting depth with a single linear tag scan
 * (no parsing: an upper bound is all that is needed to refuse hostile input).
 */
function estimateMaxNestingDepth(html) {
	let depth = 0;
	let max = 0;
	const tags = /<(\/?)([a-z][a-z0-9-]*)[^>]*?(\/?)>/gi;
	for (const match of html.matchAll(tags)) {
		const [, closing, name, selfClosing] = match;
		if (closing) {
			depth = Math.max(0, depth - 1);
		} else if (!selfClosing && !VOID_ELEMENTS.has(name.toLowerCase())) {
			depth++;
			if (depth > max) {
				max = depth;
				if (max > MAX_DOM_DEPTH) return max;
			}
		}
	}
	return max;
}

/**
 * Last-resort conversion when the DOM route is refused (hostile nesting
 * depth) or fails (parser error, stack exhaustion): strip tags, keep the
 * text. Linear; navigation/footer content is not removed in this mode.
 */
function stripTagsFallback(html) {
	return decodeHtmlEntities(
		html
			.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
			.replace(/<\/(?:p|div|li|h[1-6]|tr|br|section|article)\b[^>]*>|<br\b[^>]*>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
	)
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
	return decodeHtmlEntities(raw.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
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
