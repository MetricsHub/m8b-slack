/**
 * Tests for GPT tool construction helpers.
 */

import { buildFunctionNamespaces } from "../index.js";

function makeTool(name) {
	return {
		type: "function",
		name,
		description: `Run ${name}.`,
		parameters: { type: "object", properties: {}, additionalProperties: false },
	};
}

describe("buildFunctionNamespaces", () => {
	it("keeps namespaces below ten tools and defers non-core schemas", () => {
		const functionTools = Array.from({ length: 16 }, (_, index) =>
			makeTool(index === 0 ? "ListHosts" : `Tool${index}`)
		);

		const namespaces = buildFunctionNamespaces({
			name: "metricshub",
			description: "MetricsHub tools.",
			functionTools,
			immediateToolNames: new Set(["ListHosts"]),
		});

		expect(namespaces).toHaveLength(2);
		expect(namespaces.map((namespace) => namespace.name)).toEqual(["metricshub_1", "metricshub_2"]);
		expect(namespaces.every((namespace) => namespace.tools.length < 10)).toBe(true);
		expect(namespaces[0].tools[0].defer_loading).toBe(false);
		expect(namespaces[0].tools[1].defer_loading).toBe(true);
		expect(namespaces[0].description).toContain("ListHosts");
	});

	it("uses the base namespace name for a single chunk", () => {
		const [namespace] = buildFunctionNamespaces({
			name: "knowledge_base",
			description: "Knowledge tools.",
			functionTools: [makeTool("update_knowledge")],
		});

		expect(namespace.name).toBe("knowledge_base");
		expect(namespace.tools[0].defer_loading).toBe(true);
	});
});
