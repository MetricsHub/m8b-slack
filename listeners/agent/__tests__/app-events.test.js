import { describe, expect, it, jest } from "@jest/globals";
import { appContextChanged } from "../app-context-changed.js";
import { appHomeOpened } from "../app-home-opened.js";

describe("Agent View app events", () => {
	it("recognizes the Messages tab without posting a repetitive greeting", async () => {
		const debug = jest.fn();

		await appHomeOpened({
			event: { tab: "messages", user: "U123", context: {} },
			logger: { debug },
		});

		expect(debug).toHaveBeenCalledWith("Agent Messages tab opened", {
			user: "U123",
			hasContext: true,
		});
	});

	it("logs context entity types without logging entity values", async () => {
		const debug = jest.fn();

		await appContextChanged({
			event: {
				user: "U123",
				context: {
					entities: [{ type: "slack#/types/channel_id", value: "C123" }],
				},
			},
			logger: { debug },
		});

		expect(debug).toHaveBeenCalledWith("Agent context changed", {
			user: "U123",
			entityTypes: ["slack#/types/channel_id"],
		});
	});
});
