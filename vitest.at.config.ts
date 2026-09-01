import baseConfig from "./vitest.config.ts";
import { AT_SUITE_INCLUDE } from "./src/sor/atSuiteFiles.ts";

// mergeConfig concatenates test.include arrays, which would keep the base
// globs and run the full suite. Instead inherit the base object wholesale and
// replace include with the exact AT file list via an object spread.
const { test: baseTest, ...rest } = baseConfig;

export default {
	...rest,
	test: { ...baseTest, include: [...AT_SUITE_INCLUDE] },
};
