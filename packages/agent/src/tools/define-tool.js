// Minimal opencode-style tool definition helper.
// Every tool exposes: name, description, JSON-schema parameters, a wire schema
// (OpenAI function definition) and an async execute(args) -> { title, output, metadata }.
export function defineTool({ name, description, parameters, execute, mutating = false }) {
  return {
    name,
    description,
    parameters,
    mutating,
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
      const result = await execute(args);
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
