// Prometheus PromQL query functionality

/**
 * Get the OpenAI function tool definition for PromQL queries.
 * Returns null if M8B_PROMETHEUS_URL is not configured.
 */
export function getPromQLTool() {
	if (!process.env.M8B_PROMETHEUS_URL) {
		return null;
	}

	return {
		type: "function",
		name: "PromQLQuery",
		description: `Execute a PromQL query against the Prometheus time-series database.

Supports two query modes:
- **Instant query**: Returns the current value of the expression (use only 'query' parameter)
- **Range query**: Returns values over a time range (use 'query', 'start', 'end', and optionally 'step' parameters)

**Example - Get all active alerts:**
  query: "ALERTS_FOR_STATE"

**Example - Get alerts for a specific host:**
  query: "ALERTS_FOR_STATE{host_name=\\"some.host.name\\"}"

**Example - Get CPU usage over last hour:**
  query: "rate(system_cpu_usage_seconds_total{mode=\\"user\\"}[5m])"
  start: "2024-01-01T00:00:00Z" (or Unix timestamp)
  end: "2024-01-01T01:00:00Z" (or Unix timestamp)
  step: "60s"`,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The PromQL query expression to execute.",
				},
				start: {
					type: "string",
					description:
						"Start time for range queries. RFC3339 format or Unix timestamp. Required for range queries.",
				},
				end: {
					type: "string",
					description:
						"End time for range queries. RFC3339 format or Unix timestamp. Required for range queries.",
				},
				step: {
					type: "string",
					description:
						'Query resolution step width for range queries (e.g., "60s", "5m", "1h"). Defaults to "60s" if not specified.',
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	};
}

/**
 * Execute a PromQL query against the configured Prometheus server.
 * @param {Object} args - The query arguments
 * @param {string} args.query - The PromQL query expression
 * @param {string} [args.start] - Start time for range queries
 * @param {string} [args.end] - End time for range queries
 * @param {string} [args.step] - Query resolution step (defaults to "60s")
 * @param {Object} [logger] - Optional logger
 * @returns {Promise<Object>} Query result
 */
export async function executePromQLQuery(args, logger) {
	const prometheusUrl = process.env.M8B_PROMETHEUS_URL;
	if (!prometheusUrl) {
		return {
			ok: false,
			error: "Prometheus URL not configured (M8B_PROMETHEUS_URL environment variable not set)",
		};
	}

	const query = args?.query;
	if (!query || typeof query !== "string") {
		return { ok: false, error: "Missing required parameter: query" };
	}

	const start = args?.start;
	const end = args?.end;
	const step = args?.step || "60s";

	try {
		let url;
		let isRangeQuery = false;

		// Determine if this is an instant query or a range query
		if (start && end) {
			// Range query
			isRangeQuery = true;
			url = new URL("/api/v1/query_range", prometheusUrl);
			url.searchParams.set("query", query);
			url.searchParams.set("start", start);
			url.searchParams.set("end", end);
			url.searchParams.set("step", step);
		} else {
			// Instant query
			url = new URL("/api/v1/query", prometheusUrl);
			url.searchParams.set("query", query);
		}

		logger?.info?.(`[Prometheus] Executing ${isRangeQuery ? "range" : "instant"} query: ${query}`);
		const startTime = Date.now();

		const response = await fetch(url.toString(), {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const errorText = await response.text();
			logger?.error?.(`[Prometheus] Query failed with status ${response.status}: ${errorText}`);
			return {
				ok: false,
				error: `Prometheus query failed: ${response.status} ${response.statusText}`,
				details: errorText,
			};
		}

		const data = await response.json();
		logger?.info?.(`[Prometheus] Query completed in ${Date.now() - startTime}ms`);

		if (data.status !== "success") {
			return {
				ok: false,
				error: `Prometheus query error: ${data.error || "Unknown error"}`,
				errorType: data.errorType,
			};
		}

		return {
			ok: true,
			queryType: isRangeQuery ? "range" : "instant",
			resultType: data.data?.resultType,
			result: data.data?.result,
		};
	} catch (e) {
		logger?.error?.(`[Prometheus] Query failed:`, { error: e });
		return { ok: false, error: `Failed to execute Prometheus query: ${String(e)}` };
	}
}
