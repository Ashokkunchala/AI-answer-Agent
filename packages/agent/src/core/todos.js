export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];

// Normalize whatever the model sends into a bounded, well-formed todo list.
export function normalizeTodos(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((t) => {
      if (typeof t === 'string') {
        const content = t.trim();
        return content ? { content, status: 'pending', priority: 'medium' } : null;
      }
      if (!t || typeof t !== 'object') return null;
      const content = String(t.content ?? t.text ?? t.task ?? '').trim();
      if (!content) return null;
      const status = TODO_STATUSES.includes(t.status) ? t.status : 'pending';
      const priority = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
      return { content, status, priority };
    })
    .filter(Boolean)
    .slice(0, 100);
}

export function summarizeTodos(todos = []) {
  const done = todos.filter((t) => t.status === 'completed').length;
  return { total: todos.length, done, open: todos.length - done };
}

const MARK = { pending: '☐', in_progress: '◐', completed: '✔', cancelled: '✗' };

export function formatTodos(todos = []) {
  if (!todos.length) return '(no plan)';
  return todos.map((t) => `${MARK[t.status] || '☐'} ${t.content}`).join('\n');
}
