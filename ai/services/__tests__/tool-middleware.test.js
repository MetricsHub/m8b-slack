import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
	clearCache,
	compressMcpOutput,
	executeWithMiddleware,
	telemetryToMarkdown,
} from "../tool-middleware.js";

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

/**
 * Fixture modeled on a compressed GetMetricsFromCacheForHost response:
 * results[].result.hosts[].response.telemetry.monitors.<type>[]
 */
function makeMarkdownFixture() {
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
												attributes: {
													entityName: "Linux_file_system_/dev/mapper/vg_os-lv_root(/)",
													"system.filesystem.mountpoint": "/",
													"system.filesystem.type": "xfs",
													"system.device": "/dev/mapper/vg_os-lv_root(/)",
												},
												metrics: {
													'system.filesystem.usage{system.filesystem.state="used"}': 6815531520,
													'system.filesystem.usage{system.filesystem.state="free"}': 1815531520,
													'system.filesystem.utilization{system.filesystem.state="used"}': 0.72,
												},
											},
											{
												attributes: {
													entityName: "Linux_file_system_/dev/sda1(/boot)",
													"system.filesystem.mountpoint": "/boot",
												},
												metrics: {
													'system.filesystem.usage{system.filesystem.state="free"}': 500000000,
												},
											},
										],
										cpu: [
											{
												attributes: {
													entityName: "Hardware_cpu_CPU 1",
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

describe("telemetryToMarkdown", () => {
	it("renders one section per host and one table per monitor type", () => {
		const markdown = telemetryToMarkdown(makeMarkdownFixture());

		expect(markdown).toContain("# Host: ecs1-01 (agent: m8b-agent-01)");
		expect(markdown).toContain("## file_system (2)");
		expect(markdown).toContain("## cpu (1)");
	});

	it("keeps every attribute, metric name, value, and status verbatim", () => {
		const markdown = telemetryToMarkdown(makeMarkdownFixture());

		// Attribute values (including parens-heavy device paths)
		expect(markdown).toContain("/dev/mapper/vg_os-lv_root(/)");
		expect(markdown).toContain("/boot");
		expect(markdown).toContain("Intel Xeon Gold 6338");
		// Metric values, no rounding
		expect(markdown).toContain("6815531520");
		expect(markdown).toContain("1815531520");
		expect(markdown).toContain("0.72");
		expect(markdown).toContain("143.2");
		// Statuses
		expect(markdown).toContain("| ok |");
	});

	it("factors a shared metric-name prefix out of column headers", () => {
		const markdown = telemetryToMarkdown(makeMarkdownFixture());
		const fileSystemSection = markdown.slice(markdown.indexOf("## file_system"));

		expect(fileSystemSection).toContain("metric columns omit the prefix `system.filesystem.`");
		expect(fileSystemSection).toContain('usage{system.filesystem.state="used"}');
		expect(fileSystemSection).not.toContain(
			'system.filesystem.usage{system.filesystem.state="used"}'
		);
	});

	it("keeps full metric names when the shared prefix is too short", () => {
		const markdown = telemetryToMarkdown(makeMarkdownFixture());
		const cpuSection = markdown.slice(markdown.indexOf("## cpu"));

		// "hw." is below the factoring threshold — headers stay complete
		expect(cpuSection).toContain('hw.status{hw.type="cpu"}');
		expect(cpuSection).toContain('hw.power{hw.type="cpu"}');
		expect(cpuSection).not.toContain("omit the prefix");
	});

	it("leaves cells empty for attributes/metrics an instance does not have", () => {
		const markdown = telemetryToMarkdown(makeMarkdownFixture());
		const bootRow = markdown
			.split("\n")
			.find((line) => line.includes("Linux_file_system_/dev/sda1(/boot)"));

		// Columns: entityName, mountpoint, type, device, usage{used}, usage{free}, utilization{used}
		expect(bootRow).toBe("| Linux_file_system_/dev/sda1(/boot) | /boot |  |  |  | 500000000 |  |");
	});

	it("skips instances whose attributes and metrics are all empty", () => {
		const fixture = makeMarkdownFixture();
		const monitors = fixture.results[0].result.hosts[0].response.telemetry.monitors;
		monitors.cpu.push({ attributes: {}, metrics: {} });

		const markdown = telemetryToMarkdown(fixture);

		expect(markdown).toContain("## cpu (1)");
	});

	it("keeps both host entries when two share one hostname (OS view + hardware view)", () => {
		const fixture = makeMarkdownFixture();
		fixture.results[0].result.hosts.push({
			hostname: "ecs1-01",
			response: {
				telemetry: {
					monitors: {
						enclosure: [
							{
								attributes: { entityName: "Hardware_enclosure_1" },
								metrics: { 'hw.status{hw.type="enclosure"}': "ok" },
							},
						],
					},
				},
			},
		});

		const markdown = telemetryToMarkdown(fixture);

		expect(markdown.match(/# Host: ecs1-01/g)).toHaveLength(2);
		expect(markdown).toContain("## enclosure (1)");
	});

	it("renders extra instance fields and nested text parameters as columns", () => {
		const fixture = makeMarkdownFixture();
		const monitors = fixture.results[0].result.hosts[0].response.telemetry.monitors;
		monitors.connector = [
			{
				type: "connector",
				is_endpoint: true,
				attributes: { entityName: "Connector_Linux" },
				metrics: { "metricshub.connector.status": "ok" },
				legacyTextParameters: { StatusInformation: "line one\nline two" },
			},
		];

		const markdown = telemetryToMarkdown(fixture);
		const connectorSection = markdown.slice(markdown.indexOf("## connector"));

		expect(connectorSection).toContain("type");
		expect(connectorSection).toContain("is_endpoint");
		expect(connectorSection).toContain("legacyTextParameters.StatusInformation");
		expect(connectorSection).toContain("line one<br>line two");

		// Identity attributes lead the table, metrics follow, extra fields
		// (text blobs like StatusInformation) trail
		const headerLine = connectorSection.split("\n").find((line) => line.startsWith("|"));
		const columnOrder = [
			headerLine.indexOf("entityName"),
			headerLine.indexOf("metricshub.connector.status"),
			headerLine.indexOf("legacyTextParameters.StatusInformation"),
		];
		expect(columnOrder.every((idx) => idx !== -1)).toBe(true);
		expect(columnOrder).toEqual([...columnOrder].sort((a, b) => a - b));
	});

	it("escapes pipe characters in cell values", () => {
		const fixture = makeMarkdownFixture();
		const monitors = fixture.results[0].result.hosts[0].response.telemetry.monitors;
		monitors.cpu[0].attributes.info = "Xeon | 2.0GHz";

		const markdown = telemetryToMarkdown(fixture);

		expect(markdown).toContain("Xeon \\| 2.0GHz");
	});

	it("returns null for non-telemetry shapes", () => {
		expect(telemetryToMarkdown(null)).toBeNull();
		expect(telemetryToMarkdown("text")).toBeNull();
		expect(telemetryToMarkdown({ ok: true })).toBeNull();
		// ListHosts-like shape
		expect(telemetryToMarkdown({ ok: true, hosts: [{ hostname: "a" }] })).toBeNull();
		// results without the telemetry nesting
		expect(telemetryToMarkdown({ ok: true, results: [{ value: 42 }] })).toBeNull();
		// error results keep their JSON form
		expect(telemetryToMarkdown({ ok: false, results: [{}] })).toBeNull();
	});

	it("returns null for the legacy shape (monitors as a flat array)", () => {
		const fixture = {
			ok: true,
			results: [
				{
					result: {
						hosts: [
							{
								hostname: "legacy-01",
								response: { telemetry: { monitors: [{ id: "m1", metrics: { m: 1 } }] } },
							},
						],
					},
				},
			],
		};

		expect(telemetryToMarkdown(fixture)).toBeNull();
	});

	it("returns null when any result entry is an error (mixed results keep JSON)", () => {
		const fixture = makeMarkdownFixture();
		fixture.results.push({ server_label: "m8b-agent-02", ok: false, error: "unreachable" });

		expect(telemetryToMarkdown(fixture)).toBeNull();
	});

	it("is dramatically smaller than the equivalent JSON once rows share columns", () => {
		// Savings scale with row count: JSON repeats every metric name per
		// instance, the table pays for each distinct name once. Model ~24
		// filesystems like a real host (live measurement: ~65% smaller).
		const fixture = makeMarkdownFixture();
		const monitors = fixture.results[0].result.hosts[0].response.telemetry.monitors;
		monitors.file_system = Array.from({ length: 24 }, (_, i) => ({
			attributes: {
				entityName: `Linux_file_system_/dev/mapper/vg_os-lv_vol${i}(/data/vol${i})`,
				"system.filesystem.mountpoint": `/data/vol${i}`,
				"system.filesystem.type": "xfs",
				"system.device": `/dev/mapper/vg_os-lv_vol${i}(/data/vol${i})`,
			},
			metrics: {
				'system.filesystem.usage{system.filesystem.state="used"}': 1000000 + i,
				'system.filesystem.usage{system.filesystem.state="free"}': 2000000 + i,
				'system.filesystem.utilization{system.filesystem.state="used"}': 0.3 + i / 100,
			},
		}));

		const jsonLength = JSON.stringify(fixture).length;
		const markdown = telemetryToMarkdown(fixture);

		expect(markdown.length).toBeLessThan(jsonLength * 0.5);
	});
});

describe("executeWithMiddleware (telemetry Markdown inline output)", () => {
	beforeEach(() => {
		clearCache();
	});

	it("returns Markdown inline for telemetry outputs without file uploads (Ollama mode)", async () => {
		const output = await executeWithMiddleware(
			"GetMetricsFromCacheForHost",
			{ hostname: "ecs1-01" },
			async () => makeMarkdownFixture(),
			{}
		);

		expect(typeof output).toBe("string");
		expect(output).toContain("# Host: ecs1-01");
		expect(output).toContain("## file_system (2)");
		expect(output).not.toContain("uploaded as");
	});

	it("returns Markdown inline plus a full-JSON file reference (OpenAI mode)", async () => {
		const openaiClient = {
			files: { create: jest.fn(async () => ({ id: "file-telemetry-1" })) },
		};
		const fileTracking = {
			uploadedFiles: [],
			codeFileIds: new Set(),
			codeContainerFiles: new Map(),
		};

		const output = await executeWithMiddleware(
			"GetMetricsFromCacheForHost",
			{ hostname: "ecs1-01" },
			async () => makeMarkdownFixture(),
			{ openaiClient, fileTracking }
		);

		expect(typeof output).toBe("string");
		expect(output).toContain("# Host: ecs1-01");
		// The uploaded file keeps the full JSON for code_interpreter
		expect(openaiClient.files.create).toHaveBeenCalledTimes(1);
		expect(fileTracking.codeFileIds.has("file-telemetry-1")).toBe(true);
		expect(output).toContain("Full JSON");
		expect(output).toContain("code_interpreter");
	});

	it("keeps JSON output for non-telemetry results", async () => {
		const output = await executeWithMiddleware(
			"ListHosts",
			{},
			async () => ({ ok: true, hosts: [{ hostname: "ecs1-01" }, { hostname: "ecs1-02" }] }),
			{}
		);

		expect(typeof output).toBe("object");
		expect(output.hosts).toHaveLength(2);
	});
});

describe("telemetryToMarkdown (summary instances and value compaction)", () => {
	/** A monitor type with 3 real instances plus MetricsHub's summary instance. */
	function makeSummaryFixture() {
		return {
			ok: true,
			results: [
				{
					ok: true,
					result: {
						hosts: [
							{
								hostname: "ecs1-01",
								response: {
									telemetry: {
										monitors: {
											fan: [
												{
													attributes: { entityName: "Fan 1", "sensor.location": "bay1" },
													metrics: { 'hw.status{hw.type="fan"}': "ok", "hw.fan.speed": 4200 },
												},
												{
													attributes: { entityName: "Fan 2", "sensor.location": "bay2" },
													metrics: { 'hw.status{hw.type="fan"}': "ok", "hw.fan.speed": 4180 },
												},
												{
													attributes: { entityName: "Fan 3", "sensor.location": "bay3" },
													metrics: { 'hw.status{hw.type="fan"}': "ok", "hw.fan.speed": 4210 },
												},
												{
													type: "summary",
													totalMonitors: 3,
													numericMetrics: {
														"hw.fan.speed": {
															avg: 4196.666666666667,
															min: 4180,
															max: 4210,
															sum: 12590,
															count: 3,
														},
													},
													stateSetMetrics: {
														'hw.status{hw.type="fan"}': [{ value: "ok", count: 3 }],
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

	it("renders the summary instance as a separate aggregate block, not table columns", () => {
		const markdown = telemetryToMarkdown(makeSummaryFixture());

		// Heading counts only regular instances
		expect(markdown).toContain("## fan (3)");
		// Aggregates become a compact stat table
		expect(markdown).toContain("Aggregates across 3 instances");
		expect(markdown).toContain("| metric | avg | min | max | sum | count |");
		expect(markdown).toContain("| hw.fan.speed | 4196.67 | 4180 | 4210 | 12590 | 3 |");
		// State sets become one summary line
		expect(markdown).toContain('State summary — hw.status{hw.type="fan"}: ok ×3');
		// The instance table must NOT grow numericMetrics.* columns
		expect(markdown).not.toContain("numericMetrics.");
	});

	it("skips aggregate blocks that summarize a single instance", () => {
		const fixture = makeSummaryFixture();
		const monitors = fixture.results[0].result.hosts[0].response.telemetry.monitors;
		monitors.fan = [
			monitors.fan[0],
			{
				type: "summary",
				totalMonitors: 1,
				numericMetrics: {
					"hw.fan.speed": { avg: 4200, min: 4200, max: 4200, sum: 4200, count: 1 },
				},
			},
		];

		const markdown = telemetryToMarkdown(fixture);

		expect(markdown).toContain("## fan (1)");
		expect(markdown).not.toContain("Aggregates across");
	});

	it("omits duplicate columns with a note (same values on every row)", () => {
		const fixture = makeSummaryFixture();
		const monitors = fixture.results[0].result.hosts[0].response.telemetry.monitors;
		// MetricsHub-style duplication: utilization repeats rate(...time...) values
		for (const fan of monitors.fan.slice(0, 3)) {
			fan.metrics["rate(hw.fan.time)"] = fan.metrics["hw.fan.speed"] / 100;
			fan.metrics["hw.fan.utilization"] = fan.metrics["hw.fan.speed"] / 100;
		}

		const markdown = telemetryToMarkdown(fixture);

		expect(markdown).toContain(
			"Column `hw.fan.utilization` is omitted: identical values to `rate(hw.fan.time)`."
		);
		const headerLine = markdown.split("\n").find((line) => line.startsWith("| entityName"));
		expect(headerLine).toContain("rate(hw.fan.time)");
		expect(headerLine).not.toContain("hw.fan.utilization");
	});

	it("does not pair constant columns as duplicates", () => {
		const fixture = makeSummaryFixture();
		const monitors = fixture.results[0].result.hosts[0].response.telemetry.monitors;
		// Two coincidentally identical constant columns must both stay
		for (const fan of monitors.fan.slice(0, 3)) {
			fan.metrics["hw.fan.present"] = 1;
			fan.metrics["hw.fan.enabled"] = 1;
		}

		const markdown = telemetryToMarkdown(fixture);

		const headerLine = markdown.split("\n").find((line) => line.startsWith("| entityName"));
		expect(headerLine).toContain("hw.fan.present");
		expect(headerLine).toContain("hw.fan.enabled");
		expect(markdown).not.toContain("hw.fan.enabled` is omitted");
	});

	it("rounds non-integer numbers to 6 significant digits, keeps integers exact", () => {
		const fixture = makeSummaryFixture();
		const monitors = fixture.results[0].result.hosts[0].response.telemetry.monitors;
		monitors.fan[0].metrics["hw.fan.speed_ratio"] = 0.0934855343435854;
		monitors.fan[0].metrics["hw.fan.serial"] = 1815531520;

		const markdown = telemetryToMarkdown(fixture);

		expect(markdown).toContain("| 0.0934855 |");
		expect(markdown).not.toContain("0.0934855343435854");
		expect(markdown).toContain("| 1815531520 |");
	});
});

describe("compressMcpOutput (current-shape summary fields)", () => {
	it("deduplicates StatusInformation in textParams (current-shape name)", () => {
		const duplicatedStatus =
			"Executed Criterion:\n\nResult:\nvalid\n\nMessage:\n====================================\ncheck ok\n====================================\n\nConclusion:\nTest SUCCEEDED";
		const input = {
			monitors: {
				connector: [
					{
						attributes: { entityName: "Connector_Linux" },
						textParams: { StatusInformation: duplicatedStatus },
					},
				],
			},
		};

		const result = compressMcpOutput(input, "Test", null);
		const statusInfo = result.monitors.connector[0].textParams.StatusInformation;

		expect(statusInfo).toContain("Result:\nvalid");
		expect(statusInfo).toContain("Conclusion:");
		expect(statusInfo).not.toContain("Message:");
	});

	it("filters internal job telemetry out of numericMetrics aggregates", () => {
		const input = {
			monitors: {
				host: [
					{
						type: "summary",
						totalMonitors: 2,
						numericMetrics: {
							'metricshub.job.duration{job.type="simple"}': { avg: 1.2, count: 2 },
							"hw.host.power": { avg: 120, count: 2 },
						},
					},
				],
			},
		};

		const result = compressMcpOutput(input, "Test", null);
		const numeric = result.monitors.host[0].numericMetrics;

		expect(numeric["hw.host.power"]).toEqual({ avg: 120, count: 2 });
		expect(Object.keys(numeric).filter((k) => k.startsWith("metricshub.job."))).toHaveLength(0);
	});
});
