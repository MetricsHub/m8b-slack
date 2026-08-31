/**
 * Tests for the local Python code sandbox (Pyodide in a worker thread).
 *
 * These are real-interpreter integration tests: they boot Pyodide from
 * node_modules (no network needed) and run pure-Python code. Package-loading
 * paths (numpy, pandas) are exercised by the live scenarios, not here.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, jest } from "@jest/globals";
import { executePython, sanitizeSandboxFileName, shutdownCodeSandbox } from "../code-sandbox.js";

jest.setTimeout(120000);

afterAll(async () => {
	await shutdownCodeSandbox();
});

describe("sanitizeSandboxFileName", () => {
	it("keeps safe names and strips path separators", () => {
		expect(sanitizeSandboxFileName("report.csv")).toBe("report.csv");
		expect(sanitizeSandboxFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
		expect(sanitizeSandboxFileName("charts\\q3 (final).png")).toBe("charts_q3 (final).png");
		expect(sanitizeSandboxFileName("")).toBe("file");
	});
});

describe("executePython", () => {
	it("runs code, captures stdout and the final expression", async () => {
		const result = await executePython({ code: "print('hello from m8b')\n40 + 2" });

		expect(result.ok).toBe(true);
		expect(result.stdout).toContain("hello from m8b");
		expect(result.result).toBe("42");
		expect(result.outputFiles).toEqual([]);
	});

	it("collects files written to the working directory as output files", async () => {
		const result = await executePython({
			code: [
				"with open('hosts.csv', 'w') as f:",
				"    f.write('hostname,status\\nsrv-01,ok\\n')",
			].join("\n"),
		});

		expect(result.ok).toBe(true);
		expect(result.outputFiles).toHaveLength(1);
		expect(result.outputFiles[0].name).toBe("hosts.csv");
		expect(result.outputFiles[0].buffer.toString("utf8")).toBe("hostname,status\nsrv-01,ok\n");
	});

	it("exposes staged input files under /data", async () => {
		const result = await executePython({
			code: [
				"import json",
				"data = json.load(open('/data/telemetry.json'))",
				"print(data['hosts'][0])",
			].join("\n"),
			inputFiles: [{ name: "telemetry.json", data: JSON.stringify({ hosts: ["srv-42"] }) }],
		});

		expect(result.ok).toBe(true);
		expect(result.stdout).toContain("srv-42");
	});

	it("exposes disk-staged {path} input files under /data without copying into memory", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-sandbox-test-"));
		const staged = path.join(dir, "big.log");
		try {
			await fsp.writeFile(staged, "ERROR srv-07 disk full\nINFO all good\n");

			const result = await executePython({
				code: [
					"import re",
					"text = open('/data/big.log').read()",
					"print(re.findall(r'ERROR (\\S+)', text)[0])",
				].join("\n"),
				inputFiles: [{ name: "big.log", data: { path: staged } }],
			});

			expect(result.ok).toBe(true);
			expect(result.stdout).toContain("srv-07");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("never lets sandbox writes under /data reach the staged source file", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-sandbox-test-"));
		const staged = path.join(dir, "cached.txt");
		try {
			await fsp.writeFile(staged, "original");

			const result = await executePython({
				code: "open('/data/cached.txt', 'w').write('tampered')",
				inputFiles: [{ name: "cached.txt", data: { path: staged } }],
			});

			expect(result.ok).toBe(true);
			// The execution wrote to its private copy; the cache entry is intact
			expect(await fsp.readFile(staged, "utf8")).toBe("original");
		} finally {
			await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("gives each execution its own /data (files do not leak between runs)", async () => {
		await executePython({
			code: "pass",
			inputFiles: [{ name: "first.txt", data: "one" }],
		});
		const result = await executePython({ code: "import os\nprint(os.listdir('/data'))" });

		expect(result.ok).toBe(true);
		expect(result.stdout).not.toContain("first.txt");
	});

	it("does not leak variables between executions", async () => {
		await executePython({ code: "leaked_secret = 'boo'" });
		const result = await executePython({ code: "print(leaked_secret)" });

		expect(result.ok).toBe(false);
		expect(result.error).toContain("NameError");
	});

	it("clears previous output files between executions", async () => {
		await executePython({ code: "open('stale.txt', 'w').write('old')" });
		const result = await executePython({ code: "open('fresh.txt', 'w').write('new')" });

		expect(result.outputFiles.map((f) => f.name)).toEqual(["fresh.txt"]);
	});

	it("returns the Python traceback on errors, keeping earlier stdout", async () => {
		const result = await executePython({
			code: "print('before the crash')\nraise ValueError('kaboom')",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("ValueError");
		expect(result.error).toContain("kaboom");
		expect(result.stdout).toContain("before the crash");
	});

	it("blocks access to the host JavaScript scope", async () => {
		for (const attempt of [
			"import js",
			"import pyodide_js",
			"from pyodide.code import run_js\nrun_js('globalThis.process.pid')",
		]) {
			const result = await executePython({ code: attempt });
			expect(result.ok).toBe(false);
		}
	});

	it("kills runaway executions at the timeout and recovers afterwards", async () => {
		const result = await executePython({
			code: "while True:\n    pass",
			timeoutMs: 3000,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("timed out");

		// The worker was recycled: the next execution boots fresh and works
		const recovered = await executePython({ code: "1 + 1" });
		expect(recovered.ok).toBe(true);
		expect(recovered.result).toBe("2");
	});

	it("reports the sandbox as disabled when CODE_SANDBOX_ENABLED=false", async () => {
		process.env.CODE_SANDBOX_ENABLED = "false";
		try {
			const result = await executePython({ code: "1 + 1" });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("disabled");
		} finally {
			delete process.env.CODE_SANDBOX_ENABLED;
		}
	});
});
