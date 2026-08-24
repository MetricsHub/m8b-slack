/**
 * Tests for the MetricsHub YAML structure helpers.
 */

import { describe, expect, it } from "@jest/globals";
import {
	dedentBlock,
	extractLineRange,
	findResourceEntries,
	findResourceSection,
	indentBlock,
	insertLinesAfter,
	replaceLineRange,
	scanYamlStructure,
} from "../yaml-resources.js";

const SAMPLE = [
	"# MetricsHub configuration",
	"loggerLevel: error",
	"",
	"resources:",
	"  web-01:",
	"    attributes:",
	"      host.name: web-01.example.com",
	"      host.type: linux",
	"    protocols:",
	"      ssh:",
	"        username: root",
	"        password: ENCRYPTEDBLOB==",
	"  # commented note about db-01",
	"  db-01:",
	"    attributes:",
	"      host.name: db-01.example.com",
	"",
	"resourceGroups:",
	"  paris:",
	"    resources:",
	"      paris-fs-01:",
	"        attributes:",
	"          host.name: paris-fs-01",
	"        protocols:",
	"          snmp:",
	"            community: public",
	"",
	"otel:",
	"  metrics: {}",
].join("\n");

describe("scanYamlStructure", () => {
	it("tracks nested key paths by indentation", () => {
		const { keys } = scanYamlStructure(SAMPLE);
		const paths = keys.map((k) => k.path.join("."));
		expect(paths).toContain("resources.web-01.protocols.ssh.password");
		expect(paths).toContain("resourceGroups.paris.resources.paris-fs-01");
		expect(paths).toContain("otel.metrics");
	});

	it("ignores comments and does not scan block scalar bodies", () => {
		const text = ["a:", "  script: |", "    fake-key: value", "    another: line", "b: 1"].join(
			"\n"
		);
		const { keys } = scanYamlStructure(text);
		const paths = keys.map((k) => k.path.join("."));
		expect(paths).toEqual(["a", "a.script", "b"]);
	});

	it("does not split values containing colons", () => {
		const { keys } = scanYamlStructure("url: https://example.com:8080/x\n");
		expect(keys[0]).toMatchObject({ key: "url", path: ["url"] });
	});
});

describe("findResourceEntries", () => {
	it("finds top-level and grouped resources with their extent", () => {
		const entries = findResourceEntries(SAMPLE);
		expect(entries.map((e) => e.resourceId)).toEqual(["web-01", "db-01", "paris-fs-01"]);

		const web = entries.find((e) => e.resourceId === "web-01");
		expect(web.group).toBeNull();
		// Block ends before the comment line that annotates db-01
		expect(extractLineRange(SAMPLE, web.startLine, web.endLine)).toContain("ENCRYPTEDBLOB==");
		expect(extractLineRange(SAMPLE, web.startLine, web.endLine)).not.toContain("db-01");

		const paris = entries.find((e) => e.resourceId === "paris-fs-01");
		expect(paris.group).toBe("paris");
		expect(paris.pathLabel).toBe("resourceGroups.paris.resources.paris-fs-01");
	});

	it("does not mistake deeper keys for resources", () => {
		const entries = findResourceEntries(SAMPLE);
		expect(entries.map((e) => e.resourceId)).not.toContain("attributes");
		expect(entries.map((e) => e.resourceId)).not.toContain("ssh");
	});
});

describe("block editing", () => {
	it("replaces exactly one resource block, leaving the rest byte-identical", () => {
		const entries = findResourceEntries(SAMPLE);
		const web = entries.find((e) => e.resourceId === "web-01");

		const replacement = indentBlock("web-01:\n  attributes:\n    host.name: NEW", web.indent);
		const result = replaceLineRange(SAMPLE, web.startLine, web.endLine, replacement);

		expect(result).toContain("    host.name: NEW");
		expect(result).not.toContain("ENCRYPTEDBLOB==");
		// Everything else untouched
		expect(result).toContain("# commented note about db-01");
		expect(result).toContain("      community: public");
		expect(result).toContain("loggerLevel: error");
	});

	it("deletes a block when replacement is null", () => {
		const entries = findResourceEntries(SAMPLE);
		const db = entries.find((e) => e.resourceId === "db-01");
		const result = replaceLineRange(SAMPLE, db.startLine, db.endLine, null);
		expect(result).not.toContain("db-01:");
		expect(result).toContain("web-01:");
		expect(result).toContain("paris-fs-01:");
	});

	it("round-trips dedent/indent including blank lines", () => {
		const block = "  a:\n    b: 1\n\n    c: 2";
		expect(indentBlock(dedentBlock(block, 2), 2)).toBe("  a:\n    b: 1\n\n    c: 2");
	});
});

describe("findResourceSection", () => {
	it("finds the top-level resources section and its child indent", () => {
		const section = findResourceSection(SAMPLE, null);
		expect(section.found).toBe(true);
		expect(section.childIndent).toBe(2);
		// Insertion point is the last line of the section (db-01's last line)
		expect(extractLineRange(SAMPLE, section.insertAfterLine, section.insertAfterLine)).toContain(
			"db-01.example.com"
		);
	});

	it("finds a group's resources section", () => {
		const section = findResourceSection(SAMPLE, "paris");
		expect(section.found).toBe(true);
		expect(section.childIndent).toBe(6);
	});

	it("reports missing groups with the available ones", () => {
		const section = findResourceSection(SAMPLE, "london");
		expect(section.found).toBe(false);
		expect(section.groupExists).toBe(false);
		expect(section.groups).toEqual(["paris"]);
	});

	it("supports inserting a new resource into a section", () => {
		const section = findResourceSection(SAMPLE, null);
		const result = insertLinesAfter(
			SAMPLE,
			section.insertAfterLine,
			indentBlock("new-01:\n  attributes:\n    host.name: new-01", section.childIndent)
		);
		const entries = findResourceEntries(result);
		expect(entries.map((e) => e.resourceId)).toEqual(["web-01", "db-01", "new-01", "paris-fs-01"]);
	});
});
