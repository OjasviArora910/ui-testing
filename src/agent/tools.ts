import { z } from 'zod';

const El = z.string().regex(/^e\d{1,3}$/, 'element must look like e12');

/** Every action the agent may request. Anything else fails validation and is never executed. */
export const AgentActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('navigate'), url: z.string().max(500) }).strict(),
  z.object({ tool: z.literal('click'), element: El }).strict(),
  z.object({ tool: z.literal('fill'), element: El, value: z.string().max(200) }).strict(),
  z.object({ tool: z.literal('select'), element: El, value: z.string().max(200) }).strict(),
  z.object({ tool: z.literal('hover'), element: El }).strict(),
  z.object({ tool: z.literal('scroll'), direction: z.enum(['up', 'down', 'top', 'bottom']) }).strict(),
  z.object({ tool: z.literal('press'), key: z.string().max(30) }).strict(),
  z.object({ tool: z.literal('screenshot') }).strict(),
  z.object({ tool: z.literal('inspectDOM') }).strict(),
  z.object({ tool: z.literal('inspectARIA') }).strict(),
  z.object({ tool: z.literal('inspectGeometry'), element: El.optional() }).strict(),
  z.object({ tool: z.literal('inspectNetwork') }).strict(),
  z.object({ tool: z.literal('inspectConsole') }).strict(),
  /** Flags a suspicion for human review. Becomes an ANOMALY, never a defect. */
  z.object({ tool: z.literal('report'), description: z.string().min(1).max(400), element: El.optional() }).strict(),
  z.object({ tool: z.literal('stop'), reason: z.string().max(200) }).strict(),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const AgentStepSchema = z.object({ thought: z.string().max(600), action: AgentActionSchema }).strict();
export type AgentStepOutput = z.infer<typeof AgentStepSchema>;

export type StopReason =
  | 'max_actions' | 'max_pages' | 'max_depth' | 'max_runtime' | 'repeated_action' | 'repeated_state'
  | 'no_progress' | 'budget_exhausted' | 'abort' | 'agent_stop' | 'error';

export interface AgentStepRecord {
  n: number;
  thought: string;
  action: AgentAction | null;
  outcome: 'executed' | 'blocked' | 'invalid' | 'inspected' | 'stopped';
  detail: string;
  url: string;
  stateSig: string;
}

export interface AgentReport { description: string; url: string; selector?: string; name?: string }

export interface AgentResult {
  stopReason: StopReason;
  steps: AgentStepRecord[];
  actionsTaken: number;
  llmCalls: number;
  pagesVisited: string[];
  maxDepthReached: number;
  reports: AgentReport[];
  /** Index ranges in controller.events captured while the agent ran. */
  networkRange: [number, number];
  consoleRange: [number, number];
}
