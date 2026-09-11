// Shared helpers

// Normalize message content to plain text.
// Handles OpenAI multimodal format where content is an array of parts:
//   [{type:'text', text:'...'}, {type:'image_url', ...}]
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}
