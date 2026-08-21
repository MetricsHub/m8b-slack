/**
 * Pyodide sandbox worker (worker_threads side of ai/services/code-sandbox.js).
 *
 * Runs LLM-generated Python inside a Pyodide (CPython-on-WebAssembly)
 * interpreter. The WASM boundary means the code has no host filesystem and no
 * network; it only sees an in-memory virtual filesystem with /data (inputs
 * staged by the app) and /outputs (files to deliver to the user).
 *
 * Host-access lockdown: in Node, Pyodide's `js` / `pyodide_js` modules expose
 * the worker's JavaScript scope, and ANY reachable JsProxy yields the Function
 * constructor (full host access). The setup snippet removes Pyodide's JsFinder
 * from sys.meta_path — which also breaks re-imports of pyodide.code/pyodide.ffi,
 * since both depend on pyodide_js — drops the already-imported modules, and
 * patches run_js as defense in depth. _pyodide_core only exposes value
 * converters, which need an existing proxy to be useful. Residual risk is a
 * hostile payload finding a new interop hatch; the parent's hard timeout
 * (worker.terminate) bounds runaway executions either way.
 *
 * The parent serializes executions (one at a time) and terminates the worker
 * on timeout, so this file can keep a single warm interpreter. Each execution
 * gets fresh Python globals and a wiped /data + /outputs, but interpreter-level
 * state (loaded packages, module caches) is intentionally reused for speed.
 */

import { parentPort, workerData } from "node:worker_threads";
import { loadPyodide } from "pyodide";

/** Cap for stdout/stderr/result text sent back per execution. */
const MAX_STREAM_CHARS = 100000;

/**
 * Pure-Python wheels for packages the tool promises but the Pyodide
 * distribution no longer ships. Loaded on demand when the code imports them
 * (pinned PyPI URLs are permanent; loadPackage caches the wheels in
 * packageCacheDir like every other package). Dependencies must be listed
 * explicitly: loadPackage does not resolve PyPI metadata for URL wheels.
 */
const EXTRA_WHEELS = [
	{
		// openpyxl is also pandas' lazy engine for to_excel/read_excel
		trigger: /openpyxl|to_excel|read_excel|ExcelWriter|ExcelFile|\.xlsx/,
		wheels: [
			"https://files.pythonhosted.org/packages/c1/8b/5fe2cc11fee489817272089c4203e679c63b570a5aaeb18d852ae3cbba6a/et_xmlfile-2.0.0-py3-none-any.whl",
			"https://files.pythonhosted.org/packages/c0/da/977ded879c29cbd04de313843e76868e6e13408a94ed6b987245dc7c8506/openpyxl-3.1.5-py2.py3-none-any.whl",
		],
	},
];

/** Loader progress must never leak into the model-facing stdout. */
const SILENT_LOAD = { messageCallback: () => {} };

const SETUP_PYTHON = `
import os, sys

os.environ["MPLBACKEND"] = "AGG"  # matplotlib without the browser (js-based) backend
os.makedirs("/data", exist_ok=True)
os.makedirs("/outputs", exist_ok=True)
os.chdir("/outputs")  # bare relative writes land in the collected directory

# Host-access lockdown (see module docstring)
sys.meta_path = [f for f in sys.meta_path if type(f).__name__ != "JsFinder"]
for _name in list(sys.modules):
    if _name in ("js", "pyodide_js") or _name.startswith(("js.", "pyodide_js.")):
        del sys.modules[_name]
import pyodide.code as _pyodide_code
def _run_js_blocked(*args, **kwargs):
    raise RuntimeError("JavaScript execution is disabled in this sandbox")
_pyodide_code.run_js = _run_js_blocked
del _pyodide_code, _run_js_blocked, _name
`;

let pyodidePromise = null;

function getPyodide() {
	if (!pyodidePromise) {
		const options = {};
		if (workerData?.packageCacheDir) {
			options.packageCacheDir = workerData.packageCacheDir;
		}
		pyodidePromise = loadPyodide(options).then((pyodide) => {
			pyodide.runPython(SETUP_PYTHON);
			return pyodide;
		});
	}
	return pyodidePromise;
}

