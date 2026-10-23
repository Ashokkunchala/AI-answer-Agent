import fetch from 'node-fetch';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { defineTool } from './define-tool.js';

const MAX_CONTENT = 50000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 20000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map(Number);
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const first = parseInt(normalized.split(':')[0] || '0', 16);
    return first < 0x2000 || first > 0x3fff || normalized.startsWith('2001:db8:');
  }
  return family === 0;
}

async function assertPublicHttpUrl(value, lookup) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL must be a valid absolute HTTP or HTTPS address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are allowed.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Local and internal network addresses cannot be fetched.');
  }
  let addresses;
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Private and reserved IP addresses cannot be fetched.');
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((record) => isPrivateAddress(record.address))) {
      throw new Error('The hostname resolves to a private or reserved address.');
    }
  }
  return { url, addresses };
}

function createPinnedAgent(url, addresses) {
  const lookup = (_hostname, options, callback) => {
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
  const Agent = url.protocol === 'https:' ? https.Agent : http.Agent;
  return new Agent({ keepAlive: false, lookup });
}

async function readLimitedText(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Response exceeds the 2 MiB download limit.');
  if (!response.body?.[Symbol.asyncIterator]) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Response exceeds the 2 MiB download limit.');
    return text;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error('Response exceeds the 2 MiB download limit.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class WebTools {
  constructor(opts = {}) {
    this.opts = opts;
    this.fetch = opts.fetchImpl || fetch;
    this.lookup = opts.lookup || dnsLookup;
  }

  get tools() {
    const webfetch = defineTool({
      name: 'webfetch',
      category: 'web',
      description:
        'Fetch a specific URL and return its contents as markdown/text (or raw html). Use only when the user provides a URL or you already know the exact URL you need.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Fully-formed URL to fetch' },
          format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'Output format (default markdown)' },
        },
        required: ['url'],
      },
      execute: async ({ url, format = 'markdown' }) => {
        let target = await assertPublicHttpUrl(url, this.lookup);
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        let res;
        let raw;
        for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
          const agent = createPinnedAgent(target.url, target.addresses);
          try {
            res = await this.fetch(target.url.href, {
              headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
              redirect: 'manual',
              signal,
              agent,
            });
            if (res.status >= 300 && res.status < 400) {
              const location = res.headers?.get?.('location');
              if (!location || redirects === MAX_REDIRECTS) throw new Error('Too many or invalid redirects.');
              target = await assertPublicHttpUrl(new URL(location, target.url).href, this.lookup);
              continue;
            }
            if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
            raw = await readLimitedText(res, MAX_RESPONSE_BYTES);
            break;
          } finally {
            agent.destroy();
          }
        }
        const isHtml = /<html|<!doctype|<body/i.test(raw.slice(0, 2000));
        let content = raw;
        if (isHtml && format !== 'html') content = htmlToText(raw);
        if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT) + '\n… [truncated]';
        return { title: url, output: content, metadata: { status: res.status, length: content.length } };
      },
    });

    const websearch = defineTool({
      name: 'websearch',
      category: 'web',
      description:
        'Search the web (DuckDuckGo) for current information not in your knowledge or for live facts. Do NOT use for greetings, small talk, or general questions you can already answer.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          numResults: { type: 'integer', description: 'Number of results (default 8)' },
        },
        required: ['query'],
      },
      execute: async ({ query, numResults = 8 }) => {
        const resultLimit = Number.isFinite(numResults) ? Math.max(1, Math.min(10, Math.trunc(numResults))) : 8;
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        let html;
        try {
          const res = await this.fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
          html = await readLimitedText(res, MAX_RESPONSE_BYTES);
        } catch (e) {
          return { title: query, output: `Web search failed: ${e.message}`, metadata: { count: 0, error: true } };
        }

        const results = [];
        const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
        let match;
        while ((match = blockRe.exec(html)) && results.length < resultLimit) {
          let link = match[1];
          const uddg = /uddg=([^&]+)/.exec(link);
          if (uddg) link = decodeURIComponent(uddg[1]);
          results.push({
            title: htmlToText(match[2]),
            url: link,
            snippet: match[3] ? htmlToText(match[3]) : '',
          });
        }

        if (!results.length) {
          return { title: query, output: `No results parsed for "${query}".`, metadata: { count: 0 } };
        }
        const output = results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? '\n   ' + r.snippet : ''}`)
          .join('\n\n');
        return { title: query, output, metadata: { count: results.length, results } };
      },
    });

    return { webfetch, websearch };
  }
}
