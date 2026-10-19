import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

/**
 * A crew agent is a provider-backed thread the user keeps above the thread
 * list, like a contact: an agent such as an ACP connector whose conversation
 * lives in another app and stays in sync with it.
 */
export interface CrewAgent {
  readonly threadRef: ScopedThreadRef;
  readonly name: string;
  readonly role: string | null;
  readonly avatarUrl: string | null;
}

interface CrewAgentStoreState {
  agents: CrewAgent[];
  add: (agent: CrewAgent) => void;
  update: (threadRef: ScopedThreadRef, patch: Partial<Omit<CrewAgent, "threadRef">>) => void;
  remove: (threadRef: ScopedThreadRef) => void;
  move: (threadRef: ScopedThreadRef, toIndex: number) => void;
}

const keyOf = (agent: Pick<CrewAgent, "threadRef">) => scopedThreadKey(agent.threadRef);

function isCrewAgent(value: unknown): value is CrewAgent {
  const agent = value as CrewAgent | null;
  return (
    agent !== null &&
    typeof agent === "object" &&
    typeof agent.name === "string" &&
    typeof agent.threadRef?.environmentId === "string" &&
    typeof agent.threadRef?.threadId === "string" &&
    (agent.role === null || typeof agent.role === "string") &&
    (agent.avatarUrl === null || typeof agent.avatarUrl === "string")
  );
}

export const useCrewAgentStore = create<CrewAgentStoreState>()(
  persist(
    (set) => ({
      agents: [],
      add: (agent) =>
        set((state) => ({
          agents: [...state.agents.filter((entry) => keyOf(entry) !== keyOf(agent)), agent],
        })),
      update: (threadRef, patch) =>
        set((state) => ({
          agents: state.agents.map((entry) =>
            keyOf(entry) === scopedThreadKey(threadRef) ? { ...entry, ...patch } : entry,
          ),
        })),
      remove: (threadRef) =>
        set((state) => ({
          agents: state.agents.filter((entry) => keyOf(entry) !== scopedThreadKey(threadRef)),
        })),
      move: (threadRef, toIndex) =>
        set((state) => {
          const from = state.agents.findIndex(
            (entry) => keyOf(entry) === scopedThreadKey(threadRef),
          );
          if (from === -1) return state;
          const agents = [...state.agents];
          const [agent] = agents.splice(from, 1);
          agents.splice(Math.max(0, Math.min(toIndex, agents.length)), 0, agent!);
          return { agents };
        }),
    }),
    {
      name: "t3code:crew-agents:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: 1,
      migrate: (persisted) => {
        const agents = (persisted as Partial<Pick<CrewAgentStoreState, "agents">> | null)?.agents;
        return { agents: Array.isArray(agents) ? agents.filter(isCrewAgent) : [] };
      },
      merge: (persisted, current) => {
        const agents = (persisted as { agents?: unknown } | null)?.agents;
        return { ...current, agents: Array.isArray(agents) ? agents.filter(isCrewAgent) : [] };
      },
      partialize: ({ agents }) => ({ agents }),
    },
  ),
);

export function crewAgentKeySet(agents: ReadonlyArray<CrewAgent>): ReadonlySet<string> {
  return new Set(agents.map(keyOf));
}
