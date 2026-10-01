export interface AxeNode { selector: string; html: string; summary: string }

/** One axe-core result (a rule + its failing nodes). */
export interface AxeFinding {
  axeRuleId: string;
  kind: 'violation' | 'incomplete';
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  help: string;
  description: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeNode[];
}

export interface KeyboardIssue {
  type: 'unreachable' | 'focus-trap' | 'no-focus-indicator';
  selector: string;
  name: string;
  detail: string;
}
export interface KeyboardResult { tabStops: number; issues: KeyboardIssue[] }
