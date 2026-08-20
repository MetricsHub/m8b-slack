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

	describe("current MetricsHub shape (monitors keyed by type)", () => {
		/**
		 * Fixture modeled on a real GetMetricsFromCacheForHost response:
		 * results[].result.hosts[].response.telemetry.monitors.<type>[]
		 */
		function makeTelemetryFixture() {
			return {
				ok: true,
				results: [
					{
						server_label: "m8b-agent-01",
						ok: true,
						result: {
							hosts: [
								{
									hostname: "ecs1-01",
									response: {
										telemetry: {
											monitors: {
												file_system: [
													{
														type: "monitor",
														attributes: {
															"system.filesystem.type": "ext4",
															"system.device": "/dev/loop0(/srv/node/swiftloopback)",
															instanceName: "/dev/loop0(/srv/node/swiftloopback)",
															entityName: "Linux_file_system_/dev/loop0(/srv/node/swiftloopback)",
															connector_id: "Linux",
															entityTypeId: "file_system",
															id: "/dev/loop0(/srv/node/swiftloopback)",
															"system.filesystem.mountpoint": "/srv/node/swiftloopback",
														},
														metrics: {
															'system.filesystem.utilization{system.filesystem.state="used"}': 0.72,
															'system.filesystem.usage{system.filesystem.state="free"}': 1815531520,
														},
													},
												],
												cpu: [
													{
														type: "monitor",
														attributes: {
															"hw.parent.type": "enclosure",
															"hw.parent.id": "ecs1-01-encl-0",
															instanceName: "CPU 1",
															entityName: "Hardware_cpu_CPU 1",
															name: "CPU 1",
															connector_id: "DellOpenManage",
															entityTypeId: "cpu",
															id: "cpu-1",
															info: "Intel Xeon Gold 6338",
														},
														metrics: {
															'hw.status{hw.type="cpu"}': "ok",
															'hw.power{hw.type="cpu"}': 143.2,
														},
													},
												],
											},
										},
									},
								},
							],
						},
					},
				],
			};
		}

		it("compresses monitors keyed by type: drops identifier plumbing, keeps diagnostics", () => {
			const result = compressMcpOutput(makeTelemetryFixture(), "GetMetricsFromCacheForHost", null);
			const monitors = result.results[0].result.hosts[0].response.telemetry.monitors;

			const fs = monitors.file_system[0];
			// Identifier plumbing removed
			expect(fs.attributes.id).toBeUndefined();
			expect(fs.attributes.entityTypeId).toBeUndefined();
			expect(fs.attributes.connector_id).toBeUndefined();
			// instanceName is a substring of entityName: removed as duplication
			expect(fs.attributes.instanceName).toBeUndefined();
			// The tautological type "monitor" is removed
			expect(fs.type).toBeUndefined();
			// Diagnostic attributes are kept
			expect(fs.attributes.entityName).toBe(
				"Linux_file_system_/dev/loop0(/srv/node/swiftloopback)"
			);
			expect(fs.attributes["system.filesystem.mountpoint"]).toBe("/srv/node/swiftloopback");
			expect(fs.attributes["system.filesystem.type"]).toBe("ext4");

			const cpu = monitors.cpu[0];
			expect(cpu.attributes["hw.parent.id"]).toBeUndefined();
			expect(cpu.attributes.name).toBeUndefined(); // substring of entityName
			expect(cpu.attributes.info).toBe("Intel Xeon Gold 6338");
			expect(cpu.attributes["hw.parent.type"]).toBe("enclosure");
		});

		it("never touches metric names, values, or statuses", () => {
			const result = compressMcpOutput(makeTelemetryFixture(), "GetMetricsFromCacheForHost", null);
			const monitors = result.results[0].result.hosts[0].response.telemetry.monitors;

			expect(monitors.file_system[0].metrics).toEqual({
				'system.filesystem.utilization{system.filesystem.state="used"}': 0.72,
				'system.filesystem.usage{system.filesystem.state="free"}': 1815531520,
			});
			expect(monitors.cpu[0].metrics['hw.status{hw.type="cpu"}']).toBe("ok");
			expect(monitors.cpu[0].metrics['hw.power{hw.type="cpu"}']).toBe(143.2);
		});

		it("achieves measurable savings on the keyed shape", () => {
			const fixture = makeTelemetryFixture();
			const rawLength = JSON.stringify(fixture).length;
			const compressedLength = JSON.stringify(
				compressMcpOutput(fixture, "GetMetricsFromCacheForHost", null)
			).length;

			expect(compressedLength).toBeLessThan(rawLength * 0.8);
		});

		it("keeps a distinctive name that is not embedded in entityName", () => {
			const input = {
				monitors: {
					system: [
						{
							type: "monitor",
							attributes: {
								entityName: "Linux_system_main",
								name: "Ubuntu 22.04 Server",
							},
							metrics: { "system.uptime": 861234 },
						},
					],
				},
			};

			const result = compressMcpOutput(input, "Test", null);
			expect(result.monitors.system[0].attributes.name).toBe("Ubuntu 22.04 Server");
		});

		it("drops MetricsHub internal job telemetry metrics", () => {
			const input = {
				monitors: {
					connector: [
						{
							type: "monitor",
							attributes: { entityName: "Connector_Linux" },
							metrics: {
								'metricshub.job.duration{job.type="collect"}': 1.23,
								'metricshub.job.duration{job.type="discovery"}': 4.56,
								"metricshub.connector.status": "ok",
							},
						},
					],
				},
			};

			const result = compressMcpOutput(input, "Test", null);
			const metrics = result.monitors.connector[0].metrics;
			expect(metrics["metricshub.connector.status"]).toBe("ok");
			expect(Object.keys(metrics).filter((k) => k.startsWith("metricshub.job."))).toHaveLength(0);
		});

		it("keeps a real monitor type value (only the literal 'monitor' is dropped)", () => {
			const input = {
				monitors: [{ id: "m1", type: "cpu" }],
			};

			const result = compressMcpOutput(input, "Test", null);
			expect(result.monitors[0].type).toBe("cpu");
		});
	});
});
