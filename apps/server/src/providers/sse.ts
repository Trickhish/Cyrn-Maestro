/* Server-sent events parser.
 *
 * Network reads do not respect message boundaries: one read can carry half a
 * line, three whole events, or a line split mid-UTF-8-sequence. Parsing each
 * chunk independently is the standard way streaming clients corrupt output, so
 * this keeps a buffer across reads and only emits complete lines.
 *
 * TextDecoder with stream:true handles the multi-byte case — without it, a
 * chunk boundary inside an emoji or an accented character yields a replacement
 * character in the middle of the model's prose. */

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      /* Events are separated by a blank line, but every provider we care about
         sends exactly one `data:` line per event, so splitting on newlines and
         skipping blanks is both simpler and tolerant of \r\n. */
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);

        if (!line) continue;
        /* Comment frames are keep-alives; some proxies send them every 15s. */
        if (line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        if (data) yield data;
      }
    }

    /* A final line with no trailing newline. */
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const data = tail.slice(5).trim();
      if (data && data !== "[DONE]") yield data;
    }
  } finally {
    /* Releasing the lock lets the connection be torn down when the loop is
       interrupted mid-stream, rather than leaking until GC. */
    reader.releaseLock();
  }
}
