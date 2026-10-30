# Changelog

## 1.1.0 - 2026-10-30

- SKILL.md lists every function a step calls with its full signature and selector, and the rules for what may sit
  inside a Base router's `multicall` and Uniswap's `execute` on Robinhood Chain.
- The fee wallet is in SKILL.md, and rule 3 names it as the one address besides yours a swap or bridge pays.
- The bytes after a Base step's arguments are explained: Base's ERC-8021 builder code.
- How long each plan lasts. ETH buys and opens last 10 minutes (were 5).
- Rule 11: your installed copy of SKILL.md is the one you trust; stop if the live API names anything it does not.
- `GET /wallet/{address}` shows balances on both chains. `GET /box/...` shows an opening box's batch.
- `POST /tx/settle` settles a batch the keeper left opening for an hour, from the boxes' own wallet; on Base it
  returns a batch whose random number never came to sealed after 7 days.
- `verify.mjs`: a reference checker for plans, held to the request you sent (`--request` is required) and to the
  chain: what goes in, the token that comes out, every approval, nothing left in a router, the fee and its wallet,
  the minimum, a gift's recipients, items, gate and times. The example script uses it, holds a swap's or bridge's dry
  run to exactly the amount asked and learned `settle`.

## 1.0.0 - 2026-10-30

- SKILL.md, the example script and the agent API: mystery boxes, swaps, bridges and gift boxes on Base and Robinhood
  Chain from your own wallet.
