/**
 * Tests for the disk-backed sandbox staging cache.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
	evictStagingCache,
	findStagedFile,
	stagedFilePathFor,
	stagingCacheDir,
} from "../sandbox-staging.js";

const ENV_KEYS = ["CODE_SANDBOX_STAGING_DIR", "CODE_SANDBOX_STAGING_CACHE_MAX_BYTES"];
const savedEnv = {};
let stagingDir;

beforeEach(async () => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-staging-unit-"));
	process.env.CODE_SANDBOX_STAGING_DIR = stagingDir;
});

afterEach(async () => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
});

async function writeCacheFile(name, content, mtime) {
	const dir = stagingCacheDir();
	await fsp.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, name);
	await fsp.writeFile(filePath, content);
	if (mtime) await fsp.utimes(filePath, mtime, mtime);
	return filePath;
}

describe("stagedFilePathFor", () => {
	it("gives distinct paths to distinct file versions sharing a name", () => {
		const first = stagedFilePathFor("F_ONE", "hosts.csv");
		const second = stagedFilePathFor("F_TWO", "hosts.csv");

		expect(first).not.toBe(second);
		expect(path.dirname(first)).toBe(stagingCacheDir());
		expect(path.basename(first)).toMatch(/^[0-9a-f]{16}-hosts\.csv$/);
	});
});

describe("findStagedFile", () => {
	it("returns path and size for a cached file, null otherwise", async () => {
		const filePath = await writeCacheFile("abc-hosts.csv", "a,b\n1,2\n");

		expect(await findStagedFile(filePath)).toEqual({ path: filePath, bytes: 8 });
		expect(await findStagedFile(path.join(stagingCacheDir(), "missing.csv"))).toBeNull();
	});

	it("refreshes mtime on hits so eviction stays least-recently-used", async () => {
		const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
		const filePath = await writeCacheFile("abc-hosts.csv", "a,b\n1,2\n", old);

		await findStagedFile(filePath);

		const stat = await fsp.stat(filePath);
		expect(stat.mtimeMs).toBeGreaterThan(old.getTime() + 1000);
	});
});

describe("evictStagingCache", () => {
	it("removes the oldest files until the cache fits the cap", async () => {
		process.env.CODE_SANDBOX_STAGING_CACHE_MAX_BYTES = "20";
		const oldest = await writeCacheFile("aa-old.csv", "0123456789", new Date(Date.now() - 3000));
		const middle = await writeCacheFile("bb-mid.csv", "0123456789", new Date(Date.now() - 2000));
		const newest = await writeCacheFile("cc-new.csv", "0123456789", new Date(Date.now() - 1000));

		await evictStagingCache();

		expect(await findStagedFile(oldest)).toBeNull();
		expect(await findStagedFile(middle)).not.toBeNull();
		expect(await findStagedFile(newest)).not.toBeNull();
	});

	it("does nothing while under the cap or without a cache directory", async () => {
		await evictStagingCache(); // no directory yet: must not throw

		process.env.CODE_SANDBOX_STAGING_CACHE_MAX_BYTES = "1024";
		const filePath = await writeCacheFile("aa-small.csv", "tiny");
		await evictStagingCache();

		expect(await findStagedFile(filePath)).not.toBeNull();
	});
});
