/**
 * Slack file handling - downloading and uploading to OpenAI.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCodeSandboxConfig } from "../config/providers.js";
import { sanitizeSandboxFileName } from "./code-sandbox.js";
import {
	getMediaStoreConfig,
	isMediaStoreConfigured,
	saveMedia,
	supportedImageExtension,
} from "./media-store.js";
import { openai } from "./openai.js";

/**
 * Build a Responses API content item for a Slack image or PDF.
 * GPT-5.6 treats image `auto` detail as original-size input, so use explicit high
 * detail for predictable technical screenshot and document analysis costs.
 *
 * @param {Object} params
 * @param {string} params.fileId - OpenAI file ID
 * @param {string} params.fileName - Original filename
 * @param {string} params.mimetype - MIME type
 * @returns {Object|null} Responses API input content item
 */
export function buildOpenAIFileContentItem({ fileId, fileName, mimetype }) {
	if (mimetype.startsWith("image/")) {
		return { type: "input_image", detail: "high", file_id: fileId };
	}

	if (mimetype === "application/pdf" || fileName.toLowerCase().endsWith(".pdf")) {
		return {
			type: "input_file",
			detail: "high",
			file_id: fileId,
			filename: fileName,
		};
	}

	return null;
}

/**
 * Download a Slack file's bytes using the bot token.
 *
 * @param {Object} file - Slack file object
 * @returns {Promise<{buffer: Buffer, fileName: string, mimetype: string}|null>}
 */
export async function downloadSlackFile(file) {
	const url = file.url_private_download || file.url_private;
	if (!url) return null;

	const fileName = file.name || `slack-file-${file.id || Date.now()}`;

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
	return { buffer: Buffer.from(ab), fileName, mimetype: file.mimetype || "" };
}

/**
 * Download a Slack file and upload to OpenAI as user_data.
 *
 * @param {Object} file - Slack file object
 * @param {Object} _logger - Logger instance
 * @returns {Promise<{contentItem: Object|null, fileId: string}|null>}
 */
export async function slackFileToOpenAIContent(file, _logger) {
	const downloaded = await downloadSlackFile(file);
	if (!downloaded) return null;

	const { buffer, fileName } = downloaded;
	const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-"));
	const tmpPath = path.join(tmpDir, fileName);
	await fsp.writeFile(tmpPath, buffer);

	const uploaded = await openai.files.create({
		file: fs.createReadStream(tmpPath),
		purpose: "user_data",
	});

	// Cleanup temp file (async, don't wait)
	fsp.rm(tmpDir, { recursive: true }).catch(() => {});

	const contentItem = buildOpenAIFileContentItem({
		fileId: uploaded.id,
		fileName,
		mimetype: file.mimetype || "",
	});

	if (contentItem) return { contentItem, fileId: uploaded.id };

	// Other types are for code_interpreter only
	return { contentItem: null, fileId: uploaded.id };
}

/**
 * Stable per-conversation cache key for a Slack file object.
 *
 * @param {Object} file - Slack file object
 * @returns {string}
 */
