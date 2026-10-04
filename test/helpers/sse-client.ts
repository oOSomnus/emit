import type { ServerEvent } from "../../src/shared/contracts.ts";

const MAX_QUEUED_EVENTS = 256;
const DEFAULT_NEXT_TIMEOUT_MS = 10_000;

type EventWaiter = {
  predicate: (event: ServerEvent) => boolean;
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Open the application's SSE endpoint and buffer parsed events for predicate-based reads. */
export async function openEventStream(url: string): Promise<{
  next(predicate: (event: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  close(): Promise<void>;
}> {
  const controller = new AbortController();
  const headerTimer = setTimeout(() => controller.abort(new Error("Event stream headers timed out")), DEFAULT_NEXT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(headerTimer);
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the response status as the connection error.
    }
    throw new Error(`Event stream returned HTTP ${response.status}`);
  }
  if (response.body === null) throw new Error("Event stream response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queued: ServerEvent[] = [];
  const waiters: EventWaiter[] = [];
  let input = "";
  let dataLines: string[] = [];
  let ended = false;
  let terminalError: Error | undefined;
  const connected = Promise.withResolvers<void>();
  void connected.promise.catch(() => {});

  const finish = (error: Error) => {
    if (ended) return;
    ended = true;
    terminalError = error;
    connected.reject(error);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const dispatch = (event: ServerEvent) => {
    for (let index = 0; index < waiters.length; ) {
      const waiter = waiters[index];
      if (waiter === undefined) {
        index += 1;
        continue;
      }
      let matches: boolean;
      try {
        matches = waiter.predicate(event);
      } catch (error) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (matches) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
        return;
      }
      index += 1;
    }
    if (queued.length === MAX_QUEUED_EVENTS) queued.shift();
    queued.push(event);
  };

  const processLine = (line: string) => {
    if (line.length === 0) {
      if (dataLines.length === 0) return;
      const data = dataLines.join("\n");
      dataLines = [];
      let event: ServerEvent;
      try {
        event = JSON.parse(data) as ServerEvent;
      } catch (error) {
        throw new Error(`Event stream contained invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      dispatch(event);
      return;
    }
    if (line.startsWith(":")) {
      if (line.slice(1).trim() === "connected") connected.resolve();
      return;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== "data") return;
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  };

  const consume = (text: string, final = false) => {
    input += text;
    let lineStart = 0;
    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (character !== "\r" && character !== "\n") continue;
      if (character === "\r" && index + 1 === input.length && !final) break;
      processLine(input.slice(lineStart, index));
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      lineStart = index + 1;
    }
    input = input.slice(lineStart);
    if (final && input.length > 0) {
      processLine(input);
      input = "";
    }
  };

  const pump = (async () => {
    try {
      while (!ended) {
        const chunk = await reader.read();
        if (chunk.done) break;
        consume(decoder.decode(chunk.value, { stream: true }));
      }
      if (!ended) {
        consume(decoder.decode(), true);
        finish(new Error("Event stream ended"));
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  })().finally(() => reader.releaseLock());

  const connectedTimer = setTimeout(() => connected.reject(new Error("Event stream did not send connected")), DEFAULT_NEXT_TIMEOUT_MS);
  try {
    await connected.promise;
  } catch (error) {
    controller.abort();
    await reader.cancel().catch(() => {});
    await pump;
    throw error;
  } finally {
    clearTimeout(connectedTimer);
  }

  let closePromise: Promise<void> | undefined;
  return {
    next: (predicate, timeoutMs = DEFAULT_NEXT_TIMEOUT_MS) => {
      for (let index = 0; index < queued.length; index += 1) {
        const event = queued[index];
        if (event === undefined) continue;
        let matches: boolean;
        try {
          matches = predicate(event);
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        if (matches) {
          queued.splice(index, 1);
          return Promise.resolve(event);
        }
      }
      if (ended) return Promise.reject(terminalError ?? new Error("Event stream ended"));
      return new Promise<ServerEvent>((resolve, reject) => {
        const waiter: EventWaiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(new DOMException(`Timed out after ${timeoutMs}ms waiting for an event`, "TimeoutError"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    close: () => {
      closePromise ??= (async () => {
        finish(new Error("Event stream closed"));
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // The abort may already have canceled the response body.
        }
        await pump;
      })();
      return closePromise;
    },
  };
}
