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
			logger?.info?.("Upload failed for Slack file", {
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

/**
 * Download a file from OpenAI (either regular or container file).
 *
 * @param {Object} outputFile - OpenAI output file object with file_id
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object|null>} Object with buffer, filename, type or null on failure
 */
async function downloadOpenAIFile(outputFile, logger) {
	const { file_id, filename, type, sandbox_path, container_id } = outputFile;

	// Handle sandbox:/ file paths (code_interpreter output)
	if (type === "sandbox_file" && sandbox_path) {
		logger?.warn?.("Sandbox file detected - cannot download sandbox:/ paths", {
			sandbox_path,
			filename,
			note: "Files must be explicitly written and saved to generate downloadable file_ids",
		});
		return null;
	}

	if (!file_id) {
		logger?.warn?.("No file_id in output file", { outputFile });
		return null;
	}

	try {
		logger?.info?.("Downloading OpenAI file", { file_id, filename, type, container_id });

		let fileContent;

		// Container files (cfile_*) need to be downloaded using container API
		if (file_id.startsWith("cfile_") && container_id) {
			logger?.info?.("Downloading container file content", { container_id, file_id });
			// Use the container-specific content endpoint: /v1/containers/{container_id}/files/{file_id}/content
			const response = await fetch(
				`https://api.openai.com/v1/containers/${container_id}/files/${file_id}/content`,
				{
					headers: {
						Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
						"OpenAI-Beta": "responses=v1",
					},
				}
			);

			if (!response.ok) {
				throw new Error(
					`Container file content download failed: ${response.status} ${response.statusText}`
				);
			}

			fileContent = response;
		} else {
			// Regular file download using OpenAI SDK
			fileContent = await openai.files.content(file_id);
		}

		// Convert to buffer
		const arrayBuffer = await fileContent.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		// Determine filename
		const finalFilename =
			filename || `${type === "image" ? "generated_image" : "generated_file"}_${file_id.slice(-8)}`;

		logger?.info?.("Downloaded OpenAI file", {
			file_id,
			filename: finalFilename,
			size: buffer.length,
		});

		return { buffer, filename: finalFilename, type, file_id };
	} catch (e) {
		logger?.error?.("Failed to download OpenAI file", {
			file_id,
			filename,
			error: String(e),
		});
		return null;
	}
}

/**
 * Download a file from OpenAI and upload it to Slack (single file).
 *
 * @param {Object} outputFile - OpenAI output file object with file_id
 * @param {Object} client - Slack client
 * @param {string} channel - Slack channel ID
 * @param {string} thread_ts - Thread timestamp
 * @param {Object} logger - Logger instance
 * @returns {Promise<Object|null>} Slack file upload result or null on failure
 */
export async function uploadOpenAIFileToSlack(outputFile, client, channel, thread_ts, logger) {
	const downloaded = await downloadOpenAIFile(outputFile, logger);
	if (!downloaded) {
		return null;
	}

	const { buffer, filename, type } = downloaded;

	try {
		logger?.info?.("Uploading to Slack", {
			filename,
			size: buffer.length,
			channel,
			thread_ts,
		});

		// Upload to Slack
		const result = await client.filesUploadV2({
			channel_id: channel,
			thread_ts,
			filename,
			file: buffer,
			initial_comment:
				type === "image" ? "Here's the generated image:" : `Here's the generated file:`,
		});

		logger?.info?.("Slack file upload successful", {
			file_id: outputFile.file_id,
			slack_file: result?.files?.[0]?.id,
		});

		return result;
	} catch (e) {
		logger?.error?.("Failed to upload OpenAI file to Slack", {
			file_id: outputFile.file_id,
			filename,
			error: String(e),
		});
		return null;
	}
}

/**
 * Process and upload all output files from a response to Slack.
 * Uploads all files in a single message instead of separate messages.
 *
 * @param {Array} outputFiles - Array of output file objects from streaming
 * @param {Object} client - Slack client
 * @param {string} channel - Slack channel ID
 * @param {string} thread_ts - Thread timestamp
 * @param {Object} logger - Logger instance
 * @returns {Promise<Array>} Array of successfully uploaded file results
 */
export async function uploadOutputFilesToSlack(outputFiles, client, channel, thread_ts, logger) {
	if (!outputFiles || outputFiles.length === 0) {
		return [];
	}

	logger?.info?.("Processing output files for Slack upload", {
		count: outputFiles.length,
		files: outputFiles.map((f) => ({ file_id: f.file_id, filename: f.filename, type: f.type })),
	});

	// Download all files first
	const downloadedFiles = [];
	for (const file of outputFiles) {
		try {
			const downloaded = await downloadOpenAIFile(file, logger);
			if (downloaded) {
				downloadedFiles.push(downloaded);
			}
		} catch (e) {
			logger?.error?.("Failed to download file", {
				file_id: file.file_id,
				error: String(e),
			});
		}
	}

	if (downloadedFiles.length === 0) {
		return [];
	}

	// Upload all files in a single Slack message
	try {
		const fileUploads = downloadedFiles.map((f) => ({
			file: f.buffer,
			filename: f.filename,
		}));

		const hasImages = downloadedFiles.some((f) => f.type === "image");
		const fileCount = downloadedFiles.length;
		const comment =
			fileCount === 1
				? hasImages
					? "Here's the generated image:"
					: "Here's the generated file:"
				: `Here are ${fileCount} generated files:`;

		logger?.info?.("Uploading files to Slack", {
			fileCount,
			filenames: downloadedFiles.map((f) => f.filename),
			channel,
			thread_ts,
		});

		const result = await client.filesUploadV2({
			channel_id: channel,
			thread_ts,
			file_uploads: fileUploads,
			initial_comment: comment,
		});

		logger?.info?.("Slack file upload successful", {
			fileCount,
			slack_files: result?.files?.map((f) => f?.id),
		});

		return [result];
	} catch (e) {
		logger?.error?.("Failed to upload files to Slack", {
			fileCount: downloadedFiles.length,
			error: String(e),
		});
		return [];
	}
}
