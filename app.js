import "dotenv/config";
import { App, LogLevel } from "@slack/bolt";
import { initializeMcpRegistry } from "./ai/mcp_registry.js";
import { registerListeners } from "./listeners/index.js";

// Determine log level based on NODE_ENV
const env = process.env.NODE_ENV?.toLowerCase();
const resolvedLogLevel =
	env === "production" ? LogLevel.WARN : env === "test" ? LogLevel.INFO : LogLevel.DEBUG; // debug/development default

// Initialize the Bolt app
const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	appToken: process.env.SLACK_APP_TOKEN,
	socketMode: true,
	logLevel: resolvedLogLevel,
	clientOptions: {
		slackApiUrl: process.env.SLACK_API_URL || "https://slack.com/api",
	},
});

// Start the Bolt app
(async () => {
	try {
		// Resolve bot user ID (U…) and bot ID (B…)
		const auth = await app.client.auth.test({ token: process.env.SLACK_BOT_TOKEN });
		const BOT_USER_ID = auth.user_id;

		const u = await app.client.users.info({ user: BOT_USER_ID });
		const BOT_ID = u.user?.profile?.bot_id;

		if (!BOT_USER_ID || !BOT_ID) {
			throw new Error("Failed to resolve BOT_USER_ID or BOT_ID");
		}

		// Make them available everywhere via middleware
		app.use(async ({ context, next }) => {
			context.BOT_USER_ID = BOT_USER_ID;
			context.BOT_ID = BOT_ID;
			await next();
		});

		// Initialize MetricsHub MCP registry (discover tools/hosts)
		try {
			await initializeMcpRegistry(app.logger);
			app.logger.info("MCP registry initialized");
		} catch (e) {
			app.logger.warn("Failed to initialize MCP registry", e);
		}

		// Register the action and event listeners
		registerListeners(app);

		await app.start();
		app.logger.info(`🤖 M8B is running! (bot_user_id=${BOT_USER_ID}, bot_id=${BOT_ID})`);
	} catch (error) {
		app.logger.error("Failed to start the app", error);
	}
})();
