import { isTerminal, type IncidentState } from "./types.js";

/**
 * RECEIVED -> CLASSIFIED -> AGENT_RUNNING -> GATES -> outcome.
 * GATES may return to AGENT_RUNNING once, when the only failures are size
 * limits and we ask the same agent for a smaller diff.
 * FAILED is reachable from every non-terminal state.
 */
const NEXT: Record<IncidentState, readonly IncidentState[]> = {
  RECEIVED: ["CLASSIFIED"],
  CLASSIFIED: ["AGENT_RUNNING", "ESCALATED"],
  AGENT_RUNNING: ["GATES", "ESCALATED"],
  GATES: ["AUTO_FIXED", "PR_OPEN", "ESCALATED", "AGENT_RUNNING"],
  AUTO_FIXED: [],
  PR_OPEN: [],
  ESCALATED: [],
  FAILED: [],
};

export function canTransition(from: IncidentState, to: IncidentState): boolean {
  if (isTerminal(from)) return false;
  if (to === "FAILED") return true;
  return NEXT[from].includes(to);
}

export class IncidentMachine {
  constructor(public state: IncidentState) {}

  transition(to: IncidentState): IncidentState {
    if (!canTransition(this.state, to)) {
      throw new Error(`Illegal transition ${this.state} -> ${to}`);
    }
    this.state = to;
    return this.state;
  }
}
