/**
 * Smoke-only fetch redirect.
 *
 * The OpenCode Go provider is driven by its real pi-ai implementation, which
 * targets https://opencode.ai/zen/go. This preload keeps that code path
 * untouched but sends its requests to the local fake provider, preserving the
 * path, method, headers, body, and abort signal. The redirect target is a
 * fixed local fixture, so a smoke run can never reach the real service.
 */

const REAL = "https://opencode.ai/zen/go";
const LOCAL = "http://127.0.0.1:8899/zen/go";

const original = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(REAL)) {
    const rewritten = `${LOCAL}${url.slice(REAL.length)}`;
    if (typeof input === "string" || input instanceof URL) return original(rewritten, init);
    return original(new Request(rewritten, input), init);
  }
  return original(input, init);
};
