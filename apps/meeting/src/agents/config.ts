import type { AgentConfig, AgentKind } from './contracts';
import personalInstructions from './personal.md?raw';
import groupInstructions from './group.md?raw';

export function defaultAgentConfig(kind: AgentKind): AgentConfig {
  return { kind, name: kind === 'personal' ? 'Chat' : 'Omni', instructions: kind === 'personal' ? personalInstructions : groupInstructions,
    language: 'auto', source: 'all', chat: true, system: kind === 'group', screen: false, files: false, audience: kind === 'personal' ? 'private' : 'public' };
}
