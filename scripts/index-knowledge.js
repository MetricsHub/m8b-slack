/* biome-ignore-all lint/suspicious/noConsole: CLI script */
/**
 * Build (or rebuild) the local knowledge base embedding index from the markdown
 * documents in <KNOWLEDGE_BASE_DIR>/docs/.
 *
 * Requires a running Ollama server with the configured embedding model pulled:
 *   ollama pull nomic-embed-text   (or whatever OLLAMA_EMBEDDING_MODEL is set to)
 *
 * Usage:
 *   node scripts/index-knowledge.js                 # full rebuild
 *   node scripts/index-knowledge.js file1.md ...    # incremental: only these docs
 *
 * Documents the bot writes itself (update_knowledge) are indexed incrementally
 * at write time and do NOT require running this script.
 */

import "dotenv/config";
import { getOllamaConfig } from "../ai/config/providers.js";
import { createLocalKnowledgeBase } from "../ai/services/knowledge-base.js";

async function main() {
	const { baseUrl, embeddingModel } = getOllamaConfig();
	console.log(`Embedding endpoint: ${baseUrl}/embeddings`);
	console.log(`Embedding model:    ${embeddingModel}`);

	const kb = createLocalKnowledgeBase({ logger: console });
	console.log(`Documents dir:      ${kb.docsDir}`);
	console.log(`Index file:         ${kb.indexPath}\n`);

	const files = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));

	if (files.length > 0) {
		// Incremental: re-index only the given documents
		let failed = 0;
		for (const file of files) {
			const result = await kb.indexFile(file);
			if (result.ok) {
				console.log(`OK   ${file} (${result.chunks} chunks)`);
			} else {
				console.error(`FAIL ${file}: ${result.error}`);
				failed++;
			}
		}
		if (failed > 0) process.exit(1);
		console.log(`\nRe-indexed ${files.length - failed} document(s) incrementally.`);
		return;
	}

	const result = await kb.reindex();

	if (!result.ok) {
		console.error(`Indexing failed: ${result.error}`);
		process.exit(1);
	}

	console.log(`\nIndexed ${result.documents} document(s) into ${result.chunks} chunk(s).`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
