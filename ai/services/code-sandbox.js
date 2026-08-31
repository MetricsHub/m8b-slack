/**
 * Local Python code sandbox (Pyodide) - the app-side implementation behind the
 * run_python function tool for providers without a hosted code_interpreter.
 *
 * The actual interpreter lives in a worker thread (code-sandbox-worker.js) so
 * a hard per-execution timeout can be enforced with worker.terminate() — the
 * only reliable way to stop `while True: pass`. The worker is kept warm across
 * executions (Pyodide boot is ~2s, package loads are cached) and replaced with
 * a fresh one after a timeout or crash.
 *
 * Executions are serialized: the single interpreter cannot run two scripts at
 * once, and serialization keeps the memory footprint bounded.
 *
 * Input files are never sent over postMessage: each execution gets a
 * per-execution directory under the staging area (string/Buffer entries are
 * written there, disk-staged attachments are copied there) that the worker
 * mounts as /data via NODEFS. Copying — rather than hardlinking — isolates the
 * shared download cache from writes the sandboxed code may make under /data.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { getCodeSandboxConfig } from "../config/providers.js";

/** Active worker state: { worker, pending: Map<id, {resolve, timer}> } */
let state = null;
let nextExecutionId = 1;

/** Serialization chain: each execution waits for the previous one. */
let executionQueue = Promise.resolve();

/** One-time cleanup of exec dirs a previous process left behind (e.g. crash). */
let sweptStaleExecDirs = false;

/**
 * Keep only a safe basename for files crossing the sandbox boundary
 * (staged inputs and generated outputs). MEMFS makes traversal harmless,
 * but Slack uploads and /data hints deserve clean names.
 *
 * @param {string} name - Raw file name
 * @returns {string} Sanitized file name
 */
export function sanitizeSandboxFileName(name) {
	const base = String(name || "file")
		.replace(/[/\\]+/g, "_")
		.replace(/[^\w.\- ()]/g, "_")
		.trim();
	return base || "file";
}

function getOrCreateWorker(config, logger) {
	if (state) return state;

	const worker = new Worker(new URL("./code-sandbox-worker.js", import.meta.url), {
		workerData: {
			packageCacheDir: config.packageCacheDir,
			maxOutputFileBytes: config.maxOutputFileBytes,
		},
	});
	// The sandbox must never keep the bot process alive on its own
	worker.unref();

	const local = { worker, pending: new Map() };

	worker.on("message", (message) => {
		const entry = local.pending.get(message?.id);
		if (!entry) return;
		local.pending.delete(message.id);
		clearTimeout(entry.timer);
		entry.resolve(message);
	});

	worker.on("error", (err) => {
		logger?.error?.("[SANDBOX] Worker error", { error: String(err) });
		failAllPending(local, `Sandbox worker crashed: ${err?.message || err}`);
		if (state === local) state = null;
	});

	worker.on("exit", (code) => {
		failAllPending(local, `Sandbox worker exited unexpectedly (code ${code})`);
		if (state === local) state = null;
	});

	state = local;
	return local;
}

function failAllPending(local, errorMessage) {
	for (const [, entry] of local.pending) {
		clearTimeout(entry.timer);
		entry.resolve({ ok: false, error: errorMessage, stdout: "", stderr: "", outputFiles: [] });
	}
	local.pending.clear();
}

function discardWorker(local) {
	if (state === local) state = null;
	local.worker.terminate().catch(() => {});
}

/**
 * Materialize an execution's input files into a fresh host directory the
 * worker will mount as /data. String/Buffer entries (large tool outputs) are
 * written directly; disk-staged attachments ({path} references) are copied so
 * sandbox writes can never reach the shared download cache.
 *
 * @param {Array<{name: string, data: (Uint8Array|Buffer|string|{path: string})}>} inputFiles
 * @param {Object} config - Code sandbox configuration
 * @param {number} id - Execution id (unique per process)
 * @returns {Promise<string>} Absolute path of the /data directory
 */
