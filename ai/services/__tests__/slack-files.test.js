/**
 * Tests for Slack files service.
 */

import { jest } from "@jest/globals";
import {
	buildOpenAIFileContentItem,
	createDescribingFileUploadManager,
	createNoopFileUploadManager,
	extractPreviousUploads,
} from "../slack-files.js";

describe("buildOpenAIFileContentItem", () => {
	it("uses explicit high detail for technical images", () => {
		expect(
			buildOpenAIFileContentItem({
				fileId: "file-image",
				fileName: "dashboard.png",
				mimetype: "image/png",
			})
		).toEqual({ type: "input_image", detail: "high", file_id: "file-image" });
	});

	it("uses explicit high detail for PDFs", () => {
		expect(
			buildOpenAIFileContentItem({
				fileId: "file-pdf",
				fileName: "report.pdf",
				mimetype: "application/pdf",
			})
		).toEqual({
			type: "input_file",
			detail: "high",
			file_id: "file-pdf",
			filename: "report.pdf",
		});
	});

	it("leaves other file types for code interpreter", () => {
		expect(
			buildOpenAIFileContentItem({
				fileId: "file-csv",
				fileName: "metrics.csv",
				mimetype: "text/csv",
			})
		).toBeNull();
	});
});

describe("createDescribingFileUploadManager", () => {
	const savedFetch = global.fetch;

	const imageFile = {
		id: "F_IMG",
		name: "dashboard.png",
		mimetype: "image/png",
		url_private_download: "https://files.slack.com/dashboard.png",
	};

	beforeEach(() => {
		global.fetch = jest.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: (name) => (name === "content-type" ? "image/png" : null) },
			arrayBuffer: async () => Buffer.from("png-bytes").buffer,
		}));
	});

	afterEach(() => {
		global.fetch = savedFetch;
	});

	it("turns an image into an input_text description content item", async () => {
		const describeImage = jest.fn(async () => "A CPU graph spiking to 100% at 14:02.");
		const manager = createDescribingFileUploadManager({
			describeImage,
			contextText: "user: why is srv-web-01 slow?",
		});

		const result = await manager.uploadOnce(imageFile);

		expect(result.contentItem.type).toBe("input_text");
		expect(result.contentItem.text).toContain('"dashboard.png"');
		expect(result.contentItem.text).toContain("A CPU graph spiking to 100% at 14:02.");
		expect(result.fileId).toBeNull();

		expect(describeImage).toHaveBeenCalledWith(
			expect.objectContaining({
				mimetype: "image/png",
				fileName: "dashboard.png",
				contextText: "user: why is srv-web-01 slow?",
			})
		);
		expect(describeImage.mock.calls[0][0].buffer).toBeInstanceOf(Buffer);
	});

	it("describes each image only once per conversation turn", async () => {
		const describeImage = jest.fn(async () => "Description.");
		const manager = createDescribingFileUploadManager({ describeImage });

		const first = await manager.uploadOnce(imageFile);
		const second = await manager.uploadOnce(imageFile);

		expect(second).toBe(first);
		expect(describeImage).toHaveBeenCalledTimes(1);
	});

	it("returns an unsupported-type note for non-image files without calling the vision model", async () => {
		const describeImage = jest.fn();
		const manager = createDescribingFileUploadManager({ describeImage });

		const result = await manager.uploadOnce({
			id: "F_CSV",
			name: "hosts.csv",
			mimetype: "text/csv",
		});

		expect(result.contentItem.type).toBe("input_text");
		expect(result.contentItem.text).toContain("only images can be analyzed");
		expect(describeImage).not.toHaveBeenCalled();
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it("degrades to an error note when the vision model fails", async () => {
		const describeImage = jest.fn(async () => {
			throw new Error("vision backend down");
		});
		const manager = createDescribingFileUploadManager({ describeImage });

		const result = await manager.uploadOnce(imageFile);

		expect(result.contentItem.type).toBe("input_text");
		expect(result.contentItem.text).toContain("could not be analyzed");
	});

	it("exposes the shared manager interface with empty code-interpreter state", () => {
		const manager = createDescribingFileUploadManager({ describeImage: async () => "" });
		expect(manager.codeFileIds.size).toBe(0);
		expect(manager.codeContainerFiles.size).toBe(0);
		expect(manager.uploadedFilesThisTurn).toEqual([]);
		expect(manager.disabled).toBeUndefined();
		expect(manager.stageAttachment).toBeUndefined();
	});
});

