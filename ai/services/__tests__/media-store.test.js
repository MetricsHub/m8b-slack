/**
 * Tests for the local media store (native-vision image handling, vLLM mode).
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
	cleanupExpiredMedia,
	EXPIRED_MEDIA_NOTE,
	getMediaStoreConfig,
	isMediaStoreConfigured,
	mediaUrlToFilePath,
	replaceUnavailableMediaImages,
	saveMedia,
	supportedImageExtension,
} from "../media-store.js";

const ENV_KEYS = [
	"M8B_MEDIA_DIR",
	"M8B_MEDIA_BASE_URL",
	"M8B_MEDIA_RETENTION_DAYS",
	"M8B_MEDIA_MAX_FILE_BYTES",
];

describe("media store", () => {
	let dir;
	const savedEnv = {};

	beforeEach(async () => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-media-test-"));
		process.env.M8B_MEDIA_DIR = dir;
		process.env.M8B_MEDIA_BASE_URL = "https://bm-linux-slack.internal.example.net/m8b-media";
	});

	afterEach(async () => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
		await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	it("is configured only when a base URL is set", () => {
		expect(isMediaStoreConfigured()).toBe(true);

		delete process.env.M8B_MEDIA_BASE_URL;
		expect(isMediaStoreConfigured()).toBe(false);
	});

	it("strips trailing slashes from the base URL", () => {
		process.env.M8B_MEDIA_BASE_URL = "https://host/m8b-media///";
		expect(getMediaStoreConfig().baseUrl).toBe("https://host/m8b-media");
	});

	it("maps supported image MIME types to extensions and rejects others", () => {
		expect(supportedImageExtension("image/png")).toBe("png");
		expect(supportedImageExtension("image/jpeg")).toBe("jpg");
		expect(supportedImageExtension("image/webp")).toBe("webp");
		expect(supportedImageExtension("image/gif")).toBe("gif");
		expect(supportedImageExtension("image/heic")).toBeNull();
		expect(supportedImageExtension("application/pdf")).toBeNull();
		expect(supportedImageExtension("")).toBeNull();
	});

	it("saves an image under a UUID name and hands back the internal URL", async () => {
		const saved = await saveMedia({ buffer: Buffer.from("png-bytes"), mimetype: "image/png" });

		expect(saved.fileName).toMatch(/^[0-9a-f-]{36}\.png$/);
		expect(saved.url).toBe(`${getMediaStoreConfig().baseUrl}/${saved.fileName}`);
		expect(await fsp.readFile(saved.filePath, "utf8")).toBe("png-bytes");
	});

	it("refuses to save without a configured base URL or with an unsupported type", async () => {
		await expect(saveMedia({ buffer: Buffer.from("x"), mimetype: "image/heic" })).rejects.toThrow(
			/unsupported image type/i
		);

		delete process.env.M8B_MEDIA_BASE_URL;
		await expect(saveMedia({ buffer: Buffer.from("x"), mimetype: "image/png" })).rejects.toThrow(
			/M8B_MEDIA_BASE_URL/
		);
	});

	it("maps its own URLs back to file paths and rejects foreign or unsafe URLs", async () => {
		const saved = await saveMedia({ buffer: Buffer.from("x"), mimetype: "image/png" });

		expect(mediaUrlToFilePath(saved.url)).toBe(saved.filePath);
		expect(mediaUrlToFilePath("https://other-host/m8b-media/whatever.png")).toBeNull();
		// Path traversal or non-UUID names must never resolve
		expect(mediaUrlToFilePath(`${getMediaStoreConfig().baseUrl}/../../etc/passwd`)).toBeNull();
		expect(mediaUrlToFilePath(`${getMediaStoreConfig().baseUrl}/not-a-uuid.png`)).toBeNull();
		expect(mediaUrlToFilePath(null)).toBeNull();
	});

	it("replaces only input_image references whose file is gone", async () => {
		const kept = await saveMedia({ buffer: Buffer.from("x"), mimetype: "image/png" });
		const gone = await saveMedia({ buffer: Buffer.from("y"), mimetype: "image/png" });
		await fsp.unlink(gone.filePath);

		const items = [
			{ role: "system", content: [{ type: "input_text", text: "prompt" }] },
			{
				role: "user",
				content: [
					{ type: "input_text", text: "look at these" },
					{ type: "input_image", detail: "auto", image_url: kept.url },
					{ type: "input_image", detail: "auto", image_url: gone.url },
					{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
				],
			},
			{ type: "function_call", call_id: "c1", name: "ping", arguments: "{}" },
		];

		const result = replaceUnavailableMediaImages(items);

		const content = result[1].content;
		expect(content[1]).toEqual({ type: "input_image", detail: "auto", image_url: kept.url });
		expect(content[2]).toEqual({ type: "input_text", text: EXPIRED_MEDIA_NOTE });
		expect(content[3].image_url).toBe("data:image/png;base64,AAAA");
		// Untouched items are not copied
		expect(result[0]).toBe(items[0]);
		expect(result[2]).toBe(items[2]);
	});

	it("returns the same array when nothing is expired", async () => {
		const saved = await saveMedia({ buffer: Buffer.from("x"), mimetype: "image/png" });
		const items = [
			{ role: "user", content: [{ type: "input_image", detail: "auto", image_url: saved.url }] },
		];

		expect(replaceUnavailableMediaImages(items)).toBe(items);
	});

	it("deletes only store-shaped files older than the retention period", async () => {
		const old = await saveMedia({ buffer: Buffer.from("old"), mimetype: "image/png" });
		const fresh = await saveMedia({ buffer: Buffer.from("fresh"), mimetype: "image/png" });
		const foreign = path.join(dir, "keep-me.txt");
		await fsp.writeFile(foreign, "not managed by the store");

		// Backdate the old file and the foreign file beyond the retention period
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await fsp.utimes(old.filePath, eightDaysAgo, eightDaysAgo);
		await fsp.utimes(foreign, eightDaysAgo, eightDaysAgo);

		const deleted = await cleanupExpiredMedia();

		expect(deleted).toBe(1);
		await expect(fsp.access(old.filePath)).rejects.toThrow();
		await expect(fsp.access(fresh.filePath)).resolves.toBeUndefined();
		await expect(fsp.access(foreign)).resolves.toBeUndefined();
	});

	it("honors a custom retention period", async () => {
		process.env.M8B_MEDIA_RETENTION_DAYS = "1";
		const saved = await saveMedia({ buffer: Buffer.from("x"), mimetype: "image/png" });
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		await fsp.utimes(saved.filePath, twoDaysAgo, twoDaysAgo);

		expect(await cleanupExpiredMedia()).toBe(1);
	});

	it("cleanup is a no-op when the directory does not exist", async () => {
		process.env.M8B_MEDIA_DIR = path.join(dir, "does-not-exist");
		expect(await cleanupExpiredMedia()).toBe(0);
	});
});
