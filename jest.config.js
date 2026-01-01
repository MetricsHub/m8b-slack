/** @type {import('jest').Config} */
export default {
	testEnvironment: "node",
	transform: {},
	moduleFileExtensions: ["js", "mjs", "json"],
	testMatch: ["**/__tests__/**/*.test.js", "**/*.test.js"],
	collectCoverageFrom: [
		"ai/**/*.js",
		"listeners/**/*.js",
		"!**/node_modules/**",
		"!**/__tests__/**",
	],
	coverageDirectory: "coverage",
	coverageReporters: ["text", "lcov", "html"],
	verbose: true,
	setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
	moduleNameMapper: {
		"^(\\.{1,2}/.*)\\.js$": "$1",
	},
};
