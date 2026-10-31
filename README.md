# giftedstock-skill

Gifted Stock for AI agents. With its own wallet, an agent can buy, open and send mystery boxes of onchain equities,
swap stock tokens, bridge between Base and Robinhood Chain and make or claim gift boxes on
[giftedstock.com](https://www.giftedstock.com).

- **[SKILL.md](SKILL.md)** is the guide an agent reads. The same file is served at
  [giftedstock.com/SKILL.md](https://www.giftedstock.com/SKILL.md).
- **[verify.mjs](verify.mjs)** checks a plan before it is signed, against the request you sent and the contracts,
  functions, inner calls, fee wallet and builder code pinned in the file, never against the API's own word. It needs
  no key.
- **[examples/giftedstock.mjs](examples/giftedstock.mjs)** runs one action from a wallet you hold the key to. It asks
  the API for a plan, checks it with `verify.mjs`, runs the whole plan on the chain without sending it, shows you what
  leaves and reaches the wallet and sends only after your yes.

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

Any other agent: point it at `https://www.giftedstock.com/SKILL.md`. The copy you installed is the one to trust: if
the live API ever names a contract, function or fee wallet it does not, stop (SKILL.md, rule 11).

### Bankr

In a Bankr agent ([bankr.bot](https://bankr.bot)):

```
install the giftedstock skill from https://github.com/alitiknazoglu/giftedstock-skill
```

A Bankr wallet sends each step for you: SKILL.md's "With a Bankr wallet" says how, from Bankr's agent or its Wallet
API. Every step is a contract call, so the wallet's "Enable arbitrary contract calls" must be on (bankr.bot, Security),
which Bankr allows only once the account has MFA (a passkey or an authenticator app), and it needs ETH for gas on the
chain. Bankr's daily and per-transaction limits count the ETH a step sends, and its NFT transfer count can count boxes
that leave the wallet: SKILL.md lists every setting that can refuse a step, and the agent asks you to check them first. A Bankr refusal is final: the skill stops and says what Bankr said.

### Check a plan

```bash
git clone https://github.com/alitiknazoglu/giftedstock-skill && cd giftedstock-skill && npm ci
```

```bash
node verify.mjs plan.json --wallet 0xYou --request '{"wallet":"0xYou","chain":"base","box":"normal","quantity":2,"payWith":"USDC"}'
```

It prints each step in words and `ok`, or `STOP` with the step that is not what was asked. `look yourself` lists what
the API resolved for you (a name to an address, a symbol to a token address). It reads the chain (token decimals and
symbols, a box's price, the gift box's fee) through `BASE_RPC_URL` and `ROBINHOOD_RPC_URL`, else each chain's public
RPC; `--offline` checks opens, sends, claims and take-backs without it. `--link-key` gives a gift link's key address
you made. From JavaScript:

```js
import { verifyPlan, defaultClients } from "./verify.mjs";
const { ok, problems, lines, review, unchecked, expect } = await verifyPlan(plan, { wallet, request, clients: defaultClients() });
```

### The example script

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

```bash
BANKR_API_KEY=bk_… node examples/giftedstock.mjs buy '{"chain":"base","box":"normal","quantity":1,"payWith":"USDC"}' --bankr
```

`claim` asks for the share URL, or reads it from `GIFT_URL`: never on the command line, where shell history keeps it.
`--bankr` sends through a Bankr wallet: the wallet is the Bankr key's EVM address, each step goes to Bankr's
`/wallet/submit` as it is and `BANKR_API_KEY` goes to api.bankr.bot only. The key needs Wallet API access and must not
be read-only.

Actions: `buy`, `open`, `send`, `settle`, `swap`, `gift`, `gift/open`, `gift/take-back` and `claim`. `wallet` is filled
in from the key. `--yes` sends without asking, and only when nothing needs your own look: give recipients and stock tokens as
addresses. `BASE_RPC_URL` and `ROBINHOOD_RPC_URL` pick your own RPCs.

The key stays in the process: requests carry addresses and signatures only. For a gift link the script makes a fresh
link key and saves it to `giftedstock-link-<address>.key` (readable by you only) before anything is sent. Only its
address goes to the API, and the share URL is printed once the gift is made. A keyed RPC address in `BASE_RPC_URL` or
`ROBINHOOD_RPC_URL` can show in an error the script prints.

## What verify.mjs checks

- The plan is the action your request body asks for, on its chain, and every step is on that chain.
- Every step calls a pinned contract with a function that action uses, or is an ERC-20 `approve` that sends no ETH,
  for a contract that action uses, for exactly what a later step takes. `setApprovalForAll`, `transferFrom` and the
  like are always refused. A step's data is its selector and its arguments, then on Base the builder code, nothing
  more.
- What goes in is what you asked: the token and the amount of a swap or bridge (and the ETH sent with one), the box,
  the quantity and the box's own price, the ids (or, with none asked, boxes your wallet holds), the items, boxes and recipients of a gift.
- Inside a Base router's `multicall`: one swap from the token asked to the one asked (through USDC at most), paying the
  router itself, then one fee sweep of that token to your wallet, the fee to the fee wallet at 1% with a stock token
  on either side and 0.75% otherwise. Inside Uniswap's `execute`: one hop or two through USDG, the amount asked then
  all the router holds, no hooks, then that fee, then your wallet. Nothing is left in a router.
- The least a swap pays is the summary's `minimumOut`, above 0; a plan's deadlines are within its `validUntil`.
- A Relay deposit is for your wallet; a send goes to the address asked; a gift goes to the wallets asked, or behind a
  link with your key, the gate (anyone, verified, your list) and times asked, the note you wrote, no frontend fee and
  the gift box's own fee; a take-back comes to your wallet.

What it cannot see: a bridge's payout on the other chain (Relay's request id carries it: look it up with Relay itself)
and whether a minimum is a fair price. The example script also runs the plan on the chain first (`eth_simulateV1`):
a step that would fail stops it, a swap or bridge must take exactly the amount asked and nothing else and bring at
least the minimum, and a buy, a claim, a take-back or an open of gift boxes must bring the wallet something. Your own
read of the screen is the last check. If anything looks wrong, answer no.

## Versions

Each version is tagged; what changed is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
