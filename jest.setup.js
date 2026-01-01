/**
 * Jest setup file - runs before all tests
 */
import { jest } from "@jest/globals";

// Set test environment variables
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-api-key";
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.SLACK_APP_TOKEN = "xapp-test-token";

// Increase timeout for async operations
jest.setTimeout(10000);

// Export jest for use in setup
export { jest };
