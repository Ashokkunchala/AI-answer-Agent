// Intent heuristics used by the agent loop. Kept dependency-free so both the
// core loop and the preflight can share them.

// A request to understand/analyse/explain a whole project or repository.
export const PROJECT_ANALYSIS =
  /\b(understand|analyse|analyze|explore|overview|architecture|map|audit|review)\b[\s\S]*\b(project|repo|repository|codebase|all files)\b|\b(project|repo|repository|codebase)\b[\s\S]*\b(all files|overview|architecture)\b/i;

export function classifyForProjectAnalysis(message) {
  return PROJECT_ANALYSIS.test(String(message || ''));
}
