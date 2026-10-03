/**
 * Static registrations for Pi modules that pi-ai loads through variable
 * specifiers.
 *
 * A single-executable binary bundles every dependency, so a runtime
 * `import(specifier)` that esbuild cannot resolve would fail. pi-ai exposes
 * official seams for exactly that case (its Bun binary build uses them too):
 * static OAuth flow loaders and a Bedrock provider module override. Source
 * runs keep the lazy dynamic imports untouched.
 */
import { isSea } from "node:sea";

/**
 * Register the embedded OAuth flows and Bedrock provider before the harness
 * can select a provider; a source run has nothing to register because its
 * dynamic imports resolve against the installed package.
 */
export async function registerEmbeddedPiModules(): Promise<void> {
  if (!isSea()) return;
  const [{ registerBunOAuthFlows }, { setBedrockProviderModule }, { bedrockProviderModule }] = await Promise.all([
    import("@earendil-works/pi-ai/bun-oauth"),
    import("@earendil-works/pi-ai/api/bedrock-converse-stream.lazy"),
    import("@earendil-works/pi-ai/bedrock-provider"),
  ]);
  registerBunOAuthFlows();
  setBedrockProviderModule(bedrockProviderModule);
}
