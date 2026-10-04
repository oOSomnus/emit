import { createProvider, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** Only the external OAuth protocol is fake; Emit's login and store remain real. */
export function createFixtureOAuthProvider(baseUrl: string): Provider {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname)
    || origin.username !== "" || origin.password !== "" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "") {
    throw new Error("OAuth fixture requires a loopback HTTP origin");
  }
  const token = async (parameters: Record<string, string>, signal: AbortSignal): Promise<OAuthCredential> => {
    const response = await fetch(new URL("/token", origin), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parameters), signal,
      redirect: "error",
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status})`);
    if (typeof body !== "object" || body === null || !("access_token" in body) || !("refresh_token" in body)
      || !("expires_in" in body) || typeof body.access_token !== "string" || typeof body.refresh_token !== "string"
      || typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in)) {
      throw new Error("Invalid local OAuth token response");
    }
    return { type: "oauth", access: body.access_token, refresh: body.refresh_token, expires: Date.now() + body.expires_in * 1000 };
  };
  return createProvider({
    id: "fixture-oauth", name: "Fixture OAuth",
    auth: { oauth: {
      name: "Local OAuth",
      async login(interaction) {
        interaction.notify({ type: "auth_url", url: new URL("/authorize", origin).href });
        interaction.notify({ type: "device_code", userCode: "FIXTURE-CODE", verificationUri: new URL("/authorize", origin).href });
        const code = await interaction.prompt({ type: "manual_code", message: "Enter fixture authorization code" });
        return token({ code }, interaction.signal);
      },
      refresh: (credential, signal) => token({ refresh_token: credential.refresh }, signal),
      async toAuth(credential) { return { apiKey: credential.access }; },
    } },
    models: [{ id: "fixture-oauth-chat", name: "Fixture OAuth Chat", api: "openai-completions", provider: "fixture-oauth",
      baseUrl: new URL("/v1", origin).href, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }],
    api: { "openai-completions": openAICompletionsApi() },
  });
}
