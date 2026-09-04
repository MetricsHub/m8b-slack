/**
 * Local media store for native-vision providers (vLLM).
 *
 * Slack images are downloaded once (with Slack credentials), saved under
 * M8B_MEDIA_DIR with a random UUID name, and referenced in the conversation
 * history by a short internal URL under M8B_MEDIA_BASE_URL. The URL is served
 * by a reverse proxy (NGINX) that only the inference host may reach, so the
 * model backend can fetch the image without any Slack credentials — and
 * resending the conversation history costs bytes for a URL, not for base64
 * image data.
 *
 * Files are deleted after M8B_MEDIA_RETENTION_DAYS (default 7). A stored
 * conversation that still references a deleted file would make the whole
 * model request fail (the backend returns 422 on an unfetchable image), so
 * replaceUnavailableMediaImages() swaps such references for a text marker
 * before every request. In practice the in-memory conversation store expires
 * long before the files do; when a thread is rebuilt from Slack history the
 * images are re-downloaded and re-saved, so old threads recover on their own.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** Default media directory (deployments typically set /var/lib/m8b/media) */
const DEFAULT_MEDIA_DIR = "data/media";

const DEFAULT_RETENTION_DAYS = 7;

/** Age-based cleanup sweep interval */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Image formats the vision backend accepts; anything else degrades to a note */
const IMAGE_EXTENSIONS = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** <uuid>.<ext> — the only file shape the store creates, reads, or deletes */
const MEDIA_FILE_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/;

/** Marker replacing an image whose stored file has been cleaned up */
export const EXPIRED_MEDIA_NOTE =
	"[A previously attached screenshot is no longer available (expired from the media store).]";

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Get the media store configuration from environment variables.
 *
 * @returns {{dir: string, baseUrl: string, retentionDays: number, maxFileBytes: number}}
 */
