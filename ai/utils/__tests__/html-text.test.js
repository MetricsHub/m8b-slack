/**
 * Tests for the HTML → Markdown conversion (Turndown + model-oriented pre/post passes).
 */

import { describe, expect, it } from "@jest/globals";
import { decodeHtmlEntities, extractHtmlTitle, htmlToMarkdown } from "../html-text.js";

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
			`<body><p>Before</p>${"<nav>".repeat(20000)}menu <p>After</p>`, // unterminated
			`<body><p>Before</p>${"<div>".repeat(200000)}After${"</div>".repeat(200000)}</body>`,
		]) {
			const started = Date.now();
			const out = htmlToMarkdown(page);
			expect(Date.now() - started).toBeLessThan(2000);
			expect(out).toContain("Before");
			expect(out).toContain("After");
		}
	});

	it("handles null and empty input", () => {
		expect(htmlToMarkdown("")).toBe("");
		expect(htmlToMarkdown(null)).toBe("");
	});
});

describe("extractHtmlTitle", () => {
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
		).toBe("<a> & \"b\" 'c' AB  x");
	});

	it("leaves unknown references untouched", () => {
		expect(decodeHtmlEntities("&unknownthing; &#xZZ;")).toBe("&unknownthing; &#xZZ;");
	});
});
