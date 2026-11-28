# giftedstock-skill

Gifted Stock for AI agents. With its own wallet, an agent can buy, open and send mystery boxes of onchain equities,
swap stock tokens and tokens such as cbBTC and BNKR, bridge between Base and Robinhood Chain, make or claim gift boxes,
buy baskets and run a brand's partner page and its campaigns on [giftedstock.com](https://www.giftedstock.com).

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
the fee is in the plan's summary. Every request names this skill's version (`"skill": "1.5.0"`); without it the API
answers as 1.2.0 did: the version picks the contracts and the fee a plan is built with. Beyond that nothing in a
request can change where the output goes, the router, the fee or a spender.

## What an agent can do

| ask your agent | it calls | SKILL.md section |
|---|---|---|
| "buy 2 normal boxes on Base", "open my boxes", "send box 123 to vitalik.eth" | `tx/buy`, `tx/open`, `tx/send` | Mystery boxes |
| "swap 5 USDC for NVIDIA", "bridge 10 USDC to Robinhood Chain" | `tx/swap` | Swaps and bridges |
| "gift $5 of Apple to a friend", "make a gift link for 10 people" | `tx/gift` | Gift boxes |
| "buy a box of basket a1b2c", "make a basket of $0.90 NVIDIA and $0.10 Apple" | `tx/basket`, `tx/basket/create` | Baskets |
| "launch a campaign for my brand", "join this campaign and claim the prize" | the partner routes, `tx/campaign` | Campaigns |
| "what did I get from my boxes?" | `/wallet`, `/gifts`, `/history` | Read first |

SKILL.md's "What each action takes" says which tokens each action accepts (a Base tokenized stock's ticker ends in
`c`: NVDAc; a Robinhood Chain stock token's doesn't: NVDA). "When it refuses" lists every refusal code and what to
do. A request for something the API doesn't take, such as a token no gift can hold, comes back as a refusal that says
so, and nothing is built or sent:

```json
{ "error": "unknown_token", "message": "items[0].token \"TSLA\" is not a gift token: did you mean TSLAc (0xb200…0cD0)?" }
```

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

Run the copy you installed, from its own folder (a Bankr agent keeps it in `/skills/giftedstock/`). Never run the
default branch: it moves, and its verifier is not the one you reviewed. Without the folder, check out the exact
commit you installed before `npm ci` or anything else:

```bash
git clone https://github.com/alitiknazoglu/giftedstock-skill && cd giftedstock-skill && git checkout <the commit you installed> && npm ci
```

```bash
node verify.mjs plan.json --wallet 0xYou --request '{"wallet":"0xYou","chain":"base","box":"normal","quantity":2,"payWith":"USDC"}'
```

It prints each step in words and `ok`, or `STOP` with the step that is not what was asked. `look yourself` lists what
the API resolved for you (a name to an address, a symbol to a token address). It reads the chain (token decimals and
symbols, a box's price, the gift box's fee, a basket maker's gift, ETH's Chainlink price) through `BASE_RPC_URL` and `ROBINHOOD_RPC_URL`, else each chain's public
RPC; `--offline` checks opens, sends, claims and take-backs without it. `--link-key` gives a gift link's key address
you made. From JavaScript:

```js
import { verifyPlan, defaultClients } from "./verify.mjs";
const { ok, problems, lines, review, unchecked, expect } = await verifyPlan(plan, { wallet, request, clients: defaultClients() });
```

### Campaigns

A partner's routes take an agent token instead of the site's cookie. Sign in once (24 hours), then:

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs login
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs partner '{"action":"create","chain":"base","payWith":"USDC","profile":{"name":"Acme","slug":"acme","description":"what we do","site":"https://acme.xyz","logo":"logo.png"}}'
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs upload '{"slug":"acme","kind":"banner","file":"banner.png"}'
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs call '{"method":"POST","path":"/api/partner/acme/campaigns","body":{"mode":"ready","name":"Launch week","description":"Do the tasks, win a box.","bannerUrl":"<the upload url>","startsAt":"2026-12-01T15:00:00Z","endsAt":"2026-12-08T15:00:00Z","box":"premium","winners":20,"boxesPerWinner":1,"rewardStyle":"raffle","tasks":[{"kind":"link_visit","title":"Read our post","config":{"url":"https://acme.xyz/post"}}]}}'
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs campaign '{"action":"launch","slug":"acme","code":"a1b2c","partnerId":"12","payWith":"USDC","prize":{"chain":"base","box":"premium","boxes":20,"perWinner":1,"style":"raffle","startsAt":"2026-12-01T15:00:00Z","endsAt":"2026-12-08T15:00:00Z"}}'
```

`login` keeps the token in `giftedstock-agent-<address>.token` (readable by you only; `GS_AGENT_TOKEN` wins over
it); `logout` signs the wallet out everywhere. `partner` makes the partner (the vault's partner fee) and registers its
page; `campaign` launches, raises (`"action":"raise","chain","partnerId","campaignId","winners":5`) or cancels a saved campaign
and tells the site. `partner` prints the new partner's vault id and a launch the campaign's: requests name them after;
`call` is any partner route, and a route that asks the wallet to confirm (428) shows its message and signs it only
after your yes. A launch is never sent twice: if the site's answer is lost, post the same hash again.

A basket of your own (its first box goes to you, and it goes live with it):

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs basket/create '{"name":"AI LEADERS","items":[{"token":"0x…NVDAc","usd":"0.90"},{"token":"0x…AAPLc","usd":"0.10"}],"payWith":"USDC"}'
```

