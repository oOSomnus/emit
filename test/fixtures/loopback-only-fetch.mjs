import { isIP } from "node:net";

const allowedOrigins = readAllowedOrigins(process.env.EMIT_TEST_ALLOWED_ORIGINS);
const openCodeTarget = readOpenCodeTarget(process.env.OPENCODE_FAKE_URL, allowedOrigins);
const openCodeOrigin = "https://opencode.ai";
const openCodePath = "/zen/go";
const originalFetch = globalThis.fetch.bind(globalThis);

function readAllowedOrigins(raw) {
  if (raw === undefined || raw.length === 0) return new Set();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("EMIT_TEST_ALLOWED_ORIGINS must be a JSON array of loopback origins");
  }
  if (!Array.isArray(parsed) || parsed.some((origin) => typeof origin !== "string")) {
    throw new Error("EMIT_TEST_ALLOWED_ORIGINS must be a JSON array of loopback origins");
  }
  const origins = new Set();
  for (const value of parsed) origins.add(parseLoopbackOrigin(value).origin);
  return origins;
}

function readOpenCodeTarget(raw, registeredOrigins) {
  if (raw === undefined || raw.length === 0) return undefined;
  let target;
  try {
    target = new URL(raw);
  } catch {
    throw new Error("OPENCODE_FAKE_URL must be a loopback HTTP(S) URL");
  }
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    !isLoopbackHostname(target.hostname) ||
    target.username !== "" ||
    target.password !== "" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new Error("OPENCODE_FAKE_URL must be a loopback HTTP(S) URL");
  }
  if (!registeredOrigins.has(target.origin)) {
    throw new Error("OPENCODE_FAKE_URL origin must be registered in EMIT_TEST_ALLOWED_ORIGINS");
  }
  if (target.pathname === "/") target.pathname = "/zen/go";
  return target;
}

function parseLoopbackOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Each allowed fetch origin must be a loopback HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isLoopbackHostname(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Each allowed fetch origin must be a loopback HTTP(S) origin");
  }
  return url;
}

function isLoopbackHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return Number(host.split(".")[0]) === 127;
  return isIP(host) === 6 && host === "::1";
}

function requestUrl(input) {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

function rewriteOpenCodeUrl(url) {
  if (url.origin !== openCodeOrigin || !(url.pathname === openCodePath || url.pathname.startsWith(`${openCodePath}/`))) {
    return undefined;
  }
  if (openCodeTarget === undefined) {
    throw new Error("OpenCode Go fetch blocked: OPENCODE_FAKE_URL is required");
  }
  const rewritten = new URL(openCodeTarget);
  const basePath = rewritten.pathname.replace(/\/$/, "");
  rewritten.pathname = `${basePath}${url.pathname.slice(openCodePath.length)}`;
  rewritten.search = url.search;
  rewritten.hash = "";
  return rewritten;
}

globalThis.fetch = (input, init) => {
  let requested;
  try {
    requested = new URL(requestUrl(input));
  } catch {
    throw new Error("Loopback fetch guard rejected a non-HTTP URL");
  }
  const rewritten = rewriteOpenCodeUrl(requested);
  const destination = rewritten ?? requested;
  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw new Error("Loopback fetch guard rejected a non-HTTP URL");
  }
  if (!allowedOrigins.has(destination.origin)) {
    throw new Error(`Loopback fetch guard blocked unregistered origin ${destination.origin}`);
  }
  const guardedInit = { ...init, redirect: "error" };
  if (rewritten === undefined) return originalFetch(input, guardedInit);
  if (input instanceof Request) return originalFetch(new Request(rewritten, input), guardedInit);
  return originalFetch(rewritten, guardedInit);
};
