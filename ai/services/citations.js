/**
 * Citation post-processing for file_search annotations.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pollUntilTerminal } from "./openai.js";

/**
 * Extract citations from an OpenAI response.
 *
 * @param {Object} response - The OpenAI response
 * @returns {Map<string, string>} Map of file_id -> filename
 */
export function extractCitations(response) {
	const citationMap = new Map();

	if (!response?.output || !Array.isArray(response.output)) {
		return citationMap;
	}

	for (const item of response.output) {
		if (item?.type === "message") {
			const parts = item.content || [];
			for (const part of parts) {
				const annotations = part?.annotations || [];
				for (const ann of annotations) {
					if (ann?.type === "file_citation" && ann?.file_id) {
						citationMap.set(ann.file_id, ann.filename || ann.file_id);
					}
				}
			}
		} else if (item?.type === "output_text") {
			const annotations = item?.annotations || [];
			for (const ann of annotations) {
				if (ann?.type === "file_citation" && ann?.file_id) {
					citationMap.set(ann.file_id, ann.filename || ann.file_id);
				}
			}
		}
	}

	return citationMap;
}

/**
 * Check if text contains filecite tokens.
 *
 * @param {string} text - The text to check
 * @returns {boolean} True if filecite tokens are present
 */
export function hasFileCiteTokens(text) {
	return /\ue200filecite:[^\s]+/g.test(text);
}

/**
 * Strip filecite tokens from text.
 *
 * @param {string} text - The text to clean
 * @returns {string} Cleaned text
 */
export function stripFileCiteTokens(text) {
	return text.replace(/\ue200filecite:[^\s]+/g, "");
}

/**
 * Process and post citations to Slack.
 *
 * @param {Object} params - Processing parameters
 * @param {string} params.responseId - OpenAI response ID
 * @param {string} params.fullText - Full response text
 * @param {Map} params.streamCitationMap - Citations captured during streaming
 * @param {Array} params.vectorStoreIds - Vector store IDs to search
 * @param {string} params.channel - Slack channel ID
 * @param {string} params.thread_ts - Thread timestamp
 * @param {Object} params.client - Slack client
 * @param {Function} params.say - Say function
 * @param {Object} params.logger - Logger instance
 */
export async function processCitations({
	responseId,
	fullText,
	streamCitationMap = new Map(),
	vectorStoreIds,
	channel,
	thread_ts,
	client,
	say,
	logger,
}) {
	try {
		const final = await pollUntilTerminal(responseId);
		const citationMap = extractCitations(final);

		const originalText = fullText || "";
		const hasTokens = hasFileCiteTokens(originalText);

		if (citationMap.size === 0 && !hasTokens) {
			return;
		}

		// Merge streaming citations with final annotations
		for (const [k, v] of streamCitationMap.entries()) {
			if (!citationMap.has(k)) {
				citationMap.set(k, v);
			}
		}

		const filenames = Array.from(new Set([...citationMap.values()])).slice(0, 10);

		// Upload up to 3 cited files to Slack
		const uploadedFiles = [];
		const maxUploads = 3;
		let uploadCount = 0;

		if (!vectorStoreIds?.length) {
			logger?.info?.("No vector store IDs configured; skipping attachment fetches for citations");
		} else {
			for (const [fileId, filename] of citationMap.entries()) {
				if (uploadCount >= maxUploads) break;

				try {
					// Try each configured vector store until one returns content
					let res = null;

					for (const vsId of vectorStoreIds) {
						const url = `https://api.openai.com/v1/vector_stores/${vsId}/files/${fileId}/content`;
						const attempt = await fetch(url, {
							headers: {
								Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
								Accept: "*/*",
							},
						});

						if (attempt.ok) {
							res = attempt;
							break;
						}
					}

					if (res?.ok) {
						const contentType = res.headers.get("content-type") || "";
						const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-src-"));
						const baseSafeName = filename || `${fileId}.bin`;
						let finalName = baseSafeName;
						let fileBuffer;

						if (contentType.includes("application/json")) {
							// Vector Store content often returns JSON with data[] chunks
							try {
								const json = await res.json();
								const parts = [];
								const data = Array.isArray(json?.data) ? json.data : [];

								for (const d of data) {
									if (typeof d?.text === "string") parts.push(d.text);
									else if (typeof d?.value === "string") parts.push(d.value);
								}

								const text = parts.join("\n\n").trim();
								fileBuffer = Buffer.from(text || "", "utf8");

								// Prefer a readable text extension
								const lower = (baseSafeName || "").toLowerCase();
								const hasKnownExt = /\.(md|markdown|txt|pdf|csv|json|yaml|yml)$/i.test(lower);
								if (!hasKnownExt) {
									finalName = `${path.parse(baseSafeName).name || fileId}.md`;
								}
							} catch {
								const ab = await res.arrayBuffer();
								fileBuffer = Buffer.from(ab);
							}
						} else {
							const ab = await res.arrayBuffer();
							fileBuffer = Buffer.from(ab);
						}

						const tmpPath = path.join(tmpDir, finalName);
						await fsp.writeFile(tmpPath, fileBuffer);

						const upload = await client.files.uploadV2({
							channel_id: channel,
							thread_ts: thread_ts,
							file: fs.createReadStream(tmpPath),
							filename: finalName,
							title: finalName,
						});

						if (upload?.ok) {
							uploadedFiles.push(finalName);
							uploadCount += 1;
						}

						// Cleanup
						fsp.rm(tmpDir, { recursive: true }).catch(() => {});
					} else {
						logger?.info?.("Vector store file content fetch failed", {
							fileId,
							vectorStoreIds,
						});
					}
				} catch (e) {
					logger?.info?.("Failed to fetch/upload cited file", {
						fileId,
						e: String(e),
					});
				}
			}
		}

		// Post sources line
		if (filenames.length) {
			await say?.({ text: `Sources: ${filenames.join(", ")}` });
		}
	} catch (e) {
		logger?.info?.("Citation post-processing skipped/failed", { e: String(e) });
	}
}
