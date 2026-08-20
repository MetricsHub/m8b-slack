/* biome-ignore-all lint/suspicious/noConsole: CLI script */
/**
 * Export the knowledge base documents from OpenAI vector stores to local
 * markdown files, so the local (Ollama) knowledge base can be built from them.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... OPENAI_VECTOR_STORE_IDS=vs_... node scripts/export-openai-knowledge.js
 *
 * Documents are written to <KNOWLEDGE_BASE_DIR>/docs/ (default: data/knowledge/docs/).
 * Run `npm run kb:index` afterwards to build the local embedding index.
 */

import "dotenv/config";
import fsp from "node:fs/promises";
import path from "node:path";
import { getKnowledgeBaseDir } from "../ai/services/knowledge-base.js";
import { getVectorStoreIds } from "../ai/services/openai.js";

const OPENAI_BASE = "https://api.openai.com/v1";

async function openaiGet(url) {
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
			Accept: "*/*",
		},
	});
	if (!response.ok) {
		throw new Error(`GET ${url} failed: HTTP ${response.status} ${await response.text()}`);
	}
	return response;
}

async function listVectorStoreFiles(vectorStoreId) {
	const files = [];
	let after = null;

	do {
		const url = new URL(`${OPENAI_BASE}/vector_stores/${vectorStoreId}/files`);
		url.searchParams.set("limit", "100");
		if (after) url.searchParams.set("after", after);

		const body = await (await openaiGet(url.toString())).json();
		files.push(...(body?.data || []));
		after = body?.has_more ? body.last_id : null;
	} while (after);

	return files;
}

async function getFilename(fileId) {
	try {
		const body = await (await openaiGet(`${OPENAI_BASE}/files/${fileId}`)).json();
		return body?.filename || `${fileId}.md`;
	} catch {
		return `${fileId}.md`;
	}
}

async function getFileText(vectorStoreId, fileId) {
	const response = await openaiGet(
		`${OPENAI_BASE}/vector_stores/${vectorStoreId}/files/${fileId}/content`
	);
	const contentType = response.headers.get("content-type") || "";

	if (contentType.includes("application/json")) {
		const json = await response.json();
		const parts = [];
		for (const d of Array.isArray(json?.data) ? json.data : []) {
			if (typeof d?.text === "string") parts.push(d.text);
			else if (typeof d?.value === "string") parts.push(d.value);
		}
		return parts.join("\n\n").trim();
	}

	return (await response.text()).trim();
}

function sanitizeFilename(name) {
	const base = name.replace(/\.[^.]+$/, "");
	const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
	return `${safe || "document"}.md`;
}

async function main() {
	if (!process.env.OPENAI_API_KEY) {
		console.error("OPENAI_API_KEY is required to export from OpenAI vector stores.");
		process.exit(1);
	}

	const vectorStoreIds = getVectorStoreIds();
	if (vectorStoreIds.length === 0) {
		console.error(
			"No vector stores configured. Set OPENAI_VECTOR_STORE_IDS or OPENAI_VECTOR_STORE_ID."
		);
		process.exit(1);
	}

	const docsDir = path.join(getKnowledgeBaseDir(), "docs");
	await fsp.mkdir(docsDir, { recursive: true });

	let exported = 0;
	let failed = 0;

	for (const vectorStoreId of vectorStoreIds) {
		console.log(`Listing files in vector store ${vectorStoreId}...`);
		const files = await listVectorStoreFiles(vectorStoreId);
		console.log(`Found ${files.length} file(s).`);

		for (const file of files) {
			const fileId = file?.id;
			if (!fileId) continue;

			try {
				const filename = sanitizeFilename(await getFilename(fileId));
				const text = await getFileText(vectorStoreId, fileId);

				if (!text) {
					console.warn(`  SKIP ${fileId}: empty content`);
					failed++;
					continue;
				}

				const target = path.join(docsDir, filename);
				await fsp.writeFile(target, text, "utf8");
				console.log(`  OK ${fileId} -> ${target} (${text.length} chars)`);
				exported++;
			} catch (e) {
				console.error(`  FAIL ${fileId}: ${e.message}`);
				failed++;
			}
		}
	}

	console.log(`\nExported ${exported} document(s), ${failed} failed.`);
	console.log("Next step: npm run kb:index");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
