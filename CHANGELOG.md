# Changelog

## 1.2.0 - 2026-10-31

- With a Bankr wallet: SKILL.md says how to send a plan through Bankr, from its Wallet API (`POST /wallet/submit`) or
  from Bankr's own agent, and what to do with a Bankr refusal or a step that was sent and failed.
- Every step has `valueEth`: its `value` in ETH, for a wallet that takes ETH (Bankr's agent). Rule 3 and the Bankr
  section tell the agent to check it is exactly `value` in ETH before sending it; `verify.mjs` stops a plan whose
  `valueEth` is not its `value`.
- The example script sends through a Bankr wallet with `--bankr` and `BANKR_API_KEY`; the checks and the dry run are
  the same.
- Bankr's security settings: MFA, arbitrary contract calls, the daily and per-transaction limits, NFT transfers,
  permitted recipients and pause, what each refuses and that an agent asks its human to check them before the first
  plan and before a gift, a send of boxes or a step that sends ETH.
- `POST /tx/open` without `ids` opens every sealed box of that kind the wallet holds, up to 200: "open my boxes" in one
  call. `verify.mjs` checks each box the API chose is in your wallet (on the chain; `look yourself` with `--offline`).
- Bankr's settings are checked with your human before the first plan and before a gift or a send of boxes; any other
  plan that sends ETH is one step, so a refusal costs nothing and the summary says how much ETH it sends.
- Swaps and bridges only when your human names Gifted Stock: the description and the swap section say so, so an agent
  with its own swaps (Bankr's) keeps them.

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