export function getMediaStoreConfig() {
	return {
		dir: process.env.M8B_MEDIA_DIR || DEFAULT_MEDIA_DIR,
		// Public (internal-network) base URL the inference host fetches from,
		// e.g. https://m8b.internal.example.com/m8b-media
		baseUrl: (process.env.M8B_MEDIA_BASE_URL || "").trim().replace(/\/+$/, ""),
		retentionDays: parsePositiveInt(process.env.M8B_MEDIA_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
		maxFileBytes: parsePositiveInt(process.env.M8B_MEDIA_MAX_FILE_BYTES, 10 * 1024 * 1024),
	};
}

/**
 * True when the media store can hand out URLs (M8B_MEDIA_BASE_URL is set).
 * Without it, native-vision images fall back to inline base64 data URLs.
 *
 * @returns {boolean}
 */
export function isMediaStoreConfigured() {
	return Boolean(getMediaStoreConfig().baseUrl);
}

/**
 * File extension for a supported image MIME type, or null when the vision
 * backend does not accept the format.
 *
 * @param {string} mimetype - Image MIME type
 * @returns {string|null}
 */
export function supportedImageExtension(mimetype) {
	return IMAGE_EXTENSIONS[String(mimetype || "").toLowerCase()] || null;
}

/**
 * Save an image buffer into the media store.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - Raw image bytes
 * @param {string} params.mimetype - Image MIME type (must be supported)
 * @returns {Promise<{mediaId: string, fileName: string, filePath: string, url: string}>}
 */
export async function saveMedia({ buffer, mimetype }) {
	const config = getMediaStoreConfig();
	if (!config.baseUrl) {
		throw new Error("Media store is not configured (M8B_MEDIA_BASE_URL is not set)");
	}

	const extension = supportedImageExtension(mimetype);
	if (!extension) {
		throw new Error(`Unsupported image type for the media store: ${mimetype}`);
	}

	const mediaId = crypto.randomUUID();
	const fileName = `${mediaId}.${extension}`;
	const filePath = path.join(config.dir, fileName);

	await fsp.mkdir(config.dir, { recursive: true });
	await fsp.writeFile(filePath, buffer);

	return { mediaId, fileName, filePath, url: `${config.baseUrl}/${fileName}` };
}

/**
 * Map a media URL back to its local file path. Returns null for URLs outside
 * the configured base URL or not matching the store's <uuid>.<ext> shape.
 *
 * @param {string} url - Candidate media URL
 * @returns {string|null}
 */
export function mediaUrlToFilePath(url) {
	const config = getMediaStoreConfig();
	if (!config.baseUrl || typeof url !== "string" || !url.startsWith(`${config.baseUrl}/`)) {
		return null;
	}

	const fileName = url.slice(config.baseUrl.length + 1);
	if (!MEDIA_FILE_PATTERN.test(fileName)) return null;

	return path.join(config.dir, fileName);
}

/**
 * Replace input_image references whose stored media file no longer exists
 * with a text marker, so one expired historical screenshot cannot make the
 * whole model request fail. Items are copied only when a replacement is
 * needed; data URLs and foreign URLs are left untouched.
 *
 * @param {Array} items - Responses API input items
 * @returns {Array} The same array, or a copy with expired images replaced
 */
export function replaceUnavailableMediaImages(items) {
	if (!Array.isArray(items)) return items;

	let changed = false;
	const result = items.map((item) => {
		const content = item?.content;
		if (!Array.isArray(content)) return item;

		let itemChanged = false;
		const newContent = content.map((c) => {
			if (c?.type !== "input_image" || typeof c.image_url !== "string") return c;
			if (c.image_url.startsWith("data:")) return c;

			const filePath = mediaUrlToFilePath(c.image_url);
			if (!filePath || fs.existsSync(filePath)) return c;

			itemChanged = true;
			return { type: "input_text", text: EXPIRED_MEDIA_NOTE };
		});

		if (!itemChanged) return item;
		changed = true;
		return { ...item, content: newContent };
	});

	return changed ? result : items;
}

/**
 * Delete stored media files older than the retention period.
 *
 * @param {Object} [logger] - Logger instance
 * @returns {Promise<number>} Number of files deleted
 */
export async function cleanupExpiredMedia(logger) {
	const config = getMediaStoreConfig();
	const maxAgeMs = config.retentionDays * 24 * 60 * 60 * 1000;
	const now = Date.now();
	let deleted = 0;

	let entries;
	try {
		entries = await fsp.readdir(config.dir);
	} catch {
		return 0; // directory does not exist yet: nothing to clean
	}

	for (const entry of entries) {
		// Only touch files the store itself created
		if (!MEDIA_FILE_PATTERN.test(entry)) continue;

		const filePath = path.join(config.dir, entry);
		try {
			const stat = await fsp.stat(filePath);
			if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
				await fsp.unlink(filePath);
				deleted++;
			}
		} catch (e) {
			logger?.warn?.("Media cleanup failed for a file", { file: entry, err: String(e) });
		}
	}

	if (deleted > 0) {
		logger?.info?.(
			`Media store cleanup: deleted ${deleted} file(s) older than ${config.retentionDays} day(s)`
		);
	}

	return deleted;
}

/**
 * Run the age-based media cleanup now and then periodically. The timer is
 * unref'd so it never keeps the process alive.
 *
 * @param {Object} [logger] - Logger instance
 * @returns {Function} Stop function (clears the interval)
 */
export function startMediaCleanup(logger) {
	cleanupExpiredMedia(logger).catch((e) => {
		logger?.warn?.("Initial media store cleanup failed", { err: String(e) });
	});

	const timer = setInterval(() => {
		cleanupExpiredMedia(logger).catch((e) => {
			logger?.warn?.("Periodic media store cleanup failed", { err: String(e) });
		});
	}, CLEANUP_INTERVAL_MS);
	timer.unref?.();

	return () => clearInterval(timer);
}