async function prepareDataDir(inputFiles, config, id) {
	const stagingDir = path.resolve(config.stagingDir);

	if (!sweptStaleExecDirs) {
		sweptStaleExecDirs = true;
		// exec-* dirs live for one execution; an old one is debris from a
		// process that crashed or was killed mid-run. The age check keeps the
		// sweep from deleting a concurrent process's live dir (e.g. parallel
		// Jest workers sharing the default staging dir).
		const staleBeforeMs = Date.now() - 24 * 3600 * 1000;
		try {
			for (const name of await fsp.readdir(stagingDir)) {
				if (!name.startsWith("exec-") || name.startsWith(`exec-${process.pid}-`)) continue;
				const dirPath = path.join(stagingDir, name);
				const stat = await fsp.stat(dirPath).catch(() => null);
				if (stat && stat.mtimeMs < staleBeforeMs) {
					await fsp.rm(dirPath, { recursive: true, force: true });
				}
			}
		} catch {
			// Staging dir does not exist yet
		}
	}

	const dataDir = path.join(stagingDir, `exec-${process.pid}-${id}`);
	await fsp.mkdir(dataDir, { recursive: true });

	for (const file of inputFiles || []) {
		const dest = path.join(dataDir, sanitizeSandboxFileName(file.name));
		const data = file.data;
		if (typeof data === "string" || data instanceof Uint8Array) {
			await fsp.writeFile(dest, data);
		} else if (data && typeof data.path === "string") {
			await fsp.copyFile(data.path, dest);
		} else {
			await fsp.writeFile(dest, "");
		}
	}

	return dataDir;
}

async function executeInWorker({ code, inputFiles, timeoutMs, config, logger }) {
	const local = getOrCreateWorker(config, logger);
	const id = nextExecutionId++;

	const dataDir = await prepareDataDir(inputFiles, config, id);

	const response = await new Promise((resolve) => {
		const timer = setTimeout(() => {
			local.pending.delete(id);
			logger?.warn?.(`[SANDBOX] Execution timed out after ${timeoutMs}ms; recycling worker`);
			// terminate() is the only way to stop busy Python; the warm
			// interpreter is lost and the next call boots a fresh one
			discardWorker(local);
			resolve({
				ok: false,
				error: `Execution timed out after ${Math.round(timeoutMs / 1000)}s and was killed. Write faster code (no unbounded loops, no waiting) and try again.`,
				stdout: "",
				stderr: "",
				outputFiles: [],
			});
		}, timeoutMs);

		local.pending.set(id, { resolve, timer });
		local.worker.postMessage({ type: "execute", id, code, dataDir });
	});

	// A timed-out worker is already terminated, so the mount is gone either way
	await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});

	return {
		ok: response.ok === true,
		error: response.error,
		stdout: response.stdout || "",
		stderr: response.stderr || "",
		result: response.result || "",
		outputFiles: (response.outputFiles || []).map((file) => ({
			name: sanitizeSandboxFileName(file.name),
			buffer: Buffer.from(file.data),
		})),
		skippedFiles: response.skippedFiles || [],
	};
}

/**
 * Execute Python code in the local sandbox.
 *
 * @param {Object} params
 * @param {string} params.code - Python source code
 * @param {Array<{name: string, data: (Uint8Array|Buffer|string|{path: string})}>} [params.inputFiles]
 *   Files staged into /data before the run; {path} entries reference
 *   disk-staged attachments and are copied, not loaded into memory
 * @param {number} [params.timeoutMs] - Override the configured execution timeout
 * @param {Object} [params.logger] - Logger instance
 * @returns {Promise<{ok: boolean, error?: string, stdout: string, stderr: string,
 *   result: string, outputFiles: Array<{name: string, buffer: Buffer}>,
 *   skippedFiles: string[], durationMs: number}>}
 */
export async function executePython({ code, inputFiles = [], timeoutMs, logger }) {
	const config = getCodeSandboxConfig();
	if (!config.enabled) {
		return {
			ok: false,
			error: "The Python sandbox is disabled on this deployment (CODE_SANDBOX_ENABLED=false).",
			stdout: "",
			stderr: "",
			result: "",
			outputFiles: [],
			skippedFiles: [],
			durationMs: 0,
		};
	}

	const effectiveTimeout = timeoutMs || config.timeoutMs;

	// Chain onto the queue; a failed execution must not block the next one
	const run = executionQueue.then(() => {
		const started = Date.now();
		return executeInWorker({
			code,
			inputFiles,
			timeoutMs: effectiveTimeout,
			config,
			logger,
		}).then((result) => ({ ...result, durationMs: Date.now() - started }));
	});
	executionQueue = run.then(
		() => {},
		() => {}
	);
	return run;
}

/**
 * Terminate the warm sandbox worker (used by tests to let the process exit).
 */
export async function shutdownCodeSandbox() {
	const local = state;
	state = null;
	if (local) {
		failAllPending(local, "Sandbox shut down");
		await local.worker.terminate().catch(() => {});
	}
}
