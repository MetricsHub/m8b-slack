/**
 * Tests for the HTML → Markdown conversion (Turndown + model-oriented pre/post passes).
 */

import { describe, expect, it } from "@jest/globals";
import {
	decodeHtmlEntities,
	estimateNesting,
	extractHtmlTitle,
	htmlToMarkdown,
	MAX_DOM_DEPTH,
} from "../html-text.js";

const PAGE = `<!DOCTYPE html>
<html><head><title>Install &amp; Configure &mdash; Docs</title>
<style>body { color: red }</style>
<script>window.track = function () { return "noise"; };</script>
</head>
<body>
<nav><ul><li><a href="/">Home</a></li><li><a href="/docs">Docs<nav>nested</nav></a></li></ul></nav>
<main>
<h1>Install &amp; Configure</h1>
<p>Download the <a href="../releases/latest">latest release</a>, then run the installer. This paragraph is
long enough to make the main region the obvious content of the page for the region selector.</p>
<h2>Steps</h2>
<ul>
  <li>Unpack the <code>archive</code></li>
  <li>Run <strong>setup</strong> as <em>root</em></li>
</ul>
<pre><code class="language-bash">./setup   --prefix=/opt   &amp;&amp; echo   done
echo "&lt;ok&gt;"</code></pre>
<table>
  <tr><th>Option</th><th>Default</th></tr>
  <tr><td>port</td><td>8080 | 8443</td></tr>
</table>
<blockquote>Do not run as a service user.</blockquote>
<img src="/x.png" alt="Architecture diagram">
<script>inline()</script>
</main>
<footer>Copyright &copy; 2026 Example</footer>
</body></html>`;

