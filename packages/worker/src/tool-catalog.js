const RISK=Object.freeze({LOW:'low',MEDIUM:'medium',HIGH:'high'});
const TOOL_CATALOG={
 'desktop.open_app':{risk:RISK.MEDIUM,description:'Open an approved desktop application'},
 'filesystem.search':{risk:RISK.LOW,description:'Search accessible user files'},
 'terminal.execute':{risk:RISK.HIGH,description:'Execute a user-approved terminal command'},
 'docker.status':{risk:RISK.LOW,description:'Read Docker state'},
 'kubernetes.status':{risk:RISK.LOW,description:'Read Kubernetes state'},
 'terraform.plan':{risk:RISK.MEDIUM,description:'Run Terraform plan in an approved workspace'},
 'aws.read':{risk:RISK.LOW,description:'Read AWS resource state'},
 'adb.status':{risk:RISK.LOW,description:'Read connected Android device state'}
};
function getTool(name){return TOOL_CATALOG[name]||null;}
function requiresConfirmation(name){return getTool(name)?.risk==='high';}
module.exports={RISK,TOOL_CATALOG,getTool,requiresConfirmation};
