# Decisions

## Column-of-three discard timing
- Implemented as a server-emitted eligibility event plus an explicit follow-up action window.
- When a reveal/swap creates an eligible column, the turn pauses in `AWAITING_COLUMN_DECISION`.
- The acting player may send `game.discardColumn` for the eligible column or `game.passColumnDiscard` to continue.

## End-of-round interpretation
- Implemented as: triggering player reveals all cards first, then every other player gets exactly one normal final turn in clockwise order.
- After the last final turn, all remaining face-down cards are auto-revealed and scoring is computed.

## Lobby start policy
- `room.start` is host-only.
- Host may start only when at least 2 players are present and all active lobby players are marked ready.

## Starting-player tiebreak
- If multiple players tie for the highest sum of their two initial revealed cards, lowest seat index starts.

## Deck exhaustion behavior
- If the deck runs out, the server reshuffles the discard pile except the current top discard card.

## Reconnect window enforcement
- Reconnect is accepted only until `RECONNECT_GRACE_SECONDS` after disconnect.
- After expiry, the seat remains occupied but the token can no longer reattach (the game can continue with a disconnected player state).

## Persistence hot path
- Hot gameplay runs in memory.
- Postgres persists room metadata, game/round results, and an optional event log (public events only) outside the rules engine.

## Redis
- Redis is not implemented in this version. The server runs without Redis; scaling notes describe room affinity/sticky-session requirements.
