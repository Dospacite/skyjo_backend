import type { PrivatePlayerAddon, PublicGameSnapshot, SkyjoGameState } from './types';

export function toPublicSnapshot(state: SkyjoGameState): PublicGameSnapshot {
  return {
    gameId: state.gameId,
    roundId: state.roundId,
    rulesVariant: state.rulesVariant,
    roundNumber: state.roundNumber,
    phase: state.phase,
    turnStage: state.turnStage,
    currentTurnSeat: state.currentTurnSeat,
    roundEndTriggerSeat: state.roundEndTriggerSeat,
    finalTurnsRemaining: [...state.finalTurnsRemaining],
    deckCount: state.deck.length,
    discardTop: state.discardPile.at(-1)?.value ?? null,
    discardCount: state.discardPile.length,
    pendingColumnDecision: state.pendingColumnDecision,
    winnerSeatIndex: state.winnerSeatIndex,
    completedRound: state.completedRound,
    players: state.players.map((player) => ({
      seatIndex: player.seatIndex,
      displayName: player.displayName,
      totalScore: player.totalScore,
      connected: player.connected,
      layout: player.round.layout.map((slot, position) => ({
        position,
        removed: slot.removed,
        revealed: slot.revealed,
        value: slot.removed ? null : slot.revealed ? slot.card?.value ?? null : null,
      })),
    })),
  };
}

export function toPrivateAddon(state: SkyjoGameState, seatIndex: number): PrivatePlayerAddon {
  const player = state.players.find((p) => p.seatIndex === seatIndex);
  if (!player) {
    throw new Error(`Unknown seat ${seatIndex}`);
  }
  return {
    seatIndex,
    hiddenValues: player.round.layout
      .map((slot, position) => ({ slot, position }))
      .filter(({ slot }) => !slot.removed && !slot.revealed && slot.card)
      .map(({ slot, position }) => ({ position, value: slot.card!.value })),
    pendingDrawnCard: player.round.pendingDrawnCard?.value ?? null,
  };
}