/**
 * Remove every file and subdirectory under a MEMFS directory.
 */
function clearDir(pyodide, dir) {
	for (const name of pyodide.FS.readdir(dir)) {
		if (name === "." || name === "..") continue;
		const full = `${dir}/${name}`;
		if (pyodide.FS.isDir(pyodide.FS.stat(full).mode)) {
			clearDir(pyodide, full);
			pyodide.FS.rmdir(full);
		} else {
			pyodide.FS.unlink(full);
		}
	}
}

/**
 * Collect all files under a MEMFS directory (recursively) as
 * {name, data: Uint8Array} entries, up to a total byte budget.
 */
function collectFiles(pyodide, dir, prefix, out, budget) {
	for (const name of pyodide.FS.readdir(dir)) {
		if (name === "." || name === "..") continue;
		const full = `${dir}/${name}`;
		if (pyodide.FS.isDir(pyodide.FS.stat(full).mode)) {
			collectFiles(pyodide, full, `${prefix}${name}/`, out, budget);
			continue;
		}
		const data = pyodide.FS.readFile(full);
		if (budget.remaining < data.length) {
			out.skipped.push(`${prefix}${name} (${data.length} bytes)`);
			continue;
		}
		budget.remaining -= data.length;
		out.files.push({ name: `${prefix}${name}`, data });
	}
}

function truncateStream(text) {
	if (text.length <= MAX_STREAM_CHARS) return text;
	return `${text.slice(0, MAX_STREAM_CHARS)}\n[... truncated at ${MAX_STREAM_CHARS} chars]`;
}

async function execute({ code, files }) {
	const pyodide = await getPyodide();

	clearDir(pyodide, "/data");
	clearDir(pyodide, "/outputs");
	for (const file of files || []) {
		pyodide.FS.writeFile(`/data/${file.name}`, file.data);
	}

	// Fetch the Pyodide-built packages the code imports (numpy, pandas,
	// matplotlib, ...). Unknown imports are skipped and surface as a normal
	// Python ModuleNotFoundError below. Packages must load BEFORE stdout
	// capture is armed so loader progress never reaches the model.
	await pyodide.loadPackagesFromImports(code, SILENT_LOAD);
	for (const extra of EXTRA_WHEELS) {
		if (extra.trigger.test(code)) {
			await pyodide.loadPackage(extra.wheels, SILENT_LOAD);
		}
	}

	let stdout = "";
	let stderr = "";
	pyodide.setStdout({
		batched: (line) => {
			stdout += `${line}\n`;
		},
	});
	pyodide.setStderr({
		batched: (line) => {
			stderr += `${line}\n`;
		},
	});

	const namespace = pyodide.globals.get("dict")();
	let ok = true;
	let error = "";
	let resultText = "";
	try {
		const result = await pyodide.runPythonAsync(code, { globals: namespace });
		if (result !== undefined && result !== null) {
			resultText = String(result);
			if (typeof result?.destroy === "function") result.destroy();
		}
	} catch (e) {
		// PythonError.message carries the traceback
		ok = false;
		error = String(e?.message || e);
	} finally {
		namespace.destroy();
	}

	const collected = { files: [], skipped: [] };
	collectFiles(pyodide, "/outputs", "", collected, {
		remaining: workerData?.maxOutputFileBytes || 20 * 1024 * 1024,
	});

	return {
		ok,
		error: error || undefined,
		stdout: truncateStream(stdout),
		stderr: truncateStream(stderr),
		result: truncateStream(resultText),
		outputFiles: collected.files,
		skippedFiles: collected.skipped,
	};
}

parentPort.on("message", async (message) => {
	if (message?.type !== "execute") return;
	try {
		const result = await execute(message);
		parentPort.postMessage({ id: message.id, ...result });
	} catch (e) {
		// Interpreter-level failure (boot, package fetch, FS): not Python's fault
		parentPort.postMessage({
			id: message.id,
			ok: false,
			error: String(e?.message || e),
			stdout: "",
			stderr: "",
			result: "",
			outputFiles: [],
			skippedFiles: [],
		});
	}
});
