// Shared utility functions used by both worker and desktop packages

/**
 * Concatenate an array of ArrayBuffer/Uint8Array chunks into a single ArrayBuffer.
 * @param {Array<ArrayBuffer|Uint8Array>} chunks
 * @returns {ArrayBuffer}
 */
export function concatenateChunks(chunks) {
  if (chunks.length === 0) return new ArrayBuffer(0);
  if (chunks.length === 1) return chunks[0];

  let totalLength = 0;
  for (const chunk of chunks) totalLength += chunk.byteLength;

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

/**
 * Convert a base64 string to an ArrayBuffer.
 * @param {string} b64 - Base64-encoded string
 * @returns {ArrayBuffer}
 */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Create a JSON Response with CORS headers.
 * @param {*} data - Data to serialize as JSON
 * @param {number} status - HTTP status code
 * @param {Request} [request] - Optional request for Origin reflection
 * @returns {Response}
 */
export function jsonResponse(data, status = 200, request = null, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // No credentials are used by this API; wildcard CORS avoids reflecting
      // attacker-controlled Origin values while preserving API-key clients.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      ...extraHeaders,
    },
  });
}
