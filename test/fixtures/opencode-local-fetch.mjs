/** Redirect the real OpenCode Go adapter to the registered private provider. */
const targetValue = process.env.OPENCODE_FAKE_URL;
if (targetValue === undefined) throw new Error("OPENCODE_FAKE_URL is required");
const target = new URL(targetValue);
if (!["http:", "https:"].includes(target.protocol)
  || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  || target.username !== "" || target.password !== "" || target.search !== "" || target.hash !== "") {
  throw new Error("OPENCODE_FAKE_URL must be a loopback URL");
}
if (target.pathname === "/") target.pathname = "/zen/go";
const original = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://opencode.ai" || !(url.pathname === "/zen/go" || url.pathname.startsWith("/zen/go/"))) {
    return original(input, init);
  }
  const rewritten = new URL(target);
  rewritten.pathname = `${target.pathname.replace(/\/$/, "")}${url.pathname.slice("/zen/go".length)}`;
  rewritten.search = url.search;
  return original(input instanceof Request ? new Request(rewritten, input) : rewritten, init);
};