describe("htmlToMarkdown", () => {
	const text = htmlToMarkdown(PAGE, { baseUrl: "https://docs.example.com/guide/install.html" });

	it("drops scripts, styles, navigation and footers (nested ones included)", () => {
		expect(text).not.toContain("window.track");
		expect(text).not.toContain("inline()");
		expect(text).not.toContain("color: red");
		expect(text).not.toContain("Home");
		expect(text).not.toContain("nested");
		expect(text).not.toContain("Copyright");
	});

	it("keeps headings, paragraphs, lists and quotes as Markdown", () => {
		expect(text).toContain("# Install & Configure");
		expect(text).toContain("## Steps");
		expect(text).toContain("- Unpack the `archive`");
		expect(text).toContain("- Run **setup** as *root*");
		expect(text).toContain("> Do not run as a service user.");
	});

	it("resolves relative links and images against the page URL", () => {
		expect(text).toContain(
			"Download the [latest release](https://docs.example.com/releases/latest), then run the installer."
		);
		expect(text).toContain("![Architecture diagram](https://docs.example.com/x.png)");
	});

	it("preserves whitespace and entities inside fenced code blocks", () => {
		expect(text).toContain('```bash\n./setup   --prefix=/opt   && echo   done\necho "<ok>"\n```');
	});

	it("renders tables as GFM tables with escaped pipes", () => {
		expect(text).toMatch(/^\| Option +\| Default +\|$/m);
		expect(text).toMatch(/^\| -+ +\| -+ +\|$/m);
		expect(text).toMatch(/^\| port +\| 8080 \\\| 8443 +\|$/m);
	});

	it("keeps the output compact: no blank-line runs, no padded list markers", () => {
		expect(text).not.toMatch(/\n{3,}/);
		expect(text).not.toMatch(/^-\s{2,}\S/m);
	});

	it("falls back to the body when there is no single main region", () => {
		const plain = htmlToMarkdown("<html><body><p>Hello</p><p>World</p></body></html>");
		expect(plain).toBe("Hello\n\nWorld");
	});

	it("converts <br> and <hr> and drops empty markup", () => {
		expect(htmlToMarkdown("<p>a<br>b</p><hr><p><b></b>c</p>")).toBe("a\nb\n\n---\n\nc");
	});

	it("skips javascript: links and duplicate label/URL links", () => {
		const out = htmlToMarkdown(
			'<p><a href="javascript:void(0)">Click</a> <a href="https://x.example/">https://x.example/</a> <a href="#top">top</a></p>'
		);
		expect(out).toBe("Click https://x.example/ top");
	});

	it("bounds link expansion: many relative hrefs against a long base URL cannot blow up the output", () => {
		const baseUrl = `https://docs.example.com/${"segment/".repeat(180)}page.html`;
		expect(baseUrl.length).toBeGreaterThan(1400);
		const links = Array.from({ length: 5000 }, (_, i) => `<a href="l${i}">L${i}</a> `).join("");
		const page = `<body><p>${links}</p></body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page, { baseUrl });
		expect(Date.now() - started).toBeLessThan(5000);
		// Unbounded resolution would be ~5000 × 1.4 KB ≈ 7 MB; the budget keeps it well below
		expect(out.length).toBeLessThan(400000);
		// Early links resolved, later ones keep their label only — no link is lost
		expect(out).toContain("[L0](https://docs.example.com/");
		expect(out).toContain("L4999");
		expect(out).not.toContain("[L4999](");
	});

	it("drops absurdly long single URLs but keeps the label", () => {
		const out = htmlToMarkdown(`<p><a href="https://x.example/${"a".repeat(5000)}">Long</a></p>`);
		expect(out).toBe("Long");
	});

	it("stays linear on malformed markup designed to make scanners rescan", () => {
		const cases = [
			// One unterminated <main> followed by many "<" without any ">"
			`<body><main>${"<".repeat(120000)}</body>`,
			// Mismatched closers: the parser ignores </span>, so the DOM nests
			`<body>${"<div></span>".repeat(150000)}Deep</body>`,
			// Fallback route (600 nested divs) then a flood of unterminated <script>
			`<body>${"<div>".repeat(600)}Text ${"<script>".repeat(100000)}</body>`,
			// Many unterminated tags inside the region check
			`<body><main>${"<a href=x".repeat(50000)}</main></body>`,
		];
		for (const page of cases) {
			const started = Date.now();
			const out = htmlToMarkdown(page);
			expect(Date.now() - started).toBeLessThan(2000);
			expect(typeof out).toBe("string");
		}
	});

	it("does not mistake everyday unclosed list items and cells for hostile nesting", () => {
		const items = Array.from({ length: 1500 }, (_, i) => `<li>Item ${i}`).join("");
		const rows = Array.from({ length: 800 }, (_, i) => `<tr><td>${i}<td>x`).join("");
		const page = `<body><ul>${items}</ul><table>${rows}</table></body>`;
		const out = htmlToMarkdown(page);
		// DOM route taken: Markdown list markers and a table came out of Turndown
		expect(out).toContain("- Item 0");
		expect(out).toContain("- Item 1499");
		expect(out).toMatch(/\| 799 +\| x +\|/);
	});

	it("keeps dropping noise elements in the fallback route", () => {
		const page = `<body>${"<div>".repeat(600)}<nav>menu</nav><script>evil()</script><p>Kept</p></body>`;
		const out = htmlToMarkdown(page);
		expect(out).toContain("Kept");
		expect(out).not.toContain("menu");
		expect(out).not.toContain("evil()");
	});

	it("treats the self-closing slash on non-void tags as an opener, like the parser", () => {
		// <div/> nests in HTML; the depth guard must see it
		const page = `<body>${"<div/>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out).toContain("Deep");
		// ...while inline SVG with many self-closed paths is not nesting at all
		const svg = `<body><p>Chart:</p><svg>${"<path d='M0 0'/>".repeat(2000)}</svg><p>Legend</p></body>`;
		const converted = htmlToMarkdown(svg);
		expect(converted).toBe("Chart:\n\nLegend");
	});

	it("extracts the title in one pass even with a flood of unterminated <title> tags", () => {
		const page = `<html><head>${"<title>".repeat(60000)}x</head><body><h1>H</h1></body></html>`;
		const started = Date.now();
		const title = extractHtmlTitle(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof title).toBe("string");
		expect(
			extractHtmlTitle(
				"<html><head><title>Real &amp; first</title><title>Second</title></head></html>"
			)
		).toBe("Real & first");
	});

	it("does not mistake a custom element or script text for the <main> region", () => {
		const long = "Article text. ".repeat(40);
		const page = `<body><main-menu>${"Menu item. ".repeat(40)}</main-menu><script>var s = "<main>";</script><article>${long}</article></body>`;
		const out = htmlToMarkdown(page);
		expect(out).toContain("Article text.");
		expect(out).not.toContain("Menu item.");
	});

	it("resolves relative links against <base href> when the document declares one", () => {
		const page = `<html><head><base href="/docs/v2/"><title>T</title></head><body><p><a href="guide">Guide</a> <img src="img/a.png" alt="A"></p></body></html>`;
		const out = htmlToMarkdown(page, { baseUrl: "https://docs.example.com/index.html" });
		expect(out).toContain("[Guide](https://docs.example.com/docs/v2/guide)");
		expect(out).toContain("![A](https://docs.example.com/docs/v2/img/a.png)");
		// Without <base>, the response URL is the base
		const plain = htmlToMarkdown("<body><a href='guide'>Guide</a></body>", {
			baseUrl: "https://docs.example.com/index.html",
		});
		expect(plain).toContain("[Guide](https://docs.example.com/guide)");
	});

	it("keeps code blocks intact without a sentinel that page text could collide with", () => {
		// Private-use characters and digits in the prose must not expand into code blocks
		const pua = "";
		const page = `<body><pre><code>${"x".repeat(5000)}</code></pre><p>${`${pua}0${pua} `.repeat(3000)}</p><ul><li>a</li></ul></body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out.length).toBeLessThan(page.length + 1000);
		expect(out.split("```").length).toBe(3); // exactly one fenced block
		expect(out).toContain("- a");
	});

	it("refuses list/blockquote nesting that would multiply the output", () => {
		// ~255 nested lists then thousands of siblings: each line would carry ~1 KB of indentation
		const depth = 255;
		const page = `<body>${"<ul><li>".repeat(depth)}${"<li>x</li>".repeat(20000)}${"</li></ul>".repeat(depth)}</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out.length).toBeLessThan(page.length + 1000);
		expect(out).toContain("x");

		const quotes = `<body>${"<blockquote>".repeat(200)}${"<p>q</p>".repeat(5000)}${"</blockquote>".repeat(200)}</body>`;
		expect(htmlToMarkdown(quotes).length).toBeLessThan(quotes.length + 1000);

		// Ordinary nesting keeps the DOM route
		const normal = htmlToMarkdown(
			"<body><ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul></body>"
		);
		expect(normal).toContain("- a");
		expect(normal).toMatch(/\n\s+- b/);
	});

	it("counts HTML breakout tags inside SVG towards nesting depth", () => {
		const page = `<body><svg>${"<div>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
	});

	it("ignores a <main> nested inside a dropped element", () => {
		const long = "Article text. ".repeat(40);
		const decoy = `<template><main>${"Template text. ".repeat(40)}</main></template>`;
		const page = `<body>${decoy}<nav><main>${"Menu text. ".repeat(40)}</main></nav><article>${long}</article></body>`;
		const out = htmlToMarkdown(page);
		expect(out).toContain("Article text.");
		expect(out).not.toContain("Template text.");
		expect(out).not.toContain("Menu text.");
	});

	it("only accepts a complete closing tag name for raw-text elements", () => {
		const long = "Real article. ".repeat(40);
		const page = `<body><script>var s = "</scripture>"; var m = "<main>${"Injected. ".repeat(40)}</main>";</script><article>${long}</article></body>`;
		const out = htmlToMarkdown(page);
		expect(out).toContain("Real article.");
		expect(out).not.toContain("Injected.");
		expect(extractHtmlTitle("<head><title>Ti</titles>tle</title></head>")).toBe("Ti</titles>tle");
	});

	it("honours quoted attribute values when finding the end of a tag", () => {
		// A ">" and a fake closer hidden in a quoted attribute: the parser nests all the divs
		const page = `<body>${'<div title="></div>">'.repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out).toContain("Deep");
		// Ordinary attributes with ">" inside still convert normally
		const normal = htmlToMarkdown(
			`<body><p><a title="a > b" href="/x">Link</a> <img alt='1 > 0' src="/i.png"></p></body>`,
			{ baseUrl: "https://d.example/" }
		);
		expect(normal).toContain("[Link](https://d.example/x)");
		expect(normal).toContain("![1 > 0](https://d.example/i.png)");
		// A quote in attribute-name position is not a value delimiter (parser rule):
		// these are separate divs, not one giant tag
		const bare = `<body>${'<div ">'.repeat(100000)}Deep</body>`;
		const startedBare = Date.now();
		expect(htmlToMarkdown(bare)).toContain("Deep");
		expect(Date.now() - startedBare).toBeLessThan(2000);
	});

	it("honours quoted attributes on closing tags too", () => {
		// The tokenizer parses (and discards) attributes on malformed end tags: the
		// quoted "></div>" belongs to the </span> closer, so every div stays open
		const page = `<body>${'<div></span title="></div>">'.repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out).toContain("Deep");
	});

	it("counts HTML inside SVG integration points (foreignObject) towards depth", () => {
		const page = `<body><svg><foreignObject>${"<x>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		// An ordinary SVG with a description keeps converting normally
		const svg = `<body><p>Before</p><svg><desc>Chart</desc>${"<path d='M0 0'/>".repeat(50)}</svg><p>After</p></body>`;
		const normal = htmlToMarkdown(svg);
		expect(normal).toContain("Before");
		expect(normal).toContain("After");
	});

	it("tracks dropped ancestors in constant time per tag", () => {
		// Many open dropped elements, then a flood of unmatched closers of another name
		const page = `<body><main>${"Real text. ".repeat(40)}</main>${"<nav>".repeat(100000)}${"</footer>".repeat(100000)}</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out).toContain("Real text.");
	});

	it("treats an equals sign at attribute-name position as a name, not an assignment", () => {
		// The parser ends this tag at the first ">" and nests every following div
		const page = `<body>${'<x ="<div>'.repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		// Ordinary assignments still hide their quoted ">"
		expect(
			htmlToMarkdown(`<body><p><a href="/x" title="a > b">Link</a></p></body>`, {
				baseUrl: "https://d.example/",
			})
		).toContain("[Link](https://d.example/x)");
	});

	it("recognizes every HTML comment terminator", () => {
		// Abrupt and "--!>" closings end the comment; what follows is markup again
		for (const comment of ["<!-->", "<!--->", "<!-- x --!>"]) {
			const page = `<body>${comment}${"<div>".repeat(100000)}Deep</body>`;
			const started = Date.now();
			const out = htmlToMarkdown(page);
			expect(Date.now() - started).toBeLessThan(2000);
			expect(typeof out).toBe("string");
		}
		// Dashes inside a comment do not end it; an unterminated comment swallows the rest
		expect(htmlToMarkdown("<body><p>A</p><!-- a -- b -- c --><p>B</p></body>")).toBe("A\n\nB");
		expect(htmlToMarkdown("<body><p>A</p><!-- never closed <p>B</p></body>")).toBe("A");
	});

	it("respects scope boundaries: an end tag below an open <object> is ignored", () => {
		// The parser keeps both elements open per repetition; the estimate must too
		const page = `<body>${"<div><object></div>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		// Ordinary tables (td/th are boundaries too) still convert on the DOM route
		const table = htmlToMarkdown(
			"<body><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body>"
		);
		expect(table).toMatch(/\| 1 +\| 2 +\|/);
	});

	it("consumes the complete tag name, underscores included", () => {
		// "<x_y>" is the element x_y: each "</x>" is unmatched and the chain nests
		const page = `<body>${"<x_y></x>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
	});

	it("finds raw-text closers without a length-changing lowercase copy", () => {
		// "İ" lowercases to two code units: an index from a lowercased copy would drift
		const page = `<body><script>${"İ".repeat(5000)}</script>${"<div>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		// Case-insensitive closer, on the original indices
		expect(htmlToMarkdown("<body><SCRIPT>x()</Script><p>Kept</p></body>")).toBe("Kept");
	});

	it("skips <base> elements without href when looking for the document base", () => {
		const page = `<html><head><base target="_blank"><base href="/docs/v2/"></head><body><p><a href="guide">Guide</a></p></body></html>`;
		const out = htmlToMarkdown(page, { baseUrl: "https://docs.example.com/index.html" });
		expect(out).toContain("[Guide](https://docs.example.com/docs/v2/guide)");
	});

	it("leaves blank lines inside fenced code blocks untouched", () => {
		const page =
			"<body><p>Intro</p><pre><code>line 1\n\n\n\nline 5</code></pre><p>Outro</p></body>";
		const out = htmlToMarkdown(page);
		expect(out).toContain("```\nline 1\n\n\n\nline 5\n```");
		expect(out.startsWith("Intro\n\n```")).toBe(true);
	});

	it("folds only ASCII case in tag names, like the tokenizer", () => {
		// "<xİ>" and "</xi̇>" are different elements to the parser: the chain nests
		const page = `<body>${"<xİ></xi̇>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		// ASCII case still folds
		expect(htmlToMarkdown("<body><P>Mixed</p><DIV>Case</div></body>")).toBe("Mixed\n\nCase");
	});

	it("applies list-item scope to </li>: an intervening <ul> keeps the item open", () => {
		const page = `<body>${"<li><ul></li>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
	});

	it("honours the script double-escaped state when finding the closer", () => {
		// The first </script> is inside "<!--<script>": script text, not the closer
		const decoy = `<main>${"Decoy text. ".repeat(40)}</main>`;
		const page = `<body><script><!--<script></script>${decoy}--></script><article>${"Real text. ".repeat(40)}</article></body>`;
		const out = htmlToMarkdown(page);
		expect(out).toContain("Real text.");
		expect(out).not.toContain("Decoy text.");
	});

	it("does not count void dropped elements (<embed>) as open ancestors", () => {
		const page = `<body><article>${"Earlier. ".repeat(40)}</article><embed src="x.swf"><main>${"Real main. ".repeat(40)}</main></body>`;
		const out = htmlToMarkdown(page);
		expect(out).toContain("Real main.");
		expect(out).not.toContain("Earlier.");
	});

	it("decodes character references in <base href>", () => {
		const page = `<html><head><base href="/docs&amp;api/"></head><body><p><a href="guide">Guide</a></p></body></html>`;
		const out = htmlToMarkdown(page, { baseUrl: "https://docs.example.com/" });
		expect(out).toContain("[Guide](https://docs.example.com/docs&api/guide)");
		// The complete named set, as the parser decodes it: "&colon;" is ":" and the
		// base is absolute, so links resolve against it, not the response origin
		const named = `<html><head><base href="https&colon;//cdn.example/docs/"></head><body><p><a href="guide">Guide</a></p></body></html>`;
		expect(htmlToMarkdown(named, { baseUrl: "https://docs.example.com/" })).toContain(
			"[Guide](https://cdn.example/docs/guide)"
		);
	});

	it("accounts for the adoption agency on formatting end tags", () => {
		// </b> with a <div> above it reconstructs the <b> and leaves the div open:
		// the divs keep nesting in the parser, so they must in the estimate
		const page = `<body>${"<b><div></b>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		// Ordinary formatting still converts on the DOM route
		expect(htmlToMarkdown("<body><p>a <b>bold</b> <i>it</i> c</p></body>")).toBe(
			"a **bold** *it* c"
		);
	});

	it("keeps reconstructed formatting elements in the depth estimate", () => {
		// The adoption agency reconstructs <b> and <i> inside each div: the DOM
		// grows by three levels per repetition, never fewer than the estimate
		const page = `<body>${"<b><i><div></i></b>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
	});

	it("does not let </body> or </html> reset the depth estimate", () => {
		// The parser ignores extra <body> start tags and a </body> only changes the
		// insertion mode: the divs stay open and keep nesting
		const page = `${"<body><div></body>".repeat(100000)}Deep`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
	});

	it("judges blocked schemes on the parsed URL (tabs and newlines stripped)", () => {
		const out = htmlToMarkdown(
			`<body><p><a href="java&#x09;script:alert(1)">Click</a> <a href="jav&#10;ascript:x">Two</a> <img src="da&#x09;ta:image/png;base64,AAAA" alt="pic"></p></body>`,
			{ baseUrl: "https://d.example/" }
		);
		expect(out).not.toContain("javascript:");
		expect(out).not.toContain("data:");
		expect(out).toContain("Click");
		expect(out).toContain("Two");
		// A <base> with a non-http(s) scheme is ignored
		const based = htmlToMarkdown(
			`<html><head><base href="java&#x09;script:void(0)/"></head><body><p><a href="guide">Guide</a></p></body></html>`,
			{ baseUrl: "https://d.example/docs/" }
		);
		expect(based).toContain("[Guide](https://d.example/docs/guide)");
	});

	it("stops generic end tags at special elements, like the parser", () => {
		// </span> gives up at the special <div>: every div stays open and nests
		const page = `<body>${"<span><div></span>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		// Ordinary inline markup still closes and converts
		expect(htmlToMarkdown("<body><p><span>a</span> <em>b</em></p></body>")).toBe("a *b*");
	});

	it("keeps a dropped ancestor open when a scope boundary blocks its closer", () => {
		// </nav> is ignored (the open <object> is a boundary): the main stays inside the nav
		const decoy = `<nav><object></nav></object><main>${"Decoy text. ".repeat(40)}</main></nav>`;
		const page = `<body>${decoy}<article>${"Real text. ".repeat(40)}</article></body>`;
		const out = htmlToMarkdown(page);
		expect(out).toContain("Real text.");
		expect(out).not.toContain("Decoy text.");
	});

	it("closes a fence only with a run at least as long as the opener", () => {
		// Turndown lengthens the fence around code that contains ```: the inner
		// line must not end the block and expose the code to the prose rewrites
		const page =
			"<body><p>Intro</p><pre><code>line 1\n```\nrun   this , now\n</code></pre><p>after   this , ok</p></body>";
		const out = htmlToMarkdown(page);
		expect(out).toContain("run   this , now");
		expect(out).toContain("after this, ok");
		expect(out.match(/````/g)?.length).toBe(2);
	});

	it("ignores SVG titles when extracting the page title", () => {
		const page =
			"<html><body><svg><title>Search icon</title></svg><h1>Dashboard</h1></body></html>";
		expect(extractHtmlTitle(page)).toBe("Dashboard");
		expect(
			extractHtmlTitle(
				"<head><title>Real</title></head><body><svg><title>Icon</title></svg></body>"
			)
		).toBe("Real");
	});

	it("ignores <base> inside <template> (a separate document fragment)", () => {
		const page = `<html><head><template><base href="/preview/"></template><base href="/docs/"></head><body><p><a href="guide">Guide</a></p></body></html>`;
		const out = htmlToMarkdown(page, { baseUrl: "https://d.example/" });
		expect(out).toContain("[Guide](https://d.example/docs/guide)");
	});

	it("ends a tag at the '>' that closes an unquoted attribute value", () => {
		// <body class=page> then a flood of <div>: the tag must end at its ">"
		const page = `<body class=page>${"<div>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		expect(htmlToMarkdown("<body class=page><p>Kept</p></body>")).toBe("Kept");
	});

	it("counts foreign (svg/math) descendants towards nesting depth", () => {
		// Turndown recurses into the svg subtree before dropping it: deep <g> nesting costs
		const page = `<body><svg>${"<g>".repeat(100000)}<text>Deep</text></svg></body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
		// Ordinary inline SVG (shallow, self-closed shapes) still converts normally
		const icon = `<body><p>Before</p><svg><g><g><path d="M0 0"/><circle r="1"/></g></g></svg><p>After</p></body>`;
		expect(htmlToMarkdown(icon)).toBe("Before\n\nAfter");
	});

	it("treats <font> as a breakout from foreign content only with color/face/size", () => {
		// A bare <font> is an ordinary foreign element: the svg subtree stays open and
		// every repetition nests three levels deeper, which the DOM route must refuse
		const bare = "<svg><g><font>".repeat(200);
		expect(estimateNesting(bare).depth).toBeGreaterThan(MAX_DOM_DEPTH);
		// With color/face/size (any case, with or without a value) the parser breaks
		// out: the svg subtree is popped each time and only the <font> elements nest
		for (const attribute of ["color=red", 'FACE="serif"', "size", "id=x size='3'"]) {
			const shallow = `<svg><g><font ${attribute}>`.repeat(200);
			expect(estimateNesting(shallow).depth).toBeLessThan(MAX_DOM_DEPTH);
		}
		// Other attributes do not make it a breakout
		expect(estimateNesting('<svg><g><font id="size">'.repeat(200)).depth).toBeGreaterThan(
			MAX_DOM_DEPTH
		);
		// End to end: the deep page is refused up front and still converts quickly
		const page = `<body><p>Before</p>${"<svg><g><font>".repeat(20000)}Deep</body>`;
		const started = Date.now();
		expect(htmlToMarkdown(page)).toContain("Before");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("tokenizes the content of foreign <textarea>/<style>/<title> as markup, not raw text", () => {
		// Inside svg the tokenizer never enters RCDATA/raw text: the nested tags are
		// real elements the DOM route would have to build, so they count
		const deep = "<g>".repeat(600);
		for (const element of ["textarea", "style", "title", "script", "xmp"]) {
			const foreign = `<svg><${element}>${deep}</${element}></svg>`;
			expect(estimateNesting(foreign).depth).toBeGreaterThan(MAX_DOM_DEPTH);
			// The same element in HTML (top level, or below an integration point) is
			// raw text: the "tags" inside are text and nothing nests
			expect(estimateNesting(`<${element}>${deep}</${element}>`).depth).toBe(1);
			expect(
				estimateNesting(
					`<svg><foreignObject><${element}>${deep}</${element}></foreignObject></svg>`
				).depth
			).toBe(3);
		}
		// End to end: refused up front, converts quickly
		const page = `<body><p>Before</p><svg><textarea>${"<g>".repeat(100000)}</textarea></svg></body>`;
		const started = Date.now();
		expect(htmlToMarkdown(page)).toContain("Before");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("keeps a <main> inside a nav that </form> failed to close out of the region", () => {
		// </form> removes only the form element: the nav stays open, the main is its
		// descendant and Turndown drops it with the form. Region selection must agree.
		const decoy = "decoy ".repeat(60);
		const page = `<body><form><nav></form><main><p>${decoy}</p></main></nav><p>Real content</p></body>`;
		const out = htmlToMarkdown(page);
		expect(out).toContain("Real content");
		expect(out).not.toContain("decoy");
	});

	it("removes only the form element on </form>, keeping its open descendants", () => {
		// The parser removes the form node alone: every div stays open and nests
		const page = `<body>${"<form><div></form>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
	});

	it("parses integration-point children as HTML: <x/> nests below <foreignObject>", () => {
		const page = `<body><svg><foreignObject>${"<x/>".repeat(100000)}Deep</body>`;
		const started = Date.now();
		const out = htmlToMarkdown(page);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(typeof out).toBe("string");
	});

	it("skips title candidates inside <template>", () => {
		expect(
			extractHtmlTitle("<body><template><h1>Card preview</h1></template><h1>Dashboard</h1></body>")
		).toBe("Dashboard");
		expect(
			extractHtmlTitle(
				"<html><head><template><title>Tpl</title></template><title>Real</title></head></html>"
			)
		).toBe("Real");
	});

	it("handles tables without a header row", () => {
		const out = htmlToMarkdown(
			"<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>"
		);
		expect(out).toMatch(/\| a +\| b +\|/);
		expect(out).toMatch(/\| 1 +\| 2 +\|/);
	});

	it("survives unterminated noise elements", () => {
		expect(htmlToMarkdown("<p>Visible</p><script>var x = 1;")).toBe("Visible");
	});

	it("removes deeply nested noise elements in the DOM within the depth cap", () => {
		const depth = 400;
		const nested = `<body><p>Before</p>${"<nav>".repeat(depth)}menu${"</nav>".repeat(depth)}<p>After</p></body>`;
		const started = Date.now();
		const out = htmlToMarkdown(nested);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(out).toBe("Before\n\nAfter");
	});

	it("refuses hostile nesting depth up front and degrades to a fast tag strip", () => {
		// Attacker-controlled pages: the HTML tree builder is quadratic in depth
		// and the converter recurses per level, so depth is bounded before parsing
		for (const page of [
			`<body><p>Before</p>${"<nav>".repeat(20000)}menu${"</nav>".repeat(20000)}<p>After</p></body>`,
			`<body><p>Before</p>${"<div>".repeat(200000)}After${"</div>".repeat(200000)}</body>`,
		]) {
			const started = Date.now();
			const out = htmlToMarkdown(page);
			expect(Date.now() - started).toBeLessThan(2000);
			expect(out).toContain("Before");
			expect(out).toContain("After");
			expect(out).not.toContain("menu");
		}
		// Unterminated navs swallow the rest of the page, as a browser would nest it
		const open = `<body><p>Before</p>${"<nav>".repeat(20000)}menu <p>After</p>`;
		const started = Date.now();
		expect(htmlToMarkdown(open)).toBe("Before");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("handles null and empty input", () => {
		expect(htmlToMarkdown("")).toBe("");
		expect(htmlToMarkdown(null)).toBe("");
	});
});

describe("extractHtmlTitle", () => {
	it("closes a script at the first </script> after a double-escaped -->", () => {
		// Tokenizer: "-->" in the script data double escaped (dash dash) state switches
		// to the script data state, so the next </script> ends the element and the
		// markup after it is live again (browsers and domino agree)
		const page =
			"<html><head><script><!--<script>--></script><title>Real title</title></head>" +
			"<body><h1>Heading</h1></body></html>";
		expect(extractHtmlTitle(page)).toBe("Real title");
		// Whereas before "-->" the </script> only leaves the double-escaped state
		const stillOpen =
			"<html><head><script><!--<script></script><title>Not a title</title>--></script>" +
			"<title>Real title</title></head></html>";
		expect(extractHtmlTitle(stillOpen)).toBe("Real title");
	});

	it("prefers <title>, decoded and whitespace-normalized", () => {
		expect(extractHtmlTitle(PAGE)).toBe("Install & Configure — Docs");
	});

	it("falls back to the first heading", () => {
		expect(extractHtmlTitle("<body><h1>Only <em>Heading</em></h1></body>")).toBe("Only Heading");
		expect(extractHtmlTitle("<body><p>no title</p></body>")).toBe("");
	});
});

describe("decodeHtmlEntities", () => {
	it("decodes named, decimal and hexadecimal references", () => {
		expect(
			decodeHtmlEntities("&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39; &#x41;&#66; &nbsp;x")
		).toBe("<a> & \"b\" 'c' AB \u00a0x");
	});

	it("decodes the complete HTML named reference set with the parser's rules", () => {
		// Names outside any small table, and the legacy semicolon-less forms
		expect(decodeHtmlEntities("https&colon;//x/&hellip; &Aacute;&eacute; &amp&lt;b>")).toBe(
			"https://x/… Áé &<b>"
		);
		// Quotes and markup-looking text inside the input are never interpreted
		expect(decodeHtmlEntities('say "hi" <b>&amp;</b> &quot;')).toBe('say "hi" <b>&</b> "');
	});

	it("leaves unknown references untouched", () => {
		expect(decodeHtmlEntities("&unknownthing; &#xZZ;")).toBe("&unknownthing; &#xZZ;");
	});
});
