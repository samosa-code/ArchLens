import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Raised from the 5s default: test files run in parallel by default,
    // and two files now launch a real headless Chromium process (Tickets
    // 3.1, 3.2 — each browser launch is itself several OS processes, not
    // one). Confirmed directly (not guessed) that this isn't masking a
    // real slowdown: the CPU-heavy 1,000-node layout test that motivated
    // raising this completes in ~7.5s total (the whole file, all 8 tests)
    // when run in isolation, comfortably under its own internal 5s
    // performance assertion — the full-suite-only timeouts are scheduling/
    // resource contention from everything running in parallel, not the
    // test logic itself being slow. 30s gives real headroom for that
    // contention without meaningfully hiding an actually-hung test.
    testTimeout: 30_000,
    // `hookTimeout` is a separate setting from `testTimeout` (still 10s by
    // default) — a `beforeAll` loading a real fixture template timed out
    // under the same full-suite contention described above even after
    // raising `testTimeout` alone. Same fix, same reasoning.
    hookTimeout: 30_000,
  },
});
