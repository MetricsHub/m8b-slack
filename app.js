import "dotenv/config";
import { App, LogLevel } from "@slack/bolt";
import { loadDeploymentNotes, resolveOrganizationName } from "./ai/config/deployment.js";
import { getDeprecatedAiVariables } from "./ai/config/providers.js";
import { initializeMcpRegistry } from "./ai/mcp_registry.js";
import { getProvider } from "./ai/providers/index.js";
import { isMediaStoreConfigured, startMediaCleanup } from "./ai/services/media-store.js";
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

		// Deployment-specific prompt context: the organization name comes from
		// the Slack workspace (team.info, falling back to auth.test; other
		// workspaces of an org-wide install are resolved on their first message),
		// and administrators may append notes with M8B_PROMPT_EXTRA(_FILE). An
		// unreadable notes file is a configuration error, so it is loaded here
		// where it stops the start-up rather than at the first message.
		const organizationName = await resolveOrganizationName(app.client, { logger: app.logger });
		app.logger.info(`Organization: ${organizationName || "(unknown — generic prompt wording)"}`);
		const deploymentNotes = loadDeploymentNotes();
		if (deploymentNotes) {
			app.logger.info(
				`Deployment notes appended to the system prompt (${deploymentNotes.length} chars)`
			);
		}

		// Initialize MetricsHub MCP registry (discover tools/hosts)
		try {
			await initializeMcpRegistry(app.logger);
		} catch (e) {
			app.logger.warn("Failed to initialize MCP registry", e);
		}

		// Resolve and verify the AI backend (never log keys)
		const aiProvider = getProvider();
		app.logger.info(`AI provider: ${aiProvider.name}`);
		app.logger.info(`AI model: ${aiProvider.model}`);
		app.logger.info(`AI endpoint: ${aiProvider.endpoint}`);
		// Vendor-prefixed names (OLLAMA_*, VLLM_*) still work but the common
		// AI_* vocabulary is the documented one: say so once, at startup
		const deprecated = getDeprecatedAiVariables(aiProvider.name);
		if (deprecated.length > 0) {
			const list = deprecated
				.map(
					(d) => `${d.name} (${d.removed ? "no longer read" : "deprecated"}; use ${d.replacement})`
				)
				.join(", ");
			app.logger.warn(`Deprecated AI configuration variables: ${list}`);
		}
		try {
			if (aiProvider.name === "ollama") {
				app.logger.info("Warming up the AI model (may take a minute on a cold server)...");
			}
			const health = await aiProvider.healthCheck();
			if (health.ok) {
				app.logger.info(`AI backend health check passed (${health.detail || "ok"})`);
			} else {
				app.logger.warn(`AI backend health check FAILED: ${health.error}`);
			}
			if (health.warning) {
				app.logger.warn(health.warning);
			}
		} catch (e) {
			app.logger.warn("AI backend health check errored", e);
		}
		// A backend that is merely unreachable may come back; a provider that
		// ended up without a model never can serve a request (every call would
		// go out with model ""), so that configuration is refused up front.
		if (!aiProvider.model) {
			throw new Error(
				"No AI model configured: set AI_MODEL (or let the endpoint serve exactly one model). See the health check output above."
			);
		}

		// Age-based cleanup of the local media store (screenshots saved for the
		// native-vision provider); no-op unless M8B_MEDIA_BASE_URL is configured
		if (isMediaStoreConfigured()) {
			startMediaCleanup(app.logger);
		}

		// Register the action and event listeners
		registerListeners(app);

		await app.start();
		app.logger.info(`🤖 M8B is running! (bot_user_id=${BOT_USER_ID}, bot_id=${BOT_ID})`);
	} catch (error) {
		app.logger.error("Failed to start the app", error);
	}
})();
