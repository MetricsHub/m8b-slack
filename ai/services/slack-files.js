/**
 * Slack file handling - downloading and uploading to OpenAI.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openai } from "./openai.js";

/**
 * Download a Slack file and upload to OpenAI as user_data.
 *
 * @param {Object} file - Slack file object
 * @param {Object} logger - Logger instance
 * @returns {Promise<{contentItem: Object|null, fileId: string}|null>}
 */
export async function slackFileToOpenAIContent(file, _logger) {
	const url = file.url_private_download || file.url_private;
	if (!url) return null;

	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-"));
	const fileName = file.name || `slack-file-${file.id || Date.now()}`;
	const tmpPath = path.join(tmpDir, fileName);

	const headers = {
		Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
		Accept: "*/*",
		"User-Agent": "m8b-slackbot/1.0",
	};

	// Use manual redirect to preserve Authorization across domains
	let res = await fetch(url, { headers, redirect: "manual", cache: "no-store" });

	if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
		const loc = res.headers.get("location");
		res = await fetch(loc, { headers, cache: "no-store" });
	}

	if (!res.ok) {
		throw new Error(`Slack file download failed (${res.status})`);
	}

	const contentType = res.headers.get("content-type") || "";
	if (contentType.includes("text/html")) {
		throw new Error(
			"Slack returned HTML instead of file bytes; check files:read scope and token access"
		);
	}

	const ab = await res.arrayBuffer();
	await fsp.writeFile(tmpPath, Buffer.from(ab));

	const uploaded = await openai.files.create({
		file: fs.createReadStream(tmpPath),
		purpose: "user_data",
	});

	// Cleanup temp file (async, don't wait)
	fsp.rm(tmpDir, { recursive: true }).catch(() => {});

	const mimetype = file.mimetype || "";
	const lower = (fileName || "").toLowerCase();

	if (mimetype.startsWith("image/")) {
		return {
			contentItem: { type: "input_image", detail: "auto", file_id: uploaded.id },
			fileId: uploaded.id,
		};
	}

	const isPdf = mimetype === "application/pdf" || lower.endsWith(".pdf");
	if (isPdf) {
		return {
			contentItem: { type: "input_file", file_id: uploaded.id },
			fileId: uploaded.id,
		};
	}

	// Other types are for code_interpreter only
	return { contentItem: null, fileId: uploaded.id };
}

/**
 * Creates a file upload manager for caching uploads within a conversation.
 *
 * @param {Map<string, string>} previousUploads - Map of slack_file_id -> openai_file_id
 * @param {Object} logger - Logger instance
 * @returns {Object} Upload manager with uploadOnce method and state
 */
export function createFileUploadManager(previousUploads, logger) {
	const cache = new Map(); // key -> { contentItem, fileId }
	const codeFileIds = new Set();
	const codeContainerFiles = new Map(); // openai_file_id -> filename
	const uploadedFilesThisTurn = [];

	/**
	 * Upload a file once, using cache and previous uploads.
	 *
	 * @param {Object} file - Slack file object
	 * @returns {Promise<{contentItem: Object|null, fileId: string}|null>}
	 */
	async function uploadOnce(file) {
		const key =
			file.id ||
			file.url_private_download ||
			file.url_private ||
			file.permalink ||
			`${file.name}-${file.timestamp || ""}`;

		if (cache.has(key)) {
			return cache.get(key);
		}

		try {
			// Reuse previously uploaded file id if available
			const reused = previousUploads.get(file.id);

			if (reused) {
				const mimetype = file.mimetype || "";
				const lower = (file.name || "").toLowerCase();
				let contentItem = null;

				if (mimetype.startsWith("image/")) {
					contentItem = { type: "input_image", detail: "auto", file_id: reused };
				} else if (mimetype === "application/pdf" || lower.endsWith(".pdf")) {
					contentItem = {
						type: "input_file",
						file_id: reused,
						filename: file.name,
					};
				}

				// non-image/PDF goes to code interpreter
				if (!contentItem) {
					codeFileIds.add(reused);
					codeContainerFiles.set(reused, file.name || "file");
				}

				const result = { contentItem, fileId: reused };
				cache.set(key, result);
				return result;
			}

			// Upload new file
			const result = await slackFileToOpenAIContent(file, logger);

			if (result && !result.contentItem && result.fileId) {
				codeFileIds.add(result.fileId);
				codeContainerFiles.set(result.fileId, file.name || "file");
			}

			if (result?.fileId) {
				uploadedFilesThisTurn.push({
					slack_file_id: file.id,
					openai_file_id: result.fileId,
					mimetype: file.mimetype,
					filename: file.name,
					size: file.size,
				});
			}

			cache.set(key, result);
			return result;
		} catch (err) {
			logger?.debug?.("Upload failed for Slack file", {
				name: file?.name,
				err: String(err),
			});
			return null;
		}
	}

	return {
		uploadOnce,
		codeFileIds,
		codeContainerFiles,
		uploadedFilesThisTurn,
	};
}

/**
 * Extract previous upload mappings from thread messages.
 *
 * @param {Array} messages - Array of Slack messages
 * @returns {Map<string, string>} Map of slack_file_id -> openai_file_id
 */
export function extractPreviousUploads(messages) {
	const uploads = new Map();

	for (const msg of messages) {
		const payload = msg?.metadata?.event_payload;
		if (
			msg?.metadata?.event_type === "openai_context" &&
			payload &&
			Array.isArray(payload.uploaded_files)
		) {
			for (const upload of payload.uploaded_files) {
				if (upload?.slack_file_id && upload?.openai_file_id) {
					uploads.set(upload.slack_file_id, upload.openai_file_id);
				}
			}
		}
	}

	return uploads;
}