describe("sandbox attachment staging (Ollama mode with run_python)", () => {
	const savedFetch = global.fetch;

	const csvFile = {
		id: "F_CSV",
		name: "hosts.csv",
		mimetype: "text/csv",
		size: 24,
		url_private_download: "https://files.slack.com/hosts.csv",
	};

	beforeEach(() => {
		global.fetch = jest.fn(async () => ({
			ok: true,
			status: 200,
			headers: { get: (name) => (name === "content-type" ? "text/csv" : null) },
			// TextEncoder allocates a standalone ArrayBuffer; Buffer.from(str).buffer
			// would expose Node's shared buffer pool instead of just these bytes
			arrayBuffer: async () => new TextEncoder().encode("hostname,cpu\nsrv-01,42\n").buffer,
		}));
	});

	afterEach(() => {
		global.fetch = savedFetch;
	});

	describe("createDescribingFileUploadManager with stageAttachments", () => {
		function makeManager() {
			return createDescribingFileUploadManager({
				describeImage: jest.fn(async () => "unused"),
				stageAttachments: true,
			});
		}

		it("stages a CSV attachment and points the note at /data", async () => {
			const manager = makeManager();
			const result = await manager.uploadOnce(csvFile);

			expect(result.contentItem.type).toBe("input_text");
			expect(result.contentItem.text).toContain("run_python");
			expect(result.contentItem.text).toContain("/data/hosts.csv");
			expect(result.contentItem.text).not.toContain("only images can be analyzed");

			expect(manager.sandboxFiles.get("hosts.csv").toString("utf8")).toBe(
				"hostname,cpu\nsrv-01,42\n"
			);
		});

		it("downloads each attachment only once across stageAttachment and uploadOnce", async () => {
			const manager = makeManager();
			await manager.stageAttachment(csvFile);
			await manager.uploadOnce(csvFile);

			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(manager.sandboxFiles.size).toBe(1);
		});

		it("refuses attachments above the size cap without downloading", async () => {
			const manager = makeManager();
			const result = await manager.uploadOnce({ ...csvFile, size: 6 * 1024 * 1024 });

			expect(result.contentItem.text).toContain("could not be staged");
			expect(result.contentItem.text).toContain("too large");
			expect(manager.sandboxFiles.size).toBe(0);
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it("resolves staged-name collisions between distinct attachments", async () => {
			const manager = makeManager();
			await manager.stageAttachment(csvFile);
			const second = await manager.stageAttachment({ ...csvFile, id: "F_CSV_2" });

			expect(second.name).toBe("hosts-2.csv");
			expect([...manager.sandboxFiles.keys()].sort()).toEqual(["hosts-2.csv", "hosts.csv"]);
		});

		it("never stages images (they go through the vision model instead)", async () => {
			const manager = makeManager();
			const result = await manager.stageAttachment({
				id: "F_IMG",
				name: "shot.png",
				mimetype: "image/png",
			});

			expect(result).toBeNull();
			expect(manager.sandboxFiles.size).toBe(0);
		});
	});

	describe("createNoopFileUploadManager", () => {
		it("stays fully disabled without stageAttachments", async () => {
			const manager = createNoopFileUploadManager();
			expect(manager.disabled).toBe(true);
			expect(manager.stageAttachment).toBeUndefined();
			expect(await manager.uploadOnce(csvFile)).toBeNull();
		});

		it("stages data attachments and returns /data notes with stageAttachments", async () => {
			const manager = createNoopFileUploadManager(undefined, { stageAttachments: true });
			expect(manager.disabled).toBeUndefined();

			const result = await manager.uploadOnce(csvFile);
			expect(result.contentItem.text).toContain("/data/hosts.csv");
			expect(result.contentItem.text).toContain("run_python");
			expect(manager.sandboxFiles.has("hosts.csv")).toBe(true);
		});

		it("returns a cannot-analyze note for images and does not stage them", async () => {
			const manager = createNoopFileUploadManager(undefined, { stageAttachments: true });
			const result = await manager.uploadOnce({
				id: "F_IMG",
				name: "shot.png",
				mimetype: "image/png",
			});

			expect(result.contentItem.text).toContain("cannot be analyzed");
			expect(manager.sandboxFiles.size).toBe(0);
			expect(global.fetch).not.toHaveBeenCalled();
		});
	});
});

describe("extractPreviousUploads", () => {
	it("should return empty map when no messages have uploads", () => {
		const messages = [
			{ ts: "1", text: "Hello" },
			{ ts: "2", text: "World" },
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(0);
	});

	it("should extract uploaded file mappings from metadata", () => {
		const messages = [
			{
				ts: "1",
				metadata: {
					event_type: "openai_context",
					event_payload: {
						response_id: "resp_123",
						uploaded_files: [
							{ slack_file_id: "F1", openai_file_id: "file-abc123" },
							{ slack_file_id: "F2", openai_file_id: "file-def456" },
						],
					},
				},
			},
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(2);
		expect(result.get("F1")).toBe("file-abc123");
		expect(result.get("F2")).toBe("file-def456");
	});

	it("should ignore messages without openai_context event type", () => {
		const messages = [
			{
				ts: "1",
				metadata: {
					event_type: "other_event",
					event_payload: {
						uploaded_files: [{ slack_file_id: "F1", openai_file_id: "file-abc" }],
					},
				},
			},
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(0);
	});

	it("should handle invalid upload entries gracefully", () => {
		const messages = [
			{
				ts: "1",
				metadata: {
					event_type: "openai_context",
					event_payload: {
						response_id: "resp_123",
						uploaded_files: [
							{ slack_file_id: "F1", openai_file_id: "file-abc" },
							{ slack_file_id: null, openai_file_id: "file-def" }, // Invalid
							{ slack_file_id: "F3" }, // Missing openai_file_id
						],
					},
				},
			},
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(1);
		expect(result.get("F1")).toBe("file-abc");
	});

	it("should accumulate uploads from multiple messages", () => {
		const messages = [
			{
				ts: "1",
				metadata: {
					event_type: "openai_context",
					event_payload: {
						response_id: "resp_1",
						uploaded_files: [{ slack_file_id: "F1", openai_file_id: "file-1" }],
					},
				},
			},
			{
				ts: "2",
				metadata: {
					event_type: "openai_context",
					event_payload: {
						response_id: "resp_2",
						uploaded_files: [{ slack_file_id: "F2", openai_file_id: "file-2" }],
					},
				},
			},
		];

		const result = extractPreviousUploads(messages);

		expect(result.size).toBe(2);
		expect(result.get("F1")).toBe("file-1");
		expect(result.get("F2")).toBe("file-2");
	});
});
