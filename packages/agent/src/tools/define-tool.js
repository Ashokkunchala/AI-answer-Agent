// Minimal opencode-style tool definition helper.
// Every tool exposes: name, description, JSON-schema parameters, a wire schema
// (OpenAI function definition) and an async execute(args) -> { title, output, metadata }.

// Some models serialize nested tool-call arguments as JSON strings (e.g. an
// `edits` array arrives as "[{...}]"). Coerce values to the schema's declared
// type so tools receive the structures they expect.
function tryJson(str) {
  const s = String(str).trim();
  if (!s || (s[0] !== '[' && s[0] !== '{')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function coerceValue(value, schema) {
  if (value == null || !schema || typeof schema !== 'object') return value;
  const type = schema.type;
  if (type === 'array' && typeof value === 'string') {
    const parsed = tryJson(value);
    if (Array.isArray(parsed)) value = parsed;
  } else if (type === 'object' && typeof value === 'string') {
    const parsed = tryJson(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
  } else if (type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    value = parseInt(value.trim(), 10);
  } else if (type === 'number' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    value = Number(value);
  } else if (type === 'boolean' && typeof value === 'string') {
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
  }
  if (type === 'array' && Array.isArray(value) && schema.items) {
    value = value.map((v) => coerceValue(v, schema.items));
  } else if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    value = coerceObject(value, schema);
  }
  return value;
}

function coerceObject(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const props = (schema && schema.properties) || {};
  const out = { ...args };
  for (const [key, propSchema] of Object.entries(props)) {
    if (key in out) out[key] = coerceValue(out[key], propSchema);
  }
  return out;
}

export function defineTool({ name, description, parameters, execute, mutating = false, category = 'general' }) {
  return {
    name,
    description,
    parameters,
    mutating,
    category,
    schema() {
      return {
        type: 'function',
        function: {
          name,
          description,
          parameters: parameters || { type: 'object', properties: {} },
        },
      };
    },
    async run(args = {}) {
      const result = await execute(coerceObject(args, parameters));
      return normalizeResult(result);
    },
  };
}

function normalizeResult(result) {
  if (result == null) return { title: '', output: '', metadata: {} };
  if (typeof result === 'string') return { title: '', output: result, metadata: {} };
  return {
    title: result.title || '',
    output: typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? result, null, 2),
    metadata: result.metadata || {},
  };
}
