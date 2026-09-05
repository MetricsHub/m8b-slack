/**
 * HTML → Markdown conversion for the fetch_url tool.
 *
 * The conversion itself is Turndown (with the GFM plugin for tables and
 * strikethrough). What this module adds is the part specific to feeding a
 * language model: a pre-pass that drops page furniture (scripts, styles,
 * navigation, footers, asides — nested ones included, on broken markup too)
 * and narrows the document to its main content region, link/image resolution
 * against the page URL, and a compact list/whitespace style.
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
 * Remove every occurrence of an element, nested instances included. Innermost
 * matches go first so `<nav>…<nav>…</nav>…</nav>` disappears entirely.
 */
function dropElement(html, tag) {
	const pattern = new RegExp(`<${tag}\\b(?:(?!<${tag}\\b)[\\s\\S])*?</${tag}\\s*>`, "gi");
	let previous;
	let current = html;
	do {
		previous = current;
		current = current.replace(pattern, " ");
	} while (current !== previous);
	// Unterminated opening tag: drop to the end (a broken page is still noise)
	return current.replace(new RegExp(`<${tag}\\b[\\s\\S]*$`, "i"), " ");
}

/**
 * Pick the content region worth reading: a single <main>, else a single
 * <article>, else the <body>, else the whole document.
 */
function selectContentRegion(html) {
	for (const tag of ["main", "article"]) {
		const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "gi");
		const matches = [...html.matchAll(pattern)];
		if (matches.length === 1 && matches[0][1].replace(/<[^>]+>/g, "").trim().length > 200) {
			return matches[0][1];
		}
	}
	const body = html.match(/<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i);
	return body ? body[1] : html;
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

	// Links: absolute URLs, no duplicate of the label, no javascript: targets
	service.addRule("absoluteLinks", {
		filter: (node) => node.nodeName === "A" && Boolean(node.getAttribute("href")),
		replacement: (content, node) => {
			const label = content.replace(/\s+/g, " ").trim();
			if (!label) return "";
			const target = resolveUrl(node.getAttribute("href"), baseUrl);
			if (!target || target.startsWith("#") || label === target) return label;
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
			const src = resolveUrl(node.getAttribute("src"), baseUrl);
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

	// Pre-pass: comments, page furniture (nested-safe, tolerant of unterminated
	// tags), then the main content region
	source = source.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
	for (const tag of DROP_ELEMENTS) {
		source = dropElement(source, tag);
	}
	source = selectContentRegion(source);

	let markdown = createConverter(baseUrl).turndown(source);

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
