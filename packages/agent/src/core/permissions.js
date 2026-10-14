// Decides whether a tool call needs explicit user approval before it runs.
// Read-only tools never prompt; only mutating tools do, and only when the user
// has turned off auto-approve (config.autoApprove === false).
export class PermissionManager {
  constructor(config = {}) {
    this.config = config;
    this.always = new Set();
  }

  setConfig(config) {
    this.config = config;
  }

  remember(name) {
    this.always.add(name);
  }

  reset() {
    this.always.clear();
  }

  requiresApproval(toolName, tool) {
    if (this.config.autoApprove !== false) return false;
    if (this.always.has(toolName)) return false;
    return Boolean(tool && tool.mutating);
  }
}
