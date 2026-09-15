// vocabulary.js - Technical vocabulary for interview STT optimization
// Improves recognition accuracy for DevOps/Cloud/Programming terms

export const TECHNICAL_VOCABULARY = {
  cloud: [
    'AWS', 'Azure', 'GCP', 'EKS', 'ECS', 'EC2', 'S3', 'IAM', 'VPC', 
    'Lambda', 'CloudFormation', 'CloudWatch', 'CloudFront', 'SQS', 'SNS',
    'DynamoDB', 'RDS', 'ElastiCache', 'Route53', 'API Gateway'
  ],
  containers: [
    'Kubernetes', 'Docker', 'Helm', 'Pod', 'Deployment', 'Service', 
    'Ingress', 'ConfigMap', 'Secret', 'StatefulSet', 'DaemonSet', 'HPA',
    'ReplicaSet', 'Namespace', 'Cluster', 'Node', 'kubectl', 'minikube'
  ],
  cicd: [
    'Jenkins', 'GitHub Actions', 'GitLab CI', 'CircleCI', 'Travis CI',
    'CI/CD', 'Pipeline', 'Workflow', 'ArgoCD', 'Flux', 'Tekton'
  ],
  infrastructure: [
    'Terraform', 'Ansible', 'Pulumi', 'CloudFormation', 'Chef', 'Puppet',
    'Vagrant', 'Packer', 'Vault', 'Consul', 'Nomad'
  ],
  networking: [
    'DNS', 'TCP', 'UDP', 'HTTP', 'HTTPS', 'Load Balancer', 'Proxy',
    'Nginx', 'HAProxy', 'Envoy', 'Istio', 'Service Mesh', 'gRPC',
    'WebSocket', 'TLS', 'SSL', 'CDN', 'VPN', 'Firewall'
  ],
  programming: [
    'Linux', 'C++', 'Python', 'Java', 'SQL', 'Bash', 'PowerShell',
    'Go', 'Rust', 'JavaScript', 'TypeScript', 'YAML', 'JSON', 'XML'
  ],
  monitoring: [
    'Prometheus', 'Grafana', 'Datadog', 'Splunk', 'ELK', 'Elasticsearch',
    'Kibana', 'Jaeger', 'Zipkin', 'OpenTelemetry', 'Nagios', 'Zabbix'
  ],
  architecture: [
    'Microservices', 'Serverless', 'Event-Driven', 'REST', 'GraphQL',
    'Message Queue', 'Pub/Sub', 'CQRS', 'Event Sourcing', 'Saga',
    'Circuit Breaker', 'Sidecar', 'Backstage'
  ],
  version_control: [
    'Git', 'GitHub', 'GitLab', 'Bitbucket', 'Branch', 'Merge',
    'Rebase', 'Cherry-pick', 'Pull Request', 'Code Review'
  ],
  security: [
    'OAuth', 'JWT', 'SSO', 'RBAC', 'Secrets Management',
    'Vulnerability Scanning', 'Penetration Testing', 'OWASP',
    'Zero Trust', 'mTLS', 'Certificate'
  ]
};

// Flatten all terms for easy lookup
export const ALL_TECHNICAL_TERMS = Object.values(TECHNICAL_VOCABULARY).flat();

// Common misrecognitions and their corrections
// Variants use regex-safe patterns (no \b around hyphens — hyphens are non-word chars)
export const PHONEME_CORRECTIONS = {
  'kubernetes': ['koobernetes', 'kubernets', 'kubeernetes', 'kubernetes'],
  'docker': ['docker'],
  'terraform': ['terraform'],
  'jenkins': ['jenkins'],
  'github': ['github'],
  'cicd': ['cicd', 'see eye see dee'],
  'eks': ['eks'],
  'ecs': ['ecs'],
  'ec2': ['ec2', 'ec two'],
  's3': ['s3', 'ess three'],
  'iam': ['iam', 'eye ay em'],
  'vpc': ['vpc', 'vee pee see'],
  'lambda': ['lambda', 'lamda'],
  'helm': ['helm'],
  'ansible': ['ansible', 'an sible'],
  'pod': ['pod'],
  'deployment': ['deployment'],
  'service': ['service'],
  'ingress': ['ingress'],
  'configmap': ['configmap', 'config map'],
  'statefulset': ['statefulset', 'stateful set'],
  'daemonset': ['daemonset', 'daymon set'],
  'hpa': ['hpa', 'aitch pee ay'],
  'nginx': ['nginx', 'engine x'],
  'yaml': ['yaml', 'yammal'],
  'grpc': ['grpc', 'gee are pee see'],
  'jwt': ['jwt', 'jay dub tee', 'jay double you tee'],
  'oauth': ['oauth', 'oh auth'],
  'prometheus': ['prometheus'],
  'grafana': ['grafana'],
  'elasticsearch': ['elasticsearch'],
  'kibana': ['kibana'],
  'vault': ['vault'],
  'consul': ['consul'],
  'nomad': ['nomad'],
  'pulumi': ['pulumi'],
  'argocd': ['argocd', 'argo cd'],
  'tekton': ['tekton'],
  'envoy': ['envoy'],
  'istio': ['istio'],
  'grpc': ['grpc'],
  'websocket': ['websocket', 'web socket'],
  'microservices': ['microservices', 'micro services'],
  'serverless': ['serverless'],
  'backstage': ['backstage'],
};

// Get keywords string for Deepgram
export function getDeepgramKeywords() {
  const keywords = ALL_TECHNICAL_TERMS.slice(0, 100); // Deepgram has limit
  return keywords.map(k => `${k}:1.5`).join(',');
}

// Post-process transcript to fix common misrecognitions
export function correctTranscript(text) {
  if (!text) return text;
  
  let corrected = text;
  
  // Apply case-insensitive corrections using simple string matching (not \b with hyphens)
  for (const [correct, variants] of Object.entries(PHONEME_CORRECTIONS)) {
    for (const variant of variants) {
      // Use simple case-insensitive replace (variant is already hyphen-free)
      const regex = new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      corrected = corrected.replace(regex, correct);
    }
  }
  
  // Ensure proper case for known terms
  for (const term of ALL_TECHNICAL_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    corrected = corrected.replace(regex, term);
  }
  
  return corrected;
}
