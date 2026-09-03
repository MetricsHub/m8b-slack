/**
 * Tests for the local knowledge base (Ollama-mode RAG).
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
	chunkDocument,
	cosineSimilarity,
	createLocalKnowledgeBase,
	getEmbeddingPrefixes,
	SEARCH_KNOWLEDGE_TOOL,
} from "../knowledge-base.js";

describe("getEmbeddingPrefixes", () => {
	const savedQuery = process.env.OLLAMA_EMBEDDING_QUERY_PREFIX;
	const savedDocument = process.env.OLLAMA_EMBEDDING_DOCUMENT_PREFIX;

	afterEach(() => {
		if (savedQuery === undefined) delete process.env.OLLAMA_EMBEDDING_QUERY_PREFIX;
		else process.env.OLLAMA_EMBEDDING_QUERY_PREFIX = savedQuery;
		if (savedDocument === undefined) delete process.env.OLLAMA_EMBEDDING_DOCUMENT_PREFIX;
		else process.env.OLLAMA_EMBEDDING_DOCUMENT_PREFIX = savedDocument;
	});

	it("applies nomic-embed-text task prefixes", () => {
		expect(getEmbeddingPrefixes("nomic-embed-text")).toEqual({
			query: "search_query: ",
			document: "search_document: ",
		});
	});

	it("applies the mxbai query instruction", () => {
		const prefixes = getEmbeddingPrefixes("mxbai-embed-large");
		expect(prefixes.query).toContain("Represent this sentence");
		expect(prefixes.document).toBe("");
	});

	it("uses no prefixes for models that do not need them", () => {
		expect(getEmbeddingPrefixes("bge-m3")).toEqual({ query: "", document: "" });
	});

	it("honors environment overrides", () => {
		process.env.OLLAMA_EMBEDDING_QUERY_PREFIX = "query: ";
		process.env.OLLAMA_EMBEDDING_DOCUMENT_PREFIX = "passage: ";
		expect(getEmbeddingPrefixes("nomic-embed-text")).toEqual({
			query: "query: ",
			document: "passage: ",
		});
	});
});

describe("chunkDocument", () => {
	it("returns nothing for empty input", () => {
		expect(chunkDocument("")).toEqual([]);
		expect(chunkDocument(null)).toEqual([]);
	});

	it("keeps small documents as a single chunk", () => {
		const chunks = chunkDocument("# Title\n\nShort content.");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].section).toBe("Title");
	});

	it("splits sections on markdown headings and windows long sections", () => {
		const doc = [
			"# Main title",
			"Intro paragraph.",
			"## Section A",
			"a".repeat(3000),
			"## Section B",
			"Short section.",
		].join("\n");

		const chunks = chunkDocument(doc, { chunkSize: 1200, overlap: 200 });

		const sections = new Set(chunks.map((c) => c.section));
		expect(sections).toContain("Main title");
		expect(sections).toContain("Section A");
		expect(sections).toContain("Section B");

		// Long section produced multiple chunks
		const sectionAChunks = chunks.filter((c) => c.section === "Section A");
		expect(sectionAChunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(1200);
		}
	});
});

describe("cosineSimilarity", () => {
	it("computes expected values", () => {
		expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
		expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
		expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
	});

	it("returns 0 for degenerate inputs", () => {
		expect(cosineSimilarity([], [])).toBe(0);
		expect(cosineSimilarity([1], [1, 2])).toBe(0);
		expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
	});
});

describe("local knowledge base", () => {
	let dir;
	const savedFetch = global.fetch;
	const savedEmbeddingModel = process.env.OLLAMA_EMBEDDING_MODEL;
	const savedProvider = process.env.AI_PROVIDER;

	/**
	 * Deterministic fake embeddings: axis 0 = docker, axis 1 = prometheus, axis 2 = other.
	 */
	function fakeEmbedding(text) {
		const lower = text.toLowerCase();
		if (lower.includes("docker")) return [1, 0, 0];
		if (lower.includes("prometheus")) return [0, 1, 0];
		return [0, 0, 1];
	}

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "m8b-kb-test-"));
		// The embedding backend is resolved from the active provider
		process.env.AI_PROVIDER = "ollama";
		process.env.OLLAMA_EMBEDDING_MODEL = "test-embed";

		global.fetch = jest.fn(async (_url, init) => {
			const body = JSON.parse(init.body);
			const inputs = Array.isArray(body.input) ? body.input : [body.input];
			return {
				ok: true,
				json: async () => ({ data: inputs.map((text) => ({ embedding: fakeEmbedding(text) })) }),
			};
		});
	});

	afterEach(async () => {
		global.fetch = savedFetch;
		if (savedProvider === undefined) delete process.env.AI_PROVIDER;
		else process.env.AI_PROVIDER = savedProvider;
		if (savedEmbeddingModel === undefined) delete process.env.OLLAMA_EMBEDDING_MODEL;
		else process.env.OLLAMA_EMBEDDING_MODEL = savedEmbeddingModel;
		await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	it("is unavailable before any document is indexed", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		expect(await kb.isAvailable()).toBe(false);

		const result = await kb.search("docker");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("kb:index");
	});

	it("indexes documents and retrieves the relevant chunk", async () => {
		const kb = createLocalKnowledgeBase({ dir });

		await kb.addDocument({
			title: "Fix Docker memory leak",
			content: "Restart the docker daemon and set memory limits.",
		});
		await kb.addDocument({
			title: "Prometheus alerting rules",
			content: "Edit prometheus.yml and reload the prometheus config.",
		});

		expect(await kb.isAvailable()).toBe(true);

		const result = await kb.search("docker keeps eating RAM", 1);
		expect(result.ok).toBe(true);
		expect(result.results).toHaveLength(1);
		expect(result.results[0].title).toBe("Fix Docker memory leak");
		expect(result.results[0].source).toMatch(/^docs\/.+\.md$/);
		expect(result.results[0].excerpt).toContain("docker");
		expect(result.results[0].score).toBeGreaterThan(0.9);
	});

	it("returns the docId needed to update an article", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		const added = await kb.addDocument({ title: "Docker tip", content: "docker things" });

		const result = await kb.search("docker", 1);
		expect(result.ok).toBe(true);
		expect(result.results[0].docId).toBe(added.docId);
	});

	it("replaces an article without duplicates, orphaned files, or reindex resurrection", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		const original = await kb.addDocument({
			title: "Docker fix",
			content: "docker daemon restart, old advice",
		});

		const updated = await kb.addDocument({
			title: "Docker fix (revised)",
			content: "docker daemon restart, new advice",
			replaceDocId: original.docId,
		});
		expect(updated.ok).toBe(true);

		// Only the new version is retrievable
		const result = await kb.search("docker", 5);
		const dockerTitles = result.results.map((r) => r.title);
		expect(dockerTitles).toContain("Docker fix (revised)");
		expect(dockerTitles).not.toContain("Docker fix");

		// The superseded markdown file is gone from docs/
		const files = await fsp.readdir(path.join(dir, "docs"));
		expect(files).toHaveLength(1);
		expect(files[0]).toBe(updated.file);

		// A full reindex from docs/ must not resurrect the replaced article
		const freshKb = createLocalKnowledgeBase({ dir });
		const rebuilt = await freshKb.reindex();
		expect(rebuilt.ok).toBe(true);
		expect(rebuilt.documents).toBe(1);
		const after = await freshKb.search("docker", 5);
		expect(after.results.map((r) => r.title)).not.toContain("Docker fix");
	});

	it("persists documents as markdown files and rebuilds via reindex", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		await kb.addDocument({ title: "Docker note", content: "docker things" });

		const files = await fsp.readdir(path.join(dir, "docs"));
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^docker-note-.*\.md$/);

		// Wipe the index, rebuild it from docs/
		await fsp.rm(path.join(dir, "index.json"));
		const freshKb = createLocalKnowledgeBase({ dir });
		expect(await freshKb.isAvailable()).toBe(false);

		const result = await freshKb.reindex();
		expect(result.ok).toBe(true);
		expect(result.documents).toBe(1);
		expect(await freshKb.isAvailable()).toBe(true);
	});

	it("fails gracefully when the embedding service is unavailable", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		await kb.addDocument({ title: "Docker note", content: "docker things" });

		global.fetch = jest.fn(async () => {
			throw new Error("connect ECONNREFUSED");
		});

		const result = await kb.search("docker");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unavailable");
	});

	it("rejects searching with a mismatched embedding model", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		await kb.addDocument({ title: "Docker note", content: "docker things" });

		process.env.OLLAMA_EMBEDDING_MODEL = "different-model";
		const freshKb = createLocalKnowledgeBase({ dir });
		const result = await freshKb.search("docker");

		expect(result.ok).toBe(false);
		expect(result.error).toContain("kb:index");
	});

	it("makes bot-written knowledge searchable immediately without a full reindex", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		await kb.addDocument({ title: "Prometheus tip", content: "prometheus reload trick" });

		// A second write only embeds the new document, not the whole corpus
		global.fetch.mockClear();
		await kb.addDocument({ title: "Docker tip", content: "docker restart trick" });
		expect(global.fetch).toHaveBeenCalledTimes(1);

		// Both documents are searchable right away
		const result = await createLocalKnowledgeBase({ dir }).search("docker", 1);
		expect(result.ok).toBe(true);
		expect(result.results[0].title).toBe("Docker tip");
	});

	it("refuses bot writes when the index was built with a different embedding model", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		await kb.addDocument({ title: "Docker tip", content: "docker things" });

		process.env.OLLAMA_EMBEDDING_MODEL = "different-model";
		const result = await createLocalKnowledgeBase({ dir }).addDocument({
			title: "Should fail",
			content: "prometheus things",
		});

		expect(result.ok).toBe(false);
		expect(result.error).toContain("kb:index");
		// The rejected write must not have appended mixed vectors
		process.env.OLLAMA_EMBEDDING_MODEL = "test-embed";
		const search = await createLocalKnowledgeBase({ dir }).search("prometheus", 1);
		expect(search.ok).toBe(true);
		expect(search.results[0].title).not.toBe("Should fail");
	});

	it("re-indexes a single document incrementally with indexFile", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		await kb.addDocument({ title: "Docker tip", content: "docker things" });
		await kb.addDocument({ title: "Prometheus tip", content: "prometheus things" });

		// Manually edit the docker doc on disk (as a human curator would)
		const files = await fsp.readdir(path.join(dir, "docs"));
		const dockerFile = files.find((f) => f.startsWith("docker-tip"));
		await fsp.writeFile(
			path.join(dir, "docs", dockerFile),
			"# Docker tip (updated)\n\nnew docker guidance",
			"utf8"
		);

		global.fetch.mockClear();
		const result = await createLocalKnowledgeBase({ dir }).indexFile(dockerFile);
		expect(result.ok).toBe(true);
		// Only the edited document was embedded
		expect(global.fetch).toHaveBeenCalledTimes(1);

		const search = await createLocalKnowledgeBase({ dir }).search("docker", 1);
		expect(search.results[0].title).toBe("Docker tip (updated)");
		expect(search.results[0].excerpt).toContain("new docker guidance");

		// The untouched document is still indexed
		const other = await createLocalKnowledgeBase({ dir }).search("prometheus", 1);
		expect(other.results[0].title).toBe("Prometheus tip");

		// No duplicate chunks for the re-indexed doc
		const index = JSON.parse(await fsp.readFile(path.join(dir, "index.json"), "utf8"));
		const dockerChunks = index.chunks.filter((c) => c.source === `docs/${dockerFile}`);
		expect(dockerChunks).toHaveLength(1);
	});

	it("is writable with an embedding backend even before any index exists", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		expect(await kb.isAvailable()).toBe(false);
		expect(kb.isWritable()).toBe(true);

		delete process.env.OLLAMA_EMBEDDING_MODEL;
		process.env.AI_PROVIDER = "openai";
		expect(createLocalKnowledgeBase({ dir }).isWritable()).toBe(false);
	});

	it("sends input_type per task for embedding APIs that require it (NVIDIA NIM)", async () => {
		const saved = {};
		const keys = ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "AI_EMBEDDING_MODEL"];
		for (const key of keys) saved[key] = process.env[key];
		process.env.AI_PROVIDER = "openai-compatible";
		process.env.AI_BASE_URL = "https://inference.example.com/v1";
		process.env.AI_API_KEY = "token";
		process.env.AI_MODEL = "llama-3.3-70b";
		process.env.AI_EMBEDDING_MODEL = "nvidia/nv-embedqa-e5-v5";

		try {
			const kb = createLocalKnowledgeBase({ dir });
			await kb.addDocument({ title: "Docker note", content: "docker things" });
			const indexBodies = global.fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
			expect(indexBodies.length).toBeGreaterThan(0);
			expect(indexBodies.every((b) => b.input_type === "passage")).toBe(true);
			expect(indexBodies[0].model).toBe("nvidia/nv-embedqa-e5-v5");

			global.fetch.mockClear();
			const result = await kb.search("docker");
			expect(result.ok).toBe(true);
			expect(JSON.parse(global.fetch.mock.calls[0][1].body).input_type).toBe("query");

			// The effective input_type is persisted; changing it without a rebuild
			// is rejected for both reads and writes (a different embedding space)
			const index = JSON.parse(await fsp.readFile(path.join(dir, "index.json"), "utf8"));
			expect(index.documentInputType).toBe("passage");
			process.env.AI_EMBEDDING_QUERY_INPUT_TYPE = "";
			process.env.AI_EMBEDDING_DOCUMENT_INPUT_TYPE = "";
			try {
				const stale = createLocalKnowledgeBase({ dir });
				const mismatchedSearch = await stale.search("docker");
				expect(mismatchedSearch.ok).toBe(false);
				expect(mismatchedSearch.error).toContain("input_type");
				const mismatchedWrite = await stale.addDocument({ title: "x", content: "docker again" });
				expect(mismatchedWrite.ok).toBe(false);
				expect(mismatchedWrite.error).toContain("kb:index");
			} finally {
				delete process.env.AI_EMBEDDING_QUERY_INPUT_TYPE;
				delete process.env.AI_EMBEDDING_DOCUMENT_INPUT_TYPE;
			}
		} finally {
			for (const key of keys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});

	it("reports a missing file cleanly in indexFile", async () => {
		const kb = createLocalKnowledgeBase({ dir });
		const result = await kb.indexFile("nope.md");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not found");
	});

	it("embeds with model task prefixes and detects a prefix mismatch", async () => {
		// Index with nomic-style prefixes active
		process.env.OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
		const kb = createLocalKnowledgeBase({ dir });
		await kb.addDocument({ title: "Docker note", content: "docker things" });

		// Documents were embedded with the search_document prefix
		const indexedInputs = global.fetch.mock.calls.flatMap(([, init]) => {
			const body = JSON.parse(init.body);
			return Array.isArray(body.input) ? body.input : [body.input];
		});
		expect(indexedInputs.every((text) => text.startsWith("search_document: "))).toBe(true);

		// Queries get the search_query prefix
		global.fetch.mockClear();
		const result = await kb.search("docker");
		expect(result.ok).toBe(true);
		const [, queryInit] = global.fetch.mock.calls[0];
		expect(JSON.parse(queryInit.body).input[0]).toBe("search_query: docker");

		// A prefix change (e.g. code upgrade) without reindexing is rejected cleanly
		process.env.OLLAMA_EMBEDDING_QUERY_PREFIX = "";
		process.env.OLLAMA_EMBEDDING_DOCUMENT_PREFIX = "";
		const mismatched = await createLocalKnowledgeBase({ dir }).search("docker");
		expect(mismatched.ok).toBe(false);
		expect(mismatched.error).toContain("kb:index");
		delete process.env.OLLAMA_EMBEDDING_QUERY_PREFIX;
		delete process.env.OLLAMA_EMBEDDING_DOCUMENT_PREFIX;
	});

	it("exposes a function tool definition", () => {
		expect(SEARCH_KNOWLEDGE_TOOL).toMatchObject({
			type: "function",
			name: "search_knowledge_base",
		});
		expect(SEARCH_KNOWLEDGE_TOOL.parameters.required).toEqual(["query"]);
	});
});
