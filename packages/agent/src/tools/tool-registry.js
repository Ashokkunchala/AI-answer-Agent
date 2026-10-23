import { FileTools } from './file-tools.js';
import { ShellTools } from './shell-tools.js';
import { SearchTools } from './search-tools.js';
import { WebTools } from './web-tools.js';
import { ProjectTools } from './project-tools.js';
import { defineTool } from './define-tool.js';
import { normalizeTodos, formatTodos } from '../core/todos.js';

const MAX_PARALLEL_SUBAGENTS = 4;

// Aggregates every tool the agent can call and exposes them in OpenAI
// function-calling format. Tools can be filtered by name (allow/deny lists)
// and by category.
export class ToolRegistry {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.config = opts.config || {};
    this.enabled = opts.enabled !== false;
    this._subagent = null;
    this._onTodo = null;
    this._skillLoader = null;

    const file = new FileTools({ cwd: this.cwd }).tools;
    const shell = new ShellTools({ cwd: this.cwd, shell: this.config.shell }).tools;
    const search = new SearchTools({ cwd: this.cwd, searchBackend: this.config.searchBackend }).tools;
    const web = new WebTools({ cwd: this.cwd }).tools;
    const project = new ProjectTools({ cwd: this.cwd }).tools;

    this.tools = { ...file, ...search, ...shell, ...web, ...project };
    this._registerPlanTool();
    this._registerTaskTool();
    this._registerSkillTool();
    this._applyFilters();
  }

  _registerPlanTool() {
    this.tools.todowrite = defineTool({
      name: 'todowrite',
      category: 'agent',
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
  }

  _registerTaskTool() {
    this.tools.task = defineTool({
      name: 'task',
      category: 'agent',
      mutating: true,
      description:
        'Launch one or more sub-agents to handle self-contained multi-step tasks. Use `subagent_type` to pick a specialist. Pass `tasks` to run several in parallel. Returns the sub-agent reports.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short (3-5 word) task description' },
          prompt: { type: 'string', description: 'Detailed task for the sub-agent to perform' },
          subagent_type: { type: 'string', enum: ['general', 'explore', 'build', 'plan'], description: 'Specialist to use (default general)' },
          tasks: {
            type: 'array',
            description: 'Run multiple sub-agents in parallel',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                prompt: { type: 'string' },
                subagent_type: { type: 'string', enum: ['general', 'explore', 'build', 'plan'] },
              },
              required: ['prompt'],
            },
          },
        },
      },
      execute: async (args) => {
        if (!this._subagent) return { title: args.description || 'task', output: 'Sub-agent not available.', metadata: { error: true } };
        if (Array.isArray(args.tasks) && args.tasks.length) {
          if (args.tasks.length > MAX_PARALLEL_SUBAGENTS) {
            throw new Error(`At most ${MAX_PARALLEL_SUBAGENTS} sub-agents can run in parallel.`);
          }
          const results = await Promise.all(args.tasks.map((t) => this._subagent({ ...t, parallel: true })));
          const output = results.map((r, i) => `### ${args.tasks[i].description || `sub-agent ${i + 1}`}\n${r}`).join('\n\n');
          return { title: `task (${results.length})`, output, metadata: { parallel: true, count: results.length } };
        }
        const output = await this._subagent({ description: args.description, prompt: args.prompt, subagent_type: args.subagent_type });
        return { title: args.description || 'subagent', output, metadata: {} };
      },
    });
    if (this.config.subagents === false) delete this.tools.task;
  }

  _registerSkillTool() {
    this.tools.skill = defineTool({
      name: 'skill',
      category: 'agent',
      description:
        'Load the full instructions for a named skill from the project (.agent/skills) or user skills directory. Use when a task matches a skill listed in the system prompt.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Skill name' } },
        required: ['name'],
      },
      execute: async ({ name }) => {
        if (!this._skillLoader) return { title: name, output: 'Skills are not enabled.', metadata: { error: true } };
        const skill = await this._skillLoader.load(name);
        if (!skill) return { title: name, output: `Unknown skill "${name}".`, metadata: { error: true } };
        return { title: skill.name, output: skill.body, metadata: { name: skill.name, skill } };
      },
    });
    if (this.config.skills === false) delete this.tools.skill;
  }

  _applyFilters() {
    const allow = this.config.allowedTools || [];
    const deny = this.config.deniedTools || [];
    if (allow.length) {
      for (const name of Object.keys(this.tools)) if (!allow.includes(name)) delete this.tools[name];
    }
    for (const name of deny) delete this.tools[name];
  }

  setSubagent(fn) {
    this._subagent = fn;
  }

  setTodoHandler(fn) {
    this._onTodo = fn;
  }

  setSkillLoader(loader) {
    this._skillLoader = loader;
  }

  list() {
    return Object.keys(this.tools);
  }

  describe() {
    return Object.values(this.tools).map((t) => ({ name: t.name, description: t.description, mutating: t.mutating, category: t.category }));
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
