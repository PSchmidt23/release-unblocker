import type { IncidentState } from "./types.js";

export interface LiveEvent {
  incidentId: string;
  ts: string;
  state: IncidentState;
  type: string;
  detail?: unknown;
}

type Listener = (event: LiveEvent) => void;

export class EventHub {
  private readonly listeners = new Set<Listener>();

  publish(event: LiveEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