Joining a campaign: check its tasks with `call` (`/api/campaign/<code>/task/<id>/click`, then `/verify`), then

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs join '{"code":"a1b2c"}'
```

```bash
PRIVATE_KEY=0x… node examples/giftedstock.mjs campaign '{"action":"claim","code":"a1b2c","chain":"base","campaignId":"7"}'
```

`join` signs the line naming the campaign after your yes; a first-come campaign in the vault takes no join, its claim
takes the slot. `GET /api/agent/v1/verify?wallet=` says whether the wallet may join verified-only campaigns.

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

Actions: `buy`, `open`, `send`, `settle`, `swap`, `gift`, `basket`, `gift/open`, `gift/take-back` and `claim`; for partners and campaigns (1.5.0) `login`, `logout`, `partner`, `campaign`, `call`, `upload`, `join` and `basket/create`. `wallet`
is filled in from the key, `skill` with this repo's version. A basket always has something for your own look (its
maker and mix), so it never goes with `--yes`. `--yes` sends without asking, and only when nothing needs your own look: give recipients and stock tokens as
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
- Inside a Base router's `multicall` (Aerodrome's, Aero's or Uniswap's SwapRouter02 for a token, its deadline within
  `validUntil`): one swap from the token asked to the one asked (two pools at most, through USDC or WETH), paying the
  router itself, then one fee sweep of that token to your wallet, the fee to the fee wallet at 1% with a stock token
  or a token on either side and 0.75% otherwise. Inside Uniswap's `execute` (Robinhood Chain, and AXIS
  on Base): one hop or two through USDG or USDC, the amount asked then all the router holds, no hooks but AXIS/USDC's own
  pool on Base by its whole key, then that fee, then your wallet. Nothing is left in a router.
- The least a swap pays is the summary's `minimumOut`, above 0; a plan's deadlines are within its `validUntil`.
- A campaign vault step is for a partner your wallet owns or manages, read on the vault; a launch is the prize asked
  (box, boxes, boxes a winner, raffle or first come); a raise adds the winners asked; each payment is no more than the
  vault's own quote, with one exact approval; a take-back goes to your wallet; only the owner cancels, takes boxes back
  and names managers.
- A Relay deposit is for your wallet, of the token and amount asked, and funds the Relay order the plan carries
  (`summary.route.order`, whose EIP-712 hash is the deposit's id): it pays only your wallet, on the other chain, in the
  token asked, at least the summary's `minimumOut` with no calls there and refunds only your wallet; a send goes to the address asked; a gift goes to the wallets asked, or behind a
  link with your key, the gate (anyone, verified, your list) and times asked, the note you wrote; a take-back comes to
  your wallet.
- A gift or a basket is bought through the gift router: each item on its exchange from USDC (never Aerodrome classic),
  its leg's maxIn no more than 3% over what the item costs now on that exchange's own quoter, the budget exactly those
  and the USDC with both fees; paid in USDC with an exact approval, or in ETH worth no more than the budget at
  Chainlink's price and 5% (ETH asked in dollars, no more than 3% over them; with Chainlink's price over an hour old,
  an ETH payment stops). The fee is 2.5% on top in all: the gift box's own, read from it, and the app-fee slot's share,
  to the fee wallet - or, for a basket someone else made, to its maker. The box's design is the one asked.
- A basket's boxes all go to your wallet, carry that basket's tag and no text, hold the same tokens as the maker's
  own first box of it (read on the chain, its maker the wallet the API names) and cost no more than 3% over its box
  price and the fee. That gift shows the maker bought the basket, not that they made it, and the mix's shares, the box
  price and the design are the API's word: `look yourself` names the maker and the mix to check on the basket's page.

What it cannot see: a bridge's payout on the other chain (Relay's request id carries it: look it up with Relay itself)
and whether a minimum is a fair price. The example script also runs the plan on the chain first (`eth_simulateV1`):
a step that would fail stops it, a swap or bridge must take exactly the amount asked and nothing else and bring at
least the minimum, and a buy, a claim, a take-back or an open of gift boxes must bring the wallet something. Your own
read of the screen is the last check. If anything looks wrong, answer no.

## Versions

Each version is tagged; what changed is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
