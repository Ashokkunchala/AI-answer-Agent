// SSE (Server-Sent Events) Parser
// Consolidated from multiple duplicate implementations

/**
 * Parse SSE stream from a Response object
 * @param {ReadableStream} body - The response body stream
 * @param {function} onDelta - Callback for each content delta: (fullText, delta) => void
 * @returns {Promise<string>} - The complete response text
 */
export async function parseSSEStream(body, onDelta) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  function consumeLine(line) {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;

    try {
      const j = JSON.parse(data);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        if (onDelta) onDelta(fullText, delta);
      }
    } catch (e) {
      // Skip malformed JSON lines
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      // Flush remaining buffer
      if (buffer.trim()) consumeLine(buffer.trim());
      return fullText;
    }

    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) consumeLine(line);
    }
  }
}

/**
 * Parse SSE from an async iterable (used by Cloudflare Workers AI streaming)
 * @param {AsyncIterable} asyncIterable - The async iterable yielding SSE chunks
 * @param {function} onDelta - Callback for each content delta
 * @returns {Promise<string>} - The complete response text
 */
export async function parseSSEAsyncIterable(asyncIterable, onDelta) {
  let fullText = '';

  for await (const chunk of asyncIterable) {
    const text = chunk.response || chunk.text || chunk.content || '';
    if (text) {
      fullText += text;
      if (onDelta) onDelta(fullText, text);
    }
  }

  return fullText;
}
