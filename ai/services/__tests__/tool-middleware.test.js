import { describe, expect, it } from "@jest/globals";
import { compressMcpOutput } from "../tool-middleware.js";

describe("compressMcpOutput", () => {
	it("should remove metric verbose fields", () => {
		const input = {
			monitors: [
				{
					id: "test_monitor",
					metrics: {
						"cpu.usage": {
							value: 50,
							name: "cpu.usage",
							type: "gauge",
							collectTime: 1234567890,
							previousCollectTime: 1234567800,
							previousValue: 45,
							resetMetricsTime: 0,
							updated: true,
							attributes: { unit: "percent" },
						},
					},
				},
			],
		};

		const result = compressMcpOutput(input, "TestTool", null);

		expect(result.monitors[0].metrics["cpu.usage"]).toEqual({
			value: 50,
			attributes: { unit: "percent" },
		});
	});

	it("should remove monitor verbose fields", () => {
		const input = {
			monitors: [
				{
					id: "test_monitor",
					type: "cpu",
					discoveryTime: 1234567890,
					identifyingAttributeKeys: ["id"],
					connector: false,
					endpoint: false,
					endpointHost: false,
					is_endpoint: false,
					metrics: {},
				},
			],
		};

		const result = compressMcpOutput(input, "TestTool", null);

		expect(result.monitors[0]).toEqual({
			id: "test_monitor",
			type: "cpu",
		});
		expect(result.monitors[0].discoveryTime).toBeUndefined();
		expect(result.monitors[0].identifyingAttributeKeys).toBeUndefined();
		expect(result.monitors[0].connector).toBeUndefined();
		expect(result.monitors[0].endpoint).toBeUndefined();
	});

	it("should keep true boolean flags", () => {
		const input = {
			monitors: [
				{
					id: "test_connector",
					connector: true,
					endpoint: false,
					is_endpoint: true,
				},
			],
		};

		const result = compressMcpOutput(input, "TestTool", null);

		expect(result.monitors[0].connector).toBe(true);
		expect(result.monitors[0].endpoint).toBeUndefined();
		expect(result.monitors[0].is_endpoint).toBe(true);
	});

	it("should remove empty objects", () => {
		const input = {
			monitors: [
				{
					id: "test",
					conditionalCollection: {},
					alertRules: {},
					attributes: { name: "test" },
				},
			],
		};

		const result = compressMcpOutput(input, "TestTool", null);

		expect(result.monitors[0].conditionalCollection).toBeUndefined();
		expect(result.monitors[0].alertRules).toBeUndefined();
		expect(result.monitors[0].attributes).toEqual({ name: "test" });
	});

	it("should deduplicate StatusInformation", () => {
		const duplicatedStatus = `Executed CommandLineCriterion Criterion:
- CommandLine: nvidia-smi
- ExpectedResult: Driver Version

Result:
GPU output here

Message:
====================================
CommandLineCriterion test succeeded:
- CommandLine: nvidia-smi

Result: GPU output here

====================================

Conclusion:
Test on dev-nvidia-01 SUCCEEDED`;

		const input = {
			monitors: [
				{
					id: "connector_NvidiaSmi",
					legacyTextParameters: {
						StatusInformation: duplicatedStatus,
					},
				},
			],
		};

		const result = compressMcpOutput(input, "TestTool", null);
		const statusInfo = result.monitors[0].legacyTextParameters.StatusInformation;

		// Should contain the first Result but not the duplicated one after Message
		expect(statusInfo).toContain("Result:\nGPU output here");
		expect(statusInfo).toContain("Conclusion:");
		expect(statusInfo).not.toContain("Message:");
		expect(statusInfo).not.toContain("====================================");
	});

	it("should handle nested telemetry structures", () => {
		const input = {
			ok: true,
			results: [
				{
					server_label: "m8b-agent-01",
					result: {
						hosts: [
							{
								hostname: "dev-nvidia-01",
								response: {
									telemetry: {
										total: 1,
										monitors: [
											{
												id: "test",
												discoveryTime: 123,
												metrics: {
													"test.metric": {
														value: 1,
														collectTime: 456,
													},
												},
											},
										],
									},
								},
							},
						],
					},
				},
			],
		};

		const result = compressMcpOutput(input, "CollectMetricsForHost", null);

		const monitor = result.results[0].result.hosts[0].response.telemetry.monitors[0];
		expect(monitor.discoveryTime).toBeUndefined();
		expect(monitor.metrics["test.metric"].collectTime).toBeUndefined();
		expect(monitor.metrics["test.metric"].value).toBe(1);
	});

	it("should return non-objects unchanged", () => {
		expect(compressMcpOutput(null, "Test", null)).toBeNull();
		expect(compressMcpOutput("string", "Test", null)).toBe("string");
		expect(compressMcpOutput(123, "Test", null)).toBe(123);
	});

	it("should return empty object for fully empty input", () => {
		const input = {
			monitors: [
				{
					conditionalCollection: {},
					alertRules: {},
					legacyTextParameters: {},
				},
			],
		};

		const result = compressMcpOutput(input, "TestTool", null);

		// The entire structure collapses to empty
		expect(result).toEqual({});
	});
});
