import { authorize } from "./keyAuthority";
export class AgentRuntime {
  constructor(private db: any, private manifest: any, private chronicle: any) {}
  execute(agent_id: string, operation: string, input: any) {
    const auth = authorize(agent_id, operation as any, this.manifest);
    if (!auth.allowed) throw new Error(`DENIED: ${agent_id} cannot ${operation} - ${auth.reason}`);
    return this.chronicle[operation]?.(this.db, input);
  }
}
