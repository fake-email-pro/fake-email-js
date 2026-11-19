// Replaced at build and test time from package.json (tsup.config.ts, vitest.config.ts),
// so the version lives in one place.
declare const __SDK_VERSION__: string;

/** Version of this SDK, as sent in the `User-Agent` header. */
export const VERSION: string = __SDK_VERSION__;
