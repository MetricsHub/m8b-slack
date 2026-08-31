/**
 * Disk-backed staging for run_python input files.
 *
 * Slack attachments are streamed into a persistent on-disk cache keyed by the
 * immutable Slack file id, so a large attachment is downloaded once per file
 * version — not re-downloaded on every message of the thread — and is never
 * buffered whole in Node memory. The per-turn sandboxFiles map then carries
 * {path, bytes} references instead of Buffers; code-sandbox.js materializes
 * them into a per-execution directory that the Pyodide worker mounts as /data.
 *
 * The cache is bounded by stagingCacheMaxBytes: once it grows past the cap,
 * the least recently used entries (by mtime, refreshed on every cache hit)
 * are evicted.
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { getCodeSandboxConfig } from "../config/providers.js";

/**
 * Absolute path of the attachment download cache directory.
 *
 * @returns {string}
 */
export function stagingCacheDir() {
	return path.resolve(getCodeSandboxConfig().stagingDir, "cache");
}

/**
 * Compute the cache path for one Slack file version. The key (Slack file id
 * or private URL) is hashed so distinct versions never collide even when the
 * user re-uploads a file under the same name.
 *
 * @param {string} cacheKey - Stable per-file-version key
 * @param {string} fileName - Sanitized display file name
 * @returns {string} Absolute path inside the staging cache
 */
export function stagedFilePathFor(cacheKey, fileName) {
	const digest = crypto.createHash("sha1").update(String(cacheKey)).digest("hex").slice(0, 16);
	return path.join(stagingCacheDir(), `${digest}-${fileName}`);
}

/**
 * Look up a cached staged file. A hit refreshes the file's mtime so eviction
 * stays least-recently-used.
 *
 * @param {string} filePath - Path returned by stagedFilePathFor
 * @returns {Promise<{path: string, bytes: number}|null>}
 */
export async function findStagedFile(filePath) {
	try {
		const stat = await fsp.stat(filePath);
		if (!stat.isFile()) return null;
		const now = new Date();
		await fsp.utimes(filePath, now, now).catch(() => {});
		return { path: filePath, bytes: stat.size };
	} catch {
		return null;
	}
}

/**
 * Evict least-recently-used files until the staging cache fits under its
 * byte cap. Called after each new download; failures are non-fatal.
 *
 * @param {Object} [logger] - Logger instance
 * @returns {Promise<void>}
 */
export async function evictStagingCache(logger) {
	const { stagingCacheMaxBytes } = getCodeSandboxConfig();
	const dir = stagingCacheDir();

	let names;
	try {
		names = await fsp.readdir(dir);
	} catch {
		return;
	}

	const files = [];
	for (const name of names) {
		try {
			const stat = await fsp.stat(path.join(dir, name));
			if (stat.isFile()) files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
		} catch {
			// Concurrently removed; skip
		}
	}

	let total = files.reduce((sum, file) => sum + file.size, 0);
	if (total <= stagingCacheMaxBytes) return;

	files.sort((a, b) => a.mtimeMs - b.mtimeMs);
	for (const file of files) {
		if (total <= stagingCacheMaxBytes) break;
		try {
			await fsp.unlink(path.join(dir, file.name));
			total -= file.size;
			logger?.info?.("Evicted staged attachment from the sandbox cache", {
				name: file.name,
				bytes: file.size,
			});
		} catch {
			// Locked or already gone; count it as still present
		}
	}
}
