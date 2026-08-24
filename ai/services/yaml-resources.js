/**
 * Structure-aware helpers for MetricsHub configuration YAML.
 *
 * MetricsHub config files (schema: https://schemastore.org) define monitored
 * resources under two paths:
 *
 *   resources.<resourceId>
 *   resourceGroups.<groupName>.resources.<resourceId>
 *
 * These helpers locate a resource's block inside a file and splice
 * replacements in as TEXT, using indentation to delimit blocks. No YAML
 * parser is used on purpose: parsing and re-serializing would destroy the
 * comments and formatting everywhere else in the file, while text splicing
 * keeps every untouched byte identical — which is exactly what the Slack
 * approval diff should show. The assembled file is still schema-validated by
 * the MetricsHub agent before anything is saved.
 *
 * Limitations (fine for conventional MetricsHub files): flow-style mappings
 * ({...} on one line) and keys containing unquoted colons are not recognized.
 */

/** Matches "key:" / "key: value" lines (block-style mappings only). */
const KEY_LINE_RE =
	/^(\s*)(?!#)(?!- )(?:"([^"]+)"|'([^']+)'|([^\s"'][^:]*?)):(?:[ \t]+(.*))?[ \t]*$/;

function _indentOf(line) {
	return line.length - line.trimStart().length;
}

function _detectEol(text) {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Scan block-style YAML and return every mapping key with its path.
 * Block-scalar bodies (| and >) are skipped so their content is never
 * mistaken for keys.
 *
 * @param {string} text - YAML file content
 * @returns {{lines: string[], keys: Array<{path: string[], key: string, indent: number, line: number}>}}
 */
export function scanYamlStructure(text) {
	const lines = String(text).split(/\r?\n/);
	const keys = [];
	const stack = []; // [{indent, key}]
	let blockScalarIndent = null; // indent of the key that opened a block scalar

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) continue;

		const indent = _indentOf(line);
		if (blockScalarIndent !== null) {
			if (indent > blockScalarIndent) continue;
			blockScalarIndent = null;
		}
		if (line.trim().startsWith("#")) continue;

		const m = line.match(KEY_LINE_RE);
		if (!m) continue;
		const key = m[2] ?? m[3] ?? m[4];

		while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
		keys.push({ path: [...stack.map((s) => s.key), key], key, indent, line: i });
		stack.push({ indent, key });

		const value = (m[5] || "").trim();
		if (/^[|>][+-]?\d*([ \t]+#.*)?$/.test(value)) blockScalarIndent = indent;
	}

	return { lines, keys };
}

/**
 * Last line of the block owned by the key at startLine: everything up to (not
 * including) the next non-blank line indented at or left of the key itself.
 *
 * @param {string[]} lines - File lines
 * @param {number} startLine - Line index of the key
 * @param {number} indent - Indent of the key
 * @returns {number} Inclusive end line index
 */
export function findBlockEnd(lines, startLine, indent) {
	let last = startLine;
	for (let j = startLine + 1; j < lines.length; j++) {
		if (!lines[j].trim()) continue;
		if (_indentOf(lines[j]) > indent) {
			last = j;
			continue;
		}
		break;
	}
	return last;
}

/**
 * Locate every resource entry defined in a MetricsHub config file.
 *
 * @param {string} text - YAML file content
 * @returns {Array<{resourceId: string, group: string|null, indent: number,
 *   startLine: number, endLine: number, pathLabel: string}>}
 */
export function findResourceEntries(text) {
	const { lines, keys } = scanYamlStructure(text);
	const entries = [];

	for (const k of keys) {
		const isTopLevel = k.path.length === 2 && k.path[0] === "resources";
		const isGrouped =
			k.path.length === 4 && k.path[0] === "resourceGroups" && k.path[2] === "resources";
		if (!isTopLevel && !isGrouped) continue;

		entries.push({
			resourceId: k.key,
			group: isGrouped ? k.path[1] : null,
			indent: k.indent,
			startLine: k.line,
			endLine: findBlockEnd(lines, k.line, k.indent),
			pathLabel: k.path.join("."),
		});
	}

	return entries;
}

/**
 * Extract a line range as text.
 *
 * @param {string} text - File content
 * @param {number} startLine - First line (inclusive)
 * @param {number} endLine - Last line (inclusive)
 * @returns {string}
 */
export function extractLineRange(text, startLine, endLine) {
	return String(text)
		.split(/\r?\n/)
		.slice(startLine, endLine + 1)
		.join("\n");
}

/**
 * Remove up to `indent` leading spaces from every line.
 *
 * @param {string} block - Block text
 * @param {number} indent - Number of spaces to strip
 * @returns {string}
 */
export function dedentBlock(block, indent) {
	const prefix = " ".repeat(indent);
	return String(block)
		.split(/\r?\n/)
		.map((line) => (line.startsWith(prefix) ? line.slice(indent) : line))
		.join("\n");
}

/**
 * Prefix every non-blank line with `indent` spaces.
 *
 * @param {string} block - Block text (at column 0)
 * @param {number} indent - Number of spaces to add
 * @returns {string}
 */
export function indentBlock(block, indent) {
	const prefix = " ".repeat(indent);
	return String(block)
		.split(/\r?\n/)
		.map((line) => (line.trim() ? prefix + line : ""))
		.join("\n");
}

/**
 * Replace a line range with new text (pass null to delete the range).
 * Preserves the file's dominant EOL style.
 *
 * @param {string} text - File content
 * @param {number} startLine - First line to replace (inclusive)
 * @param {number} endLine - Last line to replace (inclusive)
 * @param {string|null} replacement - New text, or null to delete
 * @returns {string}
 */
export function replaceLineRange(text, startLine, endLine, replacement) {
	const eol = _detectEol(text);
	const lines = String(text).split(/\r?\n/);
	const replacementLines =
		replacement === null || replacement === undefined
			? []
			: String(replacement)
					.replace(/\r?\n$/, "")
					.split(/\r?\n/);
	lines.splice(startLine, endLine - startLine + 1, ...replacementLines);
	return lines.join(eol);
}

/**
 * Insert text after a given line. Preserves the file's dominant EOL style.
 *
 * @param {string} text - File content
 * @param {number} afterLine - Line index to insert after (-1 = at the top)
 * @param {string} insertion - Text to insert
 * @returns {string}
 */
export function insertLinesAfter(text, afterLine, insertion) {
	const eol = _detectEol(text);
	const lines = String(text).split(/\r?\n/);
	const insertionLines = String(insertion)
		.replace(/\r?\n$/, "")
		.split(/\r?\n/);
	lines.splice(afterLine + 1, 0, ...insertionLines);
	return lines.join(eol);
}

/**
 * Find the section a new resource should be inserted into: top-level
 * "resources:" (no group) or "resourceGroups.<group>.resources:". Returns the
 * insertion point and the indent new children should use.
 *
 * @param {string} text - YAML file content
 * @param {string|null} group - Resource group name, or null for top-level
 * @returns {{found: boolean, insertAfterLine?: number, childIndent?: number,
 *   groupExists?: boolean, groups?: string[]}}
 */
export function findResourceSection(text, group = null) {
	const { lines, keys } = scanYamlStructure(text);
	const wantedPath = group ? ["resourceGroups", group, "resources"] : ["resources"];

	const section = keys.find(
		(k) => k.path.length === wantedPath.length && k.path.every((p, i) => p === wantedPath[i])
	);

	if (!section) {
		const groups = keys
			.filter((k) => k.path.length === 2 && k.path[0] === "resourceGroups")
			.map((k) => k.key);
		return {
			found: false,
			groupExists: group ? groups.includes(group) : false,
			groups,
		};
	}

	// Indent for children: reuse the first existing child's indent, else +2
	const child = keys.find(
		(k) => k.path.length === wantedPath.length + 1 && wantedPath.every((p, i) => p === k.path[i])
	);
	const childIndent = child ? child.indent : section.indent + 2;

	return {
		found: true,
		insertAfterLine: findBlockEnd(lines, section.line, section.indent),
		childIndent,
	};
}
