# Skyjo Rules (Canonical for This Project)

## Deck (150 cards)
- Values `-2..12`
- Counts: `-2 x5`, `-1 x10`, `0 x15`, `1..12 x10 each`

## Layout
- Each player has 12 cards in a `4x3` layout.
- A column is one stack of 3 cards.

## Round setup
- Shuffle.
- Deal 12 face-down cards to each player.
- Start discard pile with 1 face-up card from deck.
- Each player reveals exactly 2 of their own cards.
- Starting player is highest sum of those 2 revealed cards (tie: lowest seat index in this implementation; see `docs/decisions.md`).

## Turn options
- `A) Draw deck`
- Then either:
- `swap` with exactly one layout card (replaced card goes to discard), or
- discard drawn card and reveal exactly one previously face-down layout card.
- `B) Take top discard`
- Swap with exactly one layout card (replaced card goes to discard).

## Column of three identical
- When all 3 cards in a column are revealed and identical, the server emits a column-eligible event.
- This implementation pauses the turn and requires either `game.discardColumn` or `game.passColumnDiscard` (see `docs/decisions.md`).
- Discarded columns are removed from the layout and do not count for scoring.

## End of round
- When a player has all cards revealed, they trigger round end.
- This implementation gives every other player exactly one final normal turn in clockwise order.
- Then all remaining face-down cards are auto-revealed and scoring is computed.

## Scoring
- Sum remaining layout cards (after removed columns).
- Doubling rule: if the trigger player does not have the minimum round score, that player's round score is doubled.

## Game end
- After each round, if any player total score is `>= 100`, game ends.
- Lowest total score wins.
