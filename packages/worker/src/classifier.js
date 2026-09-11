// ═══════════════════════════════════════════════════════════════
// REQUEST CLASSIFIER - Detects what type of task you're asking
// ═══════════════════════════════════════════════════════════════

import { contentToText } from './utils.js';

const PATTERNS = {
  code_gen: {
    keywords: [
      'write me', 'create a', 'generate', 'build me', 'make me',
      'write terraform', 'write a terraform', 'tfvars', 'hcl',
      'write a dockerfile', 'dockerfile for', 'docker-compose',
      'write a helm chart', 'helm chart for', 'values.yaml',
      'kubernetes manifest', 'k8s yaml', 'write a deployment',
      'write a service', 'ingress yaml', 'write an ingress',
      'github actions', 'gitlab ci', 'ci/cd pipeline',
      'write a script', 'bash script', 'shell script', 'python script',
      'playbook', 'ansible', 'write a module',
      'cloudformation', 'cdk', 'pulumi',
      'nginx config', 'haproxy config', 'traefik',
      'prometheus config', 'grafana dashboard', 'alertmanager',
      'argocd', 'flux', 'tekton', 'jenkinsfile',
    ],
    patterns: [
      /write\s+(a|me|an|the)?\s*(terraform|dockerfile|helm|script|playbook|pipeline|workflow|config|manifest|yaml|json)/i,
      /generate\s+(a|me|an)?\s*(terraform|dockerfile|helm|script|pipeline|config)/i,
      /create\s+(a|me|an)?\s*(terraform|dockerfile|helm|script|pipeline|k8s|kubernetes)/i,
      /i\s+need\s+(a|me)?\s*(terraform|dockerfile|helm|script|pipeline|deployment)/i,
      /(terraform|dockerfile|helm|k8s|kubernetes|docker|ansible|prometheus|grafana|argocd)\s+(for|to|that|with)/i,
      /how\s+to\s+(write|create|set\s+up|configure|deploy)/i,
      /^(tf|yaml|yml|json|bash|sh|py|js|ts)\s*:/i,
      /```(bash|sh|terraform|hcl|yaml|yml|dockerfile|python|javascript|typescript)/i,
    ],
  },

  debug: {
    keywords: [
      'error', 'failing', 'failed', 'broken', 'crash', 'crashed',
      'not working', 'doesn\'t work', 'won\'t start', 'won\'t boot',
      'oom', 'out of memory', 'timeout', 'timed out', 'deadlock',
      '500', '502', '503', '504', '404', '403',
      'panic', 'exception', 'traceback', 'segfault', 'core dump',
      'crashloop', 'pending', 'unschedulable', 'evicted',
      'debug', 'troubleshoot', 'investigate', 'diagnose',
      'root cause', 'incident', 'outage', 'downtime',
      'logs show', 'error log', 'stack trace', 'backtrace',
      'kubelet', 'etcd', 'apiserver', 'scheduler', 'controller',
      'cni', 'calico', 'flannel', 'cilium', 'pod networking',
    ],
    patterns: [
      /why\s+(is|are|does|did|would|should|can|could)\s+.+\s+(fail|error|crash|broken|not|hang|stuck)/i,
      /my\s+.+\s+(is\s+)?(failing|broken|crashing|down|dead|stuck|hung)/i,
      /getting\s+(an?\s+)?error/i,
      /keep\s+getting/i,
      /error\s*[:=]/i,
      /exception\s*[:=]/i,
      /exit\s*code\s*[1-9]/i,
      /status\s*:?\s*(error|failed|crash|pending|unknown)/i,
      /pods?\s+(are\s+)?(crash|fail|restart|pend|evict)/i,
      /deployment\s+(is\s+)?(fail|roll|stuck|error)/i,
      /service\s+(is\s+)?(down|unavail|error|5\d\d)/i,
      /connection\s+(refused|reset|timed?\s*out|abort)/i,
      /no\s+route\s+to\s+host/i,
      /permission\s+denied/i,
      /no\s+space\s+left|disk\s+space\s+(is|full|out|error)/i,
      /certificate\s+(expired|invalid|expir)/i,
      /dns\s+(not|fail|resolv|unreachable)/i,
    ],
  },

  review: {
    keywords: [
      'review', 'audit', 'validate', 'inspect',
      'security', 'vulnerability', 'CVE', 'hardening', 'compliance',
      'best practice', 'improvement', 'optimize', 'refactor',
      'lint', 'static analysis', 'sonar', 'snyk', 'trivy',
      'secrets', 'leak', 'exposed', 'plaintext',
      'sarif', 'sbom', 'supply chain',
    ],
    patterns: [
      /review\s+(this|my|the|a)\s*(code|config|terraform|yaml|script|pipeline|manifest)/i,
      /can\s+you\s+review/i,
      /check\s+(this|my|the)\s*(code|config|terraform|yaml|script|pipeline|manifest|for\s+(security|vulnerab|issue|problem|bug))/i,
      /is\s+this\s+(secure|safe|correct|valid|optimized)/i,
      /audit\s+(this|my|the)/i,
      /any\s+(issue|problem|bug|vulnerab|security)/i,
      /security\s+(review|check|audit|scan|hardening)/i,
      /best\s+practices?\s*(for|in|check)/i,
    ],
  },

  explain: {
    keywords: [
      'explain', 'what is', 'what are', 'how does', 'how do',
      'tell me about', 'describe', 'difference between', 'compare',
      'concept', 'architecture', 'design', 'pattern', 'workflow',
      'why', 'when should', 'when to', 'when not to',
      'pros and cons', 'tradeoff', 'trade-off', 'trade offs',
      'overview', 'summary', 'deep dive', 'elaborate',
      'can you explain', 'help me understand',
    ],
    patterns: [
      /what\s+(is|are|does|do|happens|causes|means)/i,
      /how\s+(does|do|is|are|can|would|should)\s+.+\s*(work|function|operate)/i,
      /explain\s+(how|what|why|the|a|an|the\s+difference)/i,
      /difference\s+between/i,
      /tell\s+me\s+about/i,
      /describe\s+(the|how|what|a|an)/i,
      /why\s+(is|are|does|do|would|should|we|you)\s+(use|need|have|choose)/i,
      /when\s+(should|to|do|would)\s+(you|we|i|one)/i,
      /pros?\s+and\s+cons/i,
      /trade-?offs?\s*(of|for|between)/i,
    ],
  },

  mentor: {
    keywords: [
      'interview', 'hiring', 'job', 'career', 'resume', 'cv',
      'salary', 'negotiate', 'offer', 'promotion',
      'mentor', 'mentoring', 'advice', 'guidance', 'growth',
      'senior', 'staff', 'principal', 'lead', 'architect',
      'certification', 'cert', 'learning', 'study', 'roadmap',
      'skill', 'skills', 'gap', 'improve', 'develop',
      'work life', 'burnout', 'stress', 'balance',
      'team lead', 'engineering manager', 'director',
      'behavioral', 'system design interview', 'coding interview',
      'star method', 'tell me about yourself',
      'how to prepare', 'study plan',
    ],
    patterns: [
      /prepare\s+(for|me)\s+(an?\s+)?interview/i,
      /interview\s+(prep|preparation|question|coach|tips)/i,
      /how\s+to\s+(crack|ace|pass|clear)\s+(the|an?\s+)?interview/i,
      /what\s+should\s+i\s+(study|learn|focus|prepare|practice)/i,
      /career\s+(advice|growth|path|change|progression|plan)/i,
      /should\s+i\s+(take|accept|switch|move|apply|leave)/i,
      /am\s+i\s+(ready|prepared|qualified|good\s+enough)/i,
      /how\s+(long|much|often)\s+(should|i|to)\s+(study|learn|practice)/i,
      /salary\s+(negotiate|expectation|range|offer)/i,
      /my\s+(resume|cv|portfolio|linkedin)/i,
      /tell\s+me\s+about\s+yourself/i,
      /what\s+are\s+your\s+(strength|weakness)/i,
      /how\s+do\s+you\s+(handle|deal|cope|manage)\s+(stress|conflict|pressure)/i,
    ],
  },

  scripting: {
    keywords: [
      'script', 'automate', 'automation', 'cron', 'schedule',
      'pipeline', 'workflow', 'action', 'runner',
      'sed', 'awk', 'grep', 'curl', 'jq', 'xargs',
      'systemd', 'service file', 'unit file',
      'git hook', 'pre-commit', 'post-commit',
      'makefile', 'justfile', 'taskfile',
      'terraform import', 'state', 'backend',
      'kubectx', 'kubens', 'stern', 'k9s',
      'backup', 'restore', 'migrate', 'migration',
      'monitor', 'alert', 'notify', 'slack', 'pagerduty',
    ],
    patterns: [
      /write\s+(a|me)?\s*(bash|shell|python|perl|ruby|powershell)\s*script/i,
      /automate\s+(the|this|my|a)/i,
      /how\s+to\s+(automate|schedule|run|execute)/i,
      /set\s+up\s+(a|an)?\s*(cron|pipeline|workflow|ci|cd)/i,
      /create\s+(a|an)?\s*(cron|pipeline|workflow|ci|cd|gitlab|github\s*action)/i,
    ],
  },
};

// ═══════════════════════════════════════════════════════════════
// CLASSIFIER FUNCTION
// ═══════════════════════════════════════════════════════════════

export function classifyRequest(messages) {
  // Get the latest user message
  const userMsg = messages
    .filter((m) => m.role === 'user')
    .pop();

  if (!userMsg) return 'general';

  const text = contentToText(userMsg.content).toLowerCase();
  const scores = {};

  for (const [category, config] of Object.entries(PATTERNS)) {
    let score = 0;

    // Check keywords
    for (const kw of config.keywords) {
      if (text.includes(kw.toLowerCase())) score += 1;
    }

    // Check regex patterns (weighted higher)
    for (const pat of config.patterns) {
      if (pat.test(text)) score += 3;
    }

    if (score > 0) scores[category] = score;
  }

  // Return highest scoring category, or general
  if (Object.keys(scores).length === 0) return 'general';

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = sorted[0];

  // If score is too low, default to general
  if (bestScore < 2 && sorted.length === 1) return 'general';

  return best;
}
