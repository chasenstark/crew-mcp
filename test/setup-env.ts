/**
 * Vitest setup file — runs once per test worker before any test code.
 *
 * Forces `CREW_OS_NOTIFICATIONS=off` for the entire test process so a
 * test that exercises the orchestrator's terminal-status path can't
 * accidentally fire a real macOS / Windows / Linux toast on the
 * developer's machine. Unconditional assignment, not `??=`: a
 * developer running `CREW_OS_NOTIFICATIONS=on npm test` should not be
 * able to defeat the safety default. Individual tests that need to
 * exercise the enabled branch clear the env var themselves and
 * restore it (the notifications test already does this).
 */
process.env.CREW_OS_NOTIFICATIONS = 'off';
