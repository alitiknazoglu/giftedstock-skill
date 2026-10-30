# giftedstock-skill

Gifted Stock for AI agents. With its own wallet, an agent can buy, open and send mystery boxes of onchain equities,
swap stock tokens, bridge between Base and Robinhood Chain and make or claim gift boxes on
[giftedstock.com](https://www.giftedstock.com).

- **[SKILL.md](SKILL.md)** is the guide an agent reads. The same file is served at
  [giftedstock.com/SKILL.md](https://www.giftedstock.com/SKILL.md).
- **[examples/giftedstock.mjs](examples/giftedstock.mjs)** runs one action from a wallet you hold the key to. It asks
  the API for a plan and checks every step against the contracts and functions pinned in the file. It runs the whole
  plan on the chain without sending it, shows you what leaves and reaches the wallet, and sends only after your yes.

## How it works

The agent API (`https://www.giftedstock.com/api/agent/v1`) never holds a key and never sends a transaction. Every write
endpoint answers with a plan: the unsigned transactions your wallet signs and sends, in order. Approvals are exact and
the fee is in the plan's summary. Nothing in a request can change where the output goes, the router, the fee or a
spender.

## Use it

### Claude Code and other agents that load skills

```bash
mkdir -p ~/.claude/skills/giftedstock && curl -fsSL https://www.giftedstock.com/SKILL.md -o ~/.claude/skills/giftedstock/SKILL.md
```

Any other agent: point it at `https://www.giftedstock.com/SKILL.md`.

### The example script

```bash
git clone https://github.com/alitiknazoglu/giftedstock-skill && cd giftedstock-skill && npm ci
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs buy '{"chain":"base","box":"normal","quantity":1,"payWith":"USDC"}'
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs swap '{"from":{"chain":"base","token":"USDC"},"to":{"chain":"base","token":"NVDAc"},"amount":"2"}'
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs gift '{"items":[{"token":"NVDAc","usd":"1"}],"payWith":"USDC","link":{"boxes":3,"who":"anyone"}}'
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs claim
```

`claim` asks for the share URL, or reads it from `GIFT_URL`: never on the command line, where shell history keeps it.

Actions: `buy`, `open`, `send`, `swap`, `gift`, `gift/open`, `gift/take-back` and `claim`. `wallet` is filled in from
the key. `--yes` sends without asking. `BASE_RPC_URL` and `ROBINHOOD_RPC_URL` pick your own RPCs.

The key stays in the process: requests carry addresses and
signatures only. For a gift link the script makes a fresh link key and saves it to `giftedstock-link-<address>.key`
(readable by you only) before anything is sent. Only its address goes to the API, and the share URL is printed once the
gift is made. A keyed RPC address in `BASE_RPC_URL` or `ROBINHOOD_RPC_URL` can show in an error the script prints.

## What the script checks

- Every step is on Base (8453) or Robinhood Chain (4663), and all steps of a plan are on one chain.
- Every step calls a pinned contract with a function this action uses (a buy only `mint` or `mintWithEth` on a box,
  a take-back only `reclaim` on the gift box), or is an ERC-20 `approve` that sends no ETH, for a spender this action
  uses, for no more than the wallet holds. `setApprovalForAll`, `transferFrom` and the like are always refused.
- The arguments that say who gains: a Relay deposit and a take-back for this wallet, a send to the address asked, a
  gift to the wallets asked with the link key made here and no frontend fee, Permit2 rights for Uniswap's router only
  and for an hour at most. Given names instead of addresses, the script shows the resolved addresses and will not
  send with `--yes`.
- A claim signs only a `Claim` of that link for this wallet on the gift box contract.
- The whole plan runs on the chain first (`eth_simulateV1`). A step that would fail stops it, and a buy, a claim, a
  take-back, a gift box opened or a swap on one chain must bring the wallet something. An RPC that can't simulate
  means no `--yes`.
- `validUntil` is kept, and each step waits for the one before to be mined with success.

What a router pays out comes from the dry run's token changes, and a bridge's payout on the other chain is not
checked at all: your own read of the screen is the last check. If anything looks wrong, answer no.

## License

MIT
