import { createServer } from "node:http";
import type { Socket } from "node:net";

export type OAuthTokenServerFixture = {
  readonly url: string;
  setMode(value: "normal" | "invalid-grant" | "hang"): void;
  setLifetimeSeconds(value: number): void;
  acceptsAccess(value: string): boolean;
  close(): Promise<void>;
};

export async function startOAuthTokenServer(): Promise<OAuthTokenServerFixture> {
  let mode: "normal" | "invalid-grant" | "hang" = "normal";
  let lifetimeSeconds = 3600;
  let generation = 0;
  const refreshTokens = new Set<string>();
  const acceptedAccessTokens = new Set<string>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/token") { response.writeHead(404).end(); return; }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      if (mode === "hang") return;
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(parts).toString("utf8")); }
      catch { response.writeHead(400).end(JSON.stringify({ error: "invalid_request" })); return; }
      response.setHeader("content-type", "application/json");
      if (typeof input !== "object" || input === null || mode === "invalid-grant") {
        response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" })); return;
      }
      const validCode = "code" in input && input.code === "fixture-code";
      const refresh = "refresh_token" in input && typeof input.refresh_token === "string" ? input.refresh_token : undefined;
      if (!validCode && (refresh === undefined || !refreshTokens.delete(refresh))) {
        response.writeHead(400).end(JSON.stringify({ error: "invalid_grant" })); return;
      }
      generation += 1;
      const access = `fixture-access-${generation}`;
      const nextRefresh = `fixture-refresh-${generation}`;
      acceptedAccessTokens.clear();
      acceptedAccessTokens.add(access);
      refreshTokens.add(nextRefresh);
      response.end(JSON.stringify({ access_token: access, refresh_token: nextRefresh, expires_in: lifetimeSeconds }));
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("OAuth fixture did not bind");
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}`,
    setMode(value: typeof mode) { mode = value; },
    setLifetimeSeconds(value: number) { lifetimeSeconds = value; },
    acceptsAccess(value: string) { return acceptedAccessTokens.has(value); },
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
