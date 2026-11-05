export type Operation = "read_chronicle"|"write_own_memory"|"challenge"|"report"|"controlled_forgetting"|"audit"|"all";
export function authorize(agent_id: string, operation: Operation, manifest: any): {allowed: boolean, reason: string} {
  const agent = manifest.agents[agent_id];
  if (!agent) return {allowed: false, reason: `unknown agent ${agent_id}`};
  if (agent.permissions.includes("all")) return {allowed: true, reason: "founder all"};
  if (agent.permissions.includes(operation)) return {allowed: true, reason: `${agent_id} has ${operation}`};
  return {allowed: false, reason: `${agent_id} lacks ${operation}`};
}
