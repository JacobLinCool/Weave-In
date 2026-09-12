import type { AgentConfig, AgentKind } from './contracts';
import personalInstructions from './personal.md?raw';
import groupInstructions from './group.md?raw';

export function defaultAgentConfig(kind: AgentKind): AgentConfig {
  return { kind, name: kind === 'personal' ? 'Muse' : 'Omni', instructions: kind === 'personal' ? personalInstructions : groupInstructions,
    language: 'auto', source: 'all', chat: true, system: true, screen: false, files: kind === 'personal', roomMessages: false, audience: kind === 'personal' ? 'private' : 'public' };
}
