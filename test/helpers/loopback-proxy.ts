import {
  createServer,
  request as requestHttp,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type AddressInfo, type Socket } from "node:net";

export type LoopbackProxy = {
  readonly url: string;
  pauseEvents(): void;
  resumeEvents(): void;
  close(): Promise<void>;
};

type ProxyRequest = {
  readonly eventStream: boolean;
  readonly clientResponse: ServerResponse;
  readonly upstreamRequest: ClientRequest;
  upstreamResponse: IncomingMessage | undefined;
  finished: boolean;
};

const HOP_BY_HOP_HEADERS: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  "proxy-connection": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

/** Proxy to a registered local service; only the application SSE route is pausable. */
export async function startLoopbackProxy(targetOrigin: string): Promise<LoopbackProxy> {
  const target = parseLoopbackOrigin(targetOrigin);
  const requests = new Set<ProxyRequest>();
  const eventStreams = new Set<ProxyRequest>();
  const sockets = new Set<Socket>();
  let eventsPaused = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    if (closed) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end("Proxy is closed");
      return;
    }

    let requestUrl: URL;
    try {
      const path = request.url ?? "/";
      if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Expected an origin-form request target");
      requestUrl = new URL(path, target);
      if (requestUrl.origin !== target.origin) throw new Error("Request target escaped the fixed origin");
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid proxy request target");
      return;
    }

    const eventStream = requestUrl.pathname === "/api/events";
    if (eventStream && eventsPaused) {
      response.writeHead(503, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        connection: "close",
      }).end("SSE forwarding is paused");
      return;
    }

    const headers = forwardHeaders(request.headers, target.host);
    const requestOptions = {
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port,
      method: request.method,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      headers,
      agent: false,
    };
    const upstreamRequest = target.protocol === "https:" ? requestHttps(requestOptions) : requestHttp(requestOptions);
    const tracked: ProxyRequest = {
      eventStream,
      clientResponse: response,
      upstreamRequest,
      upstreamResponse: undefined,
      finished: false,
    };
    requests.add(tracked);
    if (eventStream) eventStreams.add(tracked);

    const remove = (): void => {
      requests.delete(tracked);
      eventStreams.delete(tracked);
    };
    const abort = (): void => {
      if (!tracked.finished) {
        tracked.upstreamRequest.destroy();
        tracked.upstreamResponse?.destroy();
      }
      if (!response.destroyed) response.destroy();
      remove();
    };

    response.once("finish", () => {
      tracked.finished = true;
      remove();
    });
    response.once("close", () => {
      if (!tracked.finished) abort();
      else remove();
    });
    request.once("aborted", abort);
    upstreamRequest.once("response", (upstreamResponse) => {
      tracked.upstreamResponse = upstreamResponse;
      if (response.destroyed || (eventStream && eventsPaused)) {
        upstreamResponse.destroy();
        remove();
        return;
      }
      const responseHeaders = forwardHeaders(upstreamResponse.headers, undefined);
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, responseHeaders);
      upstreamResponse.once("error", () => {
        if (!response.destroyed) response.destroy();
      });
      upstreamResponse.pipe(response);
    });
    upstreamRequest.once("error", () => {
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8", connection: "close" });
        response.end("Loopback target request failed");
      } else if (!response.destroyed) {
        response.destroy();
      }
      remove();
    });
    request.pipe(upstreamRequest);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const address = await listenLoopback(server);
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    pauseEvents(): void {
      if (closed || eventsPaused) return;
      eventsPaused = true;
      for (const stream of [...eventStreams]) {
        stream.upstreamRequest.destroy();
        stream.upstreamResponse?.destroy();
        if (!stream.clientResponse.destroyed) stream.clientResponse.destroy();
        requests.delete(stream);
        eventStreams.delete(stream);
      }
    },
    resumeEvents(): void {
      if (!closed) eventsPaused = false;
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      eventsPaused = true;
      for (const tracked of [...requests]) {
        tracked.upstreamRequest.destroy();
        tracked.upstreamResponse?.destroy();
        if (!tracked.clientResponse.destroyed) tracked.clientResponse.destroy();
      }
      requests.clear();
      eventStreams.clear();
      for (const socket of sockets) socket.destroy();
      const closing = Promise.withResolvers<void>();
      closePromise = closing.promise;
      server.close((error) => {
        if (error === undefined) closing.resolve();
        else closing.reject(error);
      });
      return closePromise;
    },
  };
}

function parseLoopbackOrigin(value: string): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error("Loopback proxy target must be a valid HTTP(S) origin");
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  const isV4Loopback = isIP(hostname) === 4 && Number(hostname.split(".")[0]) === 127;
  const isV6Loopback = isIP(hostname) === 6 && hostname === "::1";
  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username !== "" ||
    target.password !== "" ||
    target.pathname !== "/" ||
    target.search !== "" ||
    target.hash !== "" ||
    (!isV4Loopback && !isV6Loopback && hostname !== "localhost")
  ) {
    throw new Error("Loopback proxy target must be a credential-free loopback origin");
  }
  return target;
}

function forwardHeaders(input: IncomingHttpHeaders, host: string | undefined): OutgoingHttpHeaders {
  const connectionTokens = new Set(
    String(input.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (value === undefined || Object.hasOwn(HOP_BY_HOP_HEADERS, key) || connectionTokens.has(key) || key === "host") continue;
    headers[key] = value;
  }
  if (host !== undefined) headers.host = host;
  return headers;
}

function listenLoopback(server: Server): Promise<AddressInfo> {
  const { promise, resolve, reject } = Promise.withResolvers<AddressInfo>();
  const onError = (error: Error): void => {
    server.off("listening", onListening);
    reject(error);
  };
  const onListening = (): void => {
    server.off("error", onError);
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("Loopback proxy did not receive a TCP address"));
      return;
    }
    resolve(address);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(0, "127.0.0.1");
  return promise;
}