function fileCacheKey(file) {
	return (
		file.id ||
		file.url_private_download ||
		file.url_private ||
		file.permalink ||
		`${file.name}-${file.timestamp || ""}`
	);
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
		const key = fileCacheKey(file);

		if (cache.has(key)) {
			return cache.get(key);
		}

		try {
			// Reuse previously uploaded file id if available
			const reused = previousUploads.get(file.id);

			if (reused) {
				const contentItem = buildOpenAIFileContentItem({
					fileId: reused,
					fileName: file.name || "file",
					mimetype: file.mimetype || "",
				});

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
		sandboxFiles: new Map(),
	};
}

/**
 * Create a helper that downloads non-image Slack attachments and stages their
 * bytes into the local Python sandbox staging map, making them readable with
 * run_python at /data/<name>. Results are cached per Slack file, so staging
 * the same attachment from the thread loop and again from the current-message
 * path downloads it only once per turn.
 *
 * @param {Object} params
 * @param {Map<string, (Buffer|string)>} params.sandboxFiles - Per-turn staging map
 * @param {number} params.maxBytes - Per-attachment size cap
 * @param {Object} [params.logger] - Logger instance
 * @returns {Function} async (file) => {ok, name?, bytes?, reason?}
 */
function createAttachmentStager({ sandboxFiles, maxBytes, logger }) {
	const staged = new Map(); // fileCacheKey -> result

	return async function stage(file) {
		const key = fileCacheKey(file);
		if (staged.has(key)) {
			return staged.get(key);
		}

		let result;
		const declaredSize = Number(file.size) || 0;
		if (declaredSize > maxBytes) {
			result = { ok: false, reason: `file is too large (${declaredSize} bytes, cap ${maxBytes})` };
		} else {
			try {
				const downloaded = await downloadSlackFile(file);
				if (!downloaded) throw new Error("file has no downloadable URL");
				if (downloaded.buffer.length > maxBytes) {
					throw new Error(`file is too large (${downloaded.buffer.length} bytes, cap ${maxBytes})`);
				}

				// Resolve staged-name collisions between distinct attachments
				let name = sanitizeSandboxFileName(downloaded.fileName);
				if (sandboxFiles.has(name)) {
					const dot = name.lastIndexOf(".");
					const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
					let suffix = 2;
					while (sandboxFiles.has(`${base}-${suffix}${ext}`)) suffix += 1;
					name = `${base}-${suffix}${ext}`;
				}

				sandboxFiles.set(name, downloaded.buffer);
				result = { ok: true, name, bytes: downloaded.buffer.length };
				logger?.info?.("Staged Slack attachment for the Python sandbox", {
					name,
					bytes: downloaded.buffer.length,
				});
			} catch (err) {
				logger?.warn?.("Failed to stage Slack attachment for the Python sandbox", {
					name: file?.name,
					err: String(err),
				});
				result = { ok: false, reason: String(err?.message || err) };
			}
		}

		staged.set(key, result);
		return result;
	};
}

/**
 * Text note describing a staged (or unstageable) data attachment.
 */
function stagedAttachmentNote(file, stagedResult) {
	const label = `"${file.name || "unknown"}" (${file.mimetype || "unknown type"})`;
	return stagedResult.ok
		? `[Attached file ${label}, ${stagedResult.bytes} bytes — staged for the run_python tool; read it from /data/${stagedResult.name} with Python code.]`
		: `[Attached file ${label} could not be staged for analysis (${stagedResult.reason}). Tell the user you could not read it.]`;
}

/**
 * Create a file upload manager for providers without a Files API (Ollama
 * mode without a vision model). Exposes the same interface as
 * createFileUploadManager but never uploads anything.
 *
 * With stageAttachments (localCodeInterpreter providers), non-image
 * attachments are downloaded and staged into the Python sandbox, and
 * uploadOnce returns a text note pointing the model at /data/<name>; images
 * degrade to a cannot-analyze note. Without it, the manager is fully disabled
 * and the caller surfaces attachments as unsupported.
 *
 * @param {Object} [logger] - Logger instance
 * @param {Object} [options]
 * @param {boolean} [options.stageAttachments] - Stage data files for run_python
 * @returns {Object} Upload manager with uploadOnce (and stageAttachment) methods
 */
export function createNoopFileUploadManager(logger, { stageAttachments = false } = {}) {
	const sandboxFiles = new Map();

	if (!stageAttachments) {
		let warned = false;
		return {
			disabled: true,
			codeFileIds: new Set(),
			codeContainerFiles: new Map(),
			uploadedFilesThisTurn: [],
			sandboxFiles,
			async uploadOnce(file) {
				if (!warned) {
					warned = true;
					logger?.info?.("File uploads are disabled for this AI provider; skipping attachments", {
						firstFile: file?.name,
					});
				}
				return null;
			},
		};
	}

	const cache = new Map(); // key -> { contentItem, fileId }
	const stage = createAttachmentStager({
		sandboxFiles,
		maxBytes: getCodeSandboxConfig().maxInputFileBytes,
		logger,
	});

	async function uploadOnce(file) {
		const key = fileCacheKey(file);
		if (cache.has(key)) {
			return cache.get(key);
		}

		let text;
		if (String(file.mimetype || "").startsWith("image/")) {
			text = `[Image "${file.name || "unknown"}" attached by the user cannot be analyzed on the local AI backend (no vision model configured). Tell the user you cannot look at images.]`;
		} else {
			text = stagedAttachmentNote(file, await stage(file));
		}

		const result = { contentItem: { type: "input_text", text }, fileId: null };
		cache.set(key, result);
		return result;
	}

	return {
		uploadOnce,
		stageAttachment: (file) =>
			String(file?.mimetype || "").startsWith("image/") ? Promise.resolve(null) : stage(file),
		codeFileIds: new Set(),
		codeContainerFiles: new Map(),
		uploadedFilesThisTurn: [],
		sandboxFiles,
	};
}

/**
 * Create a file "upload" manager that turns image attachments into text
 * descriptions using a local vision model (Ollama mode with OLLAMA_VISION_MODEL).
 *
 * Exposes the same interface as createFileUploadManager, but instead of
 * uploading, uploadOnce returns an input_text content item carrying the vision
 * model's description of the image. Descriptions end up embedded in the stored
 * conversation input, so each image is described once per store lifetime.
 *
 * Non-image files are staged into the Python sandbox when stageAttachments is
 * set (localCodeInterpreter providers) — the note points the model at
 * /data/<name> — and degrade to an unsupported-type note otherwise.
 *
 * @param {Object} params
 * @param {Function} params.describeImage - Provider hook: async ({buffer, mimetype, fileName, contextText}) => string
 * @param {string} [params.contextText] - Short conversation-context snippet for the vision prompt
 * @param {boolean} [params.stageAttachments] - Stage data files for run_python
 * @param {Object} [params.logger] - Logger instance
 * @returns {Object} Upload manager with uploadOnce (and stageAttachment) methods
 */
export function createDescribingFileUploadManager({
	describeImage,
	contextText,
	stageAttachments = false,
	logger,
}) {
	const cache = new Map(); // key -> { contentItem, fileId }
	const sandboxFiles = new Map();
	const stage = stageAttachments
		? createAttachmentStager({
				sandboxFiles,
				maxBytes: getCodeSandboxConfig().maxInputFileBytes,
				logger,
			})
		: null;

	function note(text) {
		return { contentItem: { type: "input_text", text }, fileId: null };
	}

	async function uploadOnce(file) {
		const key = fileCacheKey(file);
		if (cache.has(key)) {
			return cache.get(key);
		}

		const fileName = file.name || "unknown";
		let result;

		if (!String(file.mimetype || "").startsWith("image/")) {
			result = stage
				? note(stagedAttachmentNote(file, await stage(file)))
				: note(
						`[Attached file "${fileName}" (${file.mimetype || "unknown type"}) — only images can be analyzed on the local AI backend.]`
					);
		} else {
			try {
				const downloaded = await downloadSlackFile(file);
				if (!downloaded) throw new Error("file has no downloadable URL");

				const description = await describeImage({
					buffer: downloaded.buffer,
					mimetype: downloaded.mimetype || "image/png",
					fileName,
					contextText,
				});

				result = note(
					`[Image "${fileName}" attached by the user. It cannot be shown to you directly; a vision model described it as follows:]\n${description}`
				);
				logger?.info?.("Described image attachment with the vision model", {
					name: fileName,
					descriptionChars: description.length,
				});
			} catch (err) {
				logger?.warn?.("Vision description failed for Slack image", {
					name: fileName,
					err: String(err),
				});
				result = note(
					`[Image "${fileName}" attached by the user could not be analyzed (vision backend error). Tell the user you could not look at it.]`
				);
			}
		}

		cache.set(key, result);
		return result;
	}

	return {
		uploadOnce,
		stageAttachment: stage
			? (file) =>
					String(file?.mimetype || "").startsWith("image/") ? Promise.resolve(null) : stage(file)
			: undefined,
		codeFileIds: new Set(),
		codeContainerFiles: new Map(),
		uploadedFilesThisTurn: [],
		sandboxFiles,
	};
}

/**
 * Create a file "upload" manager for native-vision providers (vLLM): image
 * attachments become input_image content items the model reads directly.
 *
 * The image bytes are downloaded from Slack once (with Slack credentials) and
 * saved into the local media store; the content item then carries only the
 * short internal media URL, which the inference host fetches itself — Slack
 * URLs (which require a Bearer token) are never sent to the backend, and the
 * conversation history stays small when it is resent every turn. Without a
 * configured media store (M8B_MEDIA_BASE_URL unset) the item degrades to an
 * inline base64 data URL, which works but bloats every subsequent request.
 *
 * Content items end up embedded in the stored conversation input, so each
 * image is downloaded and saved once per store lifetime. Non-image files are
 * staged into the Python sandbox when stageAttachments is set
 * (localCodeInterpreter providers) and degrade to an unsupported-type note
 * otherwise.
 *
 * @param {Object} params
 * @param {boolean} [params.stageAttachments] - Stage data files for run_python
 * @param {Object} [params.logger] - Logger instance
 * @returns {Object} Upload manager with uploadOnce (and stageAttachment) methods
 */
export function createNativeImageFileUploadManager({ stageAttachments = false, logger } = {}) {
	const cache = new Map(); // key -> { contentItem, fileId }
	const sandboxFiles = new Map();
	const stage = stageAttachments
		? createAttachmentStager({
				sandboxFiles,
				maxBytes: getCodeSandboxConfig().maxInputFileBytes,
				logger,
			})
		: null;
	let warnedBase64Fallback = false;

	function note(text) {
		return { contentItem: { type: "input_text", text }, fileId: null };
	}

	async function uploadOnce(file) {
		const key = fileCacheKey(file);
		if (cache.has(key)) {
			return cache.get(key);
		}

		const fileName = file.name || "unknown";
		const mimetype = String(file.mimetype || "");
		let result;

		if (!mimetype.startsWith("image/")) {
			result = stage
				? note(stagedAttachmentNote(file, await stage(file)))
				: note(
						`[Attached file "${fileName}" (${mimetype || "unknown type"}) — only images can be analyzed on the local AI backend.]`
					);
		} else if (!supportedImageExtension(mimetype)) {
			result = note(
				`[Image "${fileName}" attached by the user uses an unsupported format (${mimetype}). Tell the user you can only look at PNG, JPEG, GIF, or WebP images.]`
			);
		} else {
			try {
				const downloaded = await downloadSlackFile(file);
				if (!downloaded) throw new Error("file has no downloadable URL");

				const { maxFileBytes } = getMediaStoreConfig();
				if (downloaded.buffer.length > maxFileBytes) {
					throw new Error(
						`image is too large (${downloaded.buffer.length} bytes, cap ${maxFileBytes})`
					);
				}

				let imageUrl;
				if (isMediaStoreConfigured()) {
					const saved = await saveMedia({ buffer: downloaded.buffer, mimetype });
					imageUrl = saved.url;
					logger?.info?.("Saved image attachment to the media store", {
						name: fileName,
						mediaId: saved.mediaId,
						bytes: downloaded.buffer.length,
					});
				} else {
					if (!warnedBase64Fallback) {
						warnedBase64Fallback = true;
						logger?.warn?.(
							"M8B_MEDIA_BASE_URL is not set: embedding image as base64 (heavy on resent history)",
							{ name: fileName }
						);
					}
					imageUrl = `data:${mimetype};base64,${downloaded.buffer.toString("base64")}`;
				}

				// vLLM's input_image schema requires the detail field
				result = {
					contentItem: { type: "input_image", detail: "auto", image_url: imageUrl },
					fileId: null,
				};
			} catch (err) {
				logger?.warn?.("Failed to prepare Slack image for native vision", {
					name: fileName,
					err: String(err),
				});
				result = note(
					`[Image "${fileName}" attached by the user could not be processed (${err?.message || err}). Tell the user you could not look at it.]`
				);
			}
		}

		cache.set(key, result);
		return result;
	}

	return {
		uploadOnce,
		stageAttachment: stage
			? (file) =>
					String(file?.mimetype || "").startsWith("image/") ? Promise.resolve(null) : stage(file)
			: undefined,
		codeFileIds: new Set(),
		codeContainerFiles: new Map(),
		uploadedFilesThisTurn: [],
		sandboxFiles,
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

		// filesUploadV2 returns { files: [{ ok, files: [...] }] } structure
		const slackFileId = result?.files?.[0]?.files?.[0]?.id || result?.files?.[0]?.id;
		logger?.info?.("Slack file upload successful", {
			file_id: outputFile.file_id,
			slack_file_id: slackFileId,
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
 * Upload locally generated files (Python sandbox output) to Slack in a single
 * message. Unlike uploadOutputFilesToSlack, the bytes are already in memory —
 * nothing is downloaded from OpenAI.
 *
 * @param {Array<{name: string, buffer: Buffer}>} files - Generated files
 * @param {Object} client - Slack client
 * @param {string} channel - Slack channel ID
 * @param {string} thread_ts - Thread timestamp
 * @param {Object} logger - Logger instance
 * @returns {Promise<boolean>} True when the upload succeeded
 */
export async function uploadGeneratedFilesToSlack(files, client, channel, thread_ts, logger) {
	if (!files || files.length === 0) {
		return false;
	}

	try {
		logger?.info?.("Uploading sandbox-generated files to Slack", {
			fileCount: files.length,
			filenames: files.map((f) => f.name),
			channel,
			thread_ts,
		});

		const result = await client.filesUploadV2({
			channel_id: channel,
			thread_ts,
			file_uploads: files.map((f) => ({ file: f.buffer, filename: f.name })),
			initial_comment:
				files.length === 1
					? "Here's the generated file:"
					: `Here are ${files.length} generated files:`,
		});

		const uploadedIds = result?.files?.flatMap((f) => f?.files?.map((sf) => sf?.id) || []) || [];
		logger?.info?.("Slack upload of generated files successful", {
			fileCount: files.length,
			slack_file_ids: uploadedIds,
		});
		return true;
	} catch (e) {
		logger?.error?.("Failed to upload generated files to Slack", {
			fileCount: files.length,
			error: String(e),
		});
		return false;
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

		// filesUploadV2 returns { files: [{ ok, files: [...] }] } structure
		const uploadedIds = result?.files?.flatMap((f) => f?.files?.map((sf) => sf?.id) || []) || [];
		logger?.info?.("Slack file upload successful", {
			fileCount,
			slack_file_ids: uploadedIds,
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
