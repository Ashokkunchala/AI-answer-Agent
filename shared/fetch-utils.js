// Fetch utilities with API key fallback
// Consolidated from duplicate implementations in main.js

/**
 * Make a fetch request with automatic API key fallback
 * If the request fails with 403 and an API key was used,
 * retry without the key (anonymous mode)
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @param {string} apiKey - Optional API key
 * @returns {Promise<{response: Response, keyInvalidated: boolean}>}
 */
export async function fetchWithKeyFallback(url, options = {}, apiKey = '') {
  const buildHeaders = (withKey) => {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (withKey && apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
  };

  const doRequest = (withKey) => fetch(url, {
    ...options,
    headers: buildHeaders(withKey),
  });

  // Try with API key first
  let response = await doRequest(true);

  // If 403 and we had a key, retry without it
  if (response.status === 403 && apiKey) {
    console.log('API key invalid or revoked (HTTP 403) - retrying without key');
    response = await doRequest(false);
    return { response, keyInvalidated: response.ok };
  }

  return { response, keyInvalidated: false };
}

/**
 * Make a streaming request with automatic API key fallback
 * @param {string} url - The URL to fetch
 * @param {object} body - Request body (will be JSON.stringify'd)
 * @param {string} apiKey - Optional API key
 * @returns {Promise<{response: Response, keyInvalidated: boolean}>}
 */
export async function streamRequestWithFallback(url, body, apiKey = '') {
  return fetchWithKeyFallback(url, {
    method: 'POST',
    body: JSON.stringify(body),
  }, apiKey);
}

/**
 * Build the full URL for an API endpoint
 * @param {string} baseUrl - The worker base URL
 * @param {string} endpoint - The API endpoint path
 * @returns {string} - The full URL
 */
export function buildApiUrl(baseUrl, endpoint) {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${endpoint}`;
}
