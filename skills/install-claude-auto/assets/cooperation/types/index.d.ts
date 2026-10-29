export type PendingTurn = { id: number; text: string; revision: number | null; notification?: true };
export type CooperationState = {
  shape: 'cooperation-v1';
  identity: string;
  ownerRevision: number;
  continuationConsumed: boolean;
  activeTurn: { id: string; revision: number | null } | null;
  pending: PendingTurn[];
  sequence: number;
  suspended: boolean;
  notified: string[];
  stopped: boolean;
};

declare module 'claude-code' {
  interface PluginState {
    'apana-cooperation': { runtime: CooperationState };
  }
}
