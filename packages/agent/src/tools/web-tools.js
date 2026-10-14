import fetch from 'node-fetch';
import { defineTool } from './define-tool.js';

const MAX_CONTENT = 50000;
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

export class WebTools {
  constructor(opts = {}) {
    this.opts = opts;
  }

  get tools() {
    const webfetch = defineTool({
      name: 'webfetch',
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
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
        if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
        const raw = await res.text();
        const isHtml = /<html|<!doctype|<body/i.test(raw.slice(0, 2000));
        let content = raw;
        if (isHtml && format !== 'html') content = htmlToText(raw);
        if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT) + '\n… [truncated]';
        return { title: url, output: content, metadata: { status: res.status, length: content.length } };
      },
    });

    const websearch = defineTool({
      name: 'websearch',
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
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        let html;
        try {
          const res = await fetch(url, { headers: { 'User-Agent': UA } });
          html = await res.text();
        } catch (e) {
          return { title: query, output: `Web search failed: ${e.message}`, metadata: { count: 0, error: true } };
        }

        const results = [];
        const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
        let match;
        while ((match = blockRe.exec(html)) && results.length < numResults) {
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
