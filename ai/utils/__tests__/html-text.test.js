/**
 * Tests for the dependency-free HTML → Markdown-ish text conversion.
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
</main>
<footer>Copyright &copy; 2026 Example</footer>
</body></html>`;

describe("htmlToMarkdown", () => {
	const text = htmlToMarkdown(PAGE, { baseUrl: "https://docs.example.com/guide/install.html" });

	it("drops scripts, styles, navigation and footers (nested ones included)", () => {
		expect(text).not.toContain("window.track");
		expect(text).not.toContain("color: red");
		expect(text).not.toContain("Home");
		expect(text).not.toContain("nested");
		expect(text).not.toContain("Copyright");
	});

	it("keeps headings, paragraphs and lists as Markdown", () => {
		expect(text).toContain("# Install & Configure");
		expect(text).toContain("## Steps");
		expect(text).toContain("- Unpack the `archive`");
		expect(text).toContain("- Run **setup** as *root*");
		expect(text).toContain("> Do not run as a service user.");
		expect(text).toContain("[image: Architecture diagram]");
	});

	it("resolves relative links against the page URL", () => {
		expect(text).toContain("[latest release](https://docs.example.com/releases/latest)");
	});

	it("preserves whitespace and entities inside code blocks", () => {
		expect(text).toContain('```bash\n./setup   --prefix=/opt   && echo   done\necho "<ok>"\n```');
	});

	it("renders tables as Markdown tables with escaped pipes", () => {
		expect(text).toContain("| Option | Default |");
		expect(text).toContain("| --- | --- |");
		expect(text).toContain("| port | 8080 \\| 8443 |");
	});

	it("collapses whitespace outside code blocks and keeps punctuation attached", () => {
		expect(text).not.toMatch(/\n{3,}/);
		expect(text).toContain(
			"Download the [latest release](https://docs.example.com/releases/latest), then run the installer. This paragraph is\nlong enough"
		);
		const outsideCode = text.replace(/```[\s\S]*?```/g, "");
		expect(outsideCode).not.toMatch(/[^\n] {2,}[^\n]/);
	});

	it("falls back to the body when there is no single main region", () => {
		const plain = htmlToMarkdown("<html><body><p>Hello</p><p>World</p></body></html>");
		expect(plain).toBe("Hello\n\nWorld");
	});

	it("converts <br> and <hr> and drops empty markup", () => {
		expect(htmlToMarkdown("<p>a<br>b</p><hr><p><b></b>c</p>")).toBe("a\nb\n\n---\n\nc");
	});

	it("survives unterminated noise elements", () => {
		expect(htmlToMarkdown("<p>Visible</p><script>var x = 1;")).toBe("Visible");
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
