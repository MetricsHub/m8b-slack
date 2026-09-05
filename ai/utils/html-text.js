/**
 * Minimal HTML → Markdown-ish text conversion for the fetch_url tool.
 *
 * Deliberately dependency-free: the goal is readable text for a language
 * model, not a faithful rendering. Scripts, styles, navigation, footers and
 * asides are dropped; headings, paragraphs, lists, code blocks, links and
 * tables are kept in a Markdown-like form.
 */

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
 * Decode HTML character references (named, decimal, hexadecimal).
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
	return normalizeInline(decodeHtmlEntities(raw.replace(/<[^>]+>/g, " "))).trim();
}

function normalizeInline(text) {
	return text.replace(/[ \t\r\f\v]+/g, " ").replace(/ ?\n ?/g, "\n");
}

function resolveHref(href, baseUrl) {
	const clean = decodeHtmlEntities(href).trim();
	if (!clean || /^(javascript|data|mailto|tel):/i.test(clean) || clean.startsWith("#")) {
		return null;
	}
	if (!baseUrl) return clean;
	try {
		return new URL(clean, baseUrl).toString();
	} catch {
		return clean;
	}
}

/**
 * Convert an HTML table (already free of nested tables) to a Markdown table.
 */
function tableToMarkdown(tableHtml) {
	const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) =>
		[...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map((cell) =>
			normalizeInline(
				decodeHtmlEntities(cell[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))
			)
				.replace(/\s*\n\s*/g, " ")
				.replace(/\|/g, "\\|")
				.trim()
		)
	);
	const nonEmpty = rows.filter((cells) => cells.length > 0);
	if (nonEmpty.length === 0) return "";

	const width = Math.max(...nonEmpty.map((cells) => cells.length));
	const pad = (cells) => [...cells, ...Array(width - cells.length).fill("")];
	const line = (cells) => `| ${pad(cells).join(" | ")} |`;
	const [header, ...body] = nonEmpty;
	return `\n\n${[line(header), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(line)].join("\n")}\n\n`;
}

/**
 * Convert an HTML document to Markdown-ish plain text.
 *
 * @param {string} html - Raw HTML document or fragment
 * @param {Object} [options]
 * @param {string} [options.baseUrl] - Page URL used to resolve relative links
 * @returns {string} Readable text with Markdown headings, lists, links, code blocks and tables
 */
export function htmlToMarkdown(html, { baseUrl } = {}) {
	let text = String(html ?? "");

	// Comments and CDATA first: they may contain tags that would confuse the rest
	text = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
	text = text.replace(/<!doctype[^>]*>/gi, " ");

	// Noise elements (nested-safe)
	for (const tag of DROP_ELEMENTS) {
		text = dropElement(text, tag);
	}
	text = selectContentRegion(text);

	// Protect preformatted blocks: their whitespace must survive the collapsing
	// below, and their inner tags (syntax highlighting spans) are just noise
	const codeBlocks = [];
	text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_match, inner) => {
		const language =
			inner.match(/<code\b[^>]*class="[^"]*(?:language|lang)-([\w#+-]+)/i)?.[1] || "";
		const code = decodeHtmlEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
			.replace(/^\n+|\n+$/g, "")
			.trimEnd();
		codeBlocks.push(`\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`);
		return `\uE000PRE${codeBlocks.length - 1}\uE000`;
	});

	// Tables (innermost first so nested layout tables degrade gracefully)
	const tablePattern = /<table\b(?:(?!<table\b)[\s\S])*?<\/table\s*>/gi;
	let previous;
	do {
		previous = text;
		text = text.replace(tablePattern, (table) => tableToMarkdown(table));
	} while (text !== previous);

	// Block structure
	text = text.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level, inner) => {
		const heading = inner
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim();
		return heading ? `\n\n${"#".repeat(Number(level))} ${heading}\n\n` : "\n\n";
	});
	text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (_m, inner) => {
		const quote = inner
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return quote ? `\n\n> ${quote}\n\n` : "\n\n";
	});
	text = text.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li\s*>/gi, "\n");
	text = text.replace(/<(?:ul|ol|dl)\b[^>]*>|<\/(?:ul|ol|dl)\s*>/gi, "\n\n");
	text = text.replace(/<dt\b[^>]*>/gi, "\n**").replace(/<\/dt\s*>/gi, "**\n");
	text = text.replace(/<dd\b[^>]*>/gi, "\n  ").replace(/<\/dd\s*>/gi, "\n");
	text = text.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(
		/<\/?(?:p|div|section|article|header|main|figure|figcaption|details|summary|address|tr|thead|tbody|tfoot)\b[^>]*>/gi,
		"\n\n"
	);

	// Inline semantics
	text = text.replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi, (_m, alt) => {
		const label = alt.trim();
		return label ? ` [image: ${label}] ` : " ";
	});
	text = text.replace(
		/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
		(_m, href, inner) => {
			const label = decodeHtmlEntities(inner.replace(/<[^>]+>/g, " "))
				.replace(/\s+/g, " ")
				.trim();
			const target = resolveHref(href, baseUrl);
			if (!label) return " ";
			if (!target || label === target) return ` ${label} `;
			return ` [${label}](${target}) `;
		}
	);
	text = text.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, (_m, inner) => {
		const content = inner.trim();
		return content ? `**${content}**` : "";
	});
	text = text.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, (_m, inner) => {
		const content = inner.trim();
		return content ? `*${content}*` : "";
	});
	text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, inner) => {
		const content = inner.replace(/<[^>]+>/g, "").trim();
		return content ? `\`${content}\`` : "";
	});

	// Everything else: strip tags, decode entities, collapse whitespace
	text = text.replace(/<[^>]+>/g, " ");
	text = decodeHtmlEntities(text);
	text = text
		.replace(/[ \t\r\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/ +([,.;:!?)\]])/g, "$1")
		.replace(/\n{3,}/g, "\n\n");

	// Restore code blocks
	text = text.replace(/\uE000PRE(\d+)\uE000/g, (_m, index) => codeBlocks[Number(index)] || "");

	return text.replace(/\n{3,}/g, "\n\n").trim();
}
