/**
 * AI module - main exports
 *
 * This module provides the AI functionality for the M8B Slack bot.
 * The codebase has been restructured into modular components:
 *
 * - config/      - Configuration (system prompt, model settings)
 * - services/    - Core services (OpenAI, streaming, context management)
 * - tools/       - Tool definitions for function calling
 * - utils/       - Utility functions (tokens, output handling, JSON parsing)
 */

// Re-export configuration for external use
export { SYSTEM_PROMPT as DEFAULT_SYSTEM_CONTENT } from "./config/system-prompt.js";
// Re-export the main respond function
export { respond } from "./respond.js";

// Re-export OpenAI client for modules that need direct access
export { openai } from "./services/openai.js";
