import { FileTools } from './file-tools.js';
import { ShellTools } from './shell-tools.js';
import { SearchTools } from './search-tools.js';
import { WebTools } from './web-tools.js';
import { ProjectTools } from './project-tools.js';
import { defineTool } from './define-tool.js';
import { normalizeTodos, formatTodos } from '../core/todos.js';

// Aggregates every tool the agent can call and exposes them in OpenAI
// function-calling format.
export class ToolRegistry {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.enabled = opts.enabled !== false;
    this._subagent = null;
    this._onTodo = null;

    const file = new FileTools({ cwd: this.cwd }).tools;
    const shell = new ShellTools({ cwd: this.cwd }).tools;
    const search = new SearchTools({ cwd: this.cwd }).tools;
    const web = new WebTools({ cwd: this.cwd }).tools;
    const project = new ProjectTools({ cwd: this.cwd }).tools;

    this.tools = { ...file, ...search, ...shell, ...web, ...project };

    this.tools.todowrite = defineTool({
      name: 'todowrite',
      description:
        'Create or update the task plan for the current work. Pass the COMPLETE list every time (it replaces the previous plan). Mark exactly one task in_progress at a time and mark tasks completed as you finish them. Use this for any multi-step task.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The full, ordered list of tasks',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'What needs to be done' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      execute: async ({ todos }) => {
        const normalized = normalizeTodos(todos);
        if (this._onTodo) return this._onTodo(normalized);
        return { title: 'plan', output: formatTodos(normalized), metadata: { todos: normalized } };
      },
    });

    // `task` is a subagent tool wired up by AgentCore at runtime.
    this.tools.task = defineTool({
      name: 'task',
      description:
        'Launch a sub-agent to handle a self-contained multi-step task. Returns the sub-agent final report.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short (3-5 word) task description' },
          prompt: { type: 'string', description: 'Detailed task for the sub-agent to perform' },
        },
        required: ['prompt'],
      },
      execute: async ({ description = '', prompt }) => {
        if (!this._subagent) return { title: description, output: 'Sub-agent not available.', metadata: {} };
        const output = await this._subagent({ description, prompt });
        return { title: description || 'subagent', output, metadata: {} };
      },
    });
  }

  setSubagent(fn) {
    this._subagent = fn;
  }

  setTodoHandler(fn) {
    this._onTodo = fn;
  }

  list() {
    return Object.keys(this.tools);
  }

  has(name) {
    return Boolean(this.tools[name]);
  }

  get(name) {
    return this.tools[name];
  }

  schemas() {
    if (!this.enabled) return [];
    return Object.values(this.tools).map((t) => t.schema());
  }

  async execute(name, args) {
    const tool = this.tools[name];
    if (!tool) {
      return { title: name, output: `Error: unknown tool "${name}". Available: ${this.list().join(', ')}`, metadata: { error: true } };
    }
    try {
      return await tool.run(args);
    } catch (e) {
      return { title: name, output: `Error executing ${name}: ${e.message}`, metadata: { error: true } };
    }
  }
}
