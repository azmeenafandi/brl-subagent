import type { SubagentEvent, SubagentEventType, SubagentEventListener } from './types';

// Event listeners by type
const listeners = new Map<SubagentEventType, Set<SubagentEventListener>>();

// Global listeners (receive all events)
const globalListeners = new Set<SubagentEventListener>();

/**
 * Emit an event
 * 
 * @param event - The event to emit
 */
export function emit(event: SubagentEvent): void {
  // Notify type-specific listeners
  const typeListeners = listeners.get(event.type);
  if (typeListeners) {
    for (const listener of typeListeners) {
      try {
        listener(event);
      } catch (err) {
        // Don't let listener errors break the event loop
        console.error(`[event-bus] Listener error for ${event.type}:`, err);
      }
    }
  }
  
  // Notify global listeners
  for (const listener of globalListeners) {
    try {
      listener(event);
    } catch (err) {
      console.error(`[event-bus] Global listener error:`, err);
    }
  }
}


/**
 * Create a SubagentEvent helper
 * 
 * @param type - The event type
 * @param agentId - The agent ID
 * @param data - Additional event data
 * @returns SubagentEvent object
 */
export function createEvent(
  type: SubagentEventType,
  agentId: string,
  data: Record<string, unknown> = {}
): SubagentEvent {
  return {
    type,
    agentId,
    timestamp: Date.now(),
    data,
  };
}
