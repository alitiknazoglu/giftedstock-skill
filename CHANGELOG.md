# Changelog

## 1.5.0 - 2026-11-27

- **Campaigns.** An agent runs a Gifted Stock partner page and its campaigns from its own wallet, as a partner does on the
  site: the partner fee, the page, a campaign with its tasks and box prize, its launch through the campaign vault, more
  winners, a cancel before it starts, boxes back from the pool and managers. SKILL.md's Campaigns section has every step.
  - The campaign vault (`0xc5Fefb7D57c5D58DbC1E6C8D0B637C15F1cAb1Af`, the same on Base and Robinhood Chain) is pinned as
    `campaignVault`, with only `createPartner`, `buy`, `buyAndLaunch`, `launch`, `buyAndRaise`, `raise`, `cancel`,
    `withdraw`, `setPartnerManager`, `claimFirstCome` and `claimRaffle`.
  - An agent token: `GET`/`POST /api/agent/v1/session` (Sign-In with Ethereum, its own statement) answers a token for 24
    hours, sent as `Authorization: Bearer` to the site's partner routes and to `POST /api/agent/v1/tx/partner` and
    `tx/campaign`. `DELETE` signs the wallet out everywhere. Sensitive partner routes still ask the wallet to sign a
    confirmation (428).
  - `verify.mjs` checks each vault step against the request and the chain: the partner is one your wallet owns or
    manages (read on the vault), a launch's box, boxes, boxes a winner and style are the prize asked, a raise adds the
    winners asked, payments are no more than the vault's own quotes (`partnerFeeQuote`, `buyQuote`,
    `campaignFeeQuote`) with one exact approval, take-backs go to your wallet, and only the owner cancels, takes boxes
    back and names managers.
  - `examples/giftedstock.mjs`: `login`, `logout`, `partner`, `campaign`, `call` (a partner, campaign or verify route,
    signing its 428 after your yes), `upload` (a banner or logo) and `join`.
- **Join campaigns.** An agent's wallet takes part like anyone's: it checks the tasks
  (`/api/campaign/<code>/task/<id>/click` and `/verify`), joins (`/join`, a signed line) and claims what it wins with
  `tx/campaign` `{ "action": "claim" }` (`claimFirstCome` or `claimRaffle`, pinned too; nothing paid but gas). The agent
  token proves the wallet on these routes and on `/api/verify/ethos` and `/nft`. `GET /api/agent/v1/verify?wallet=` says
  whether a wallet may join verified-only campaigns and each way to get there; SKILL.md's "Verify yourself" lists them.
- **Make a basket.** `POST /api/agent/v1/tx/basket/create` `{ name, items: [{ token, usd }], payWith }` with the agent
  token reserves a basket for your wallet (a random box, no text) and plans its first box; it goes live when that box
  lands (`POST /api/basket/record { tx }`). `verify.mjs` checks it as a gift to your own wallet of the items asked, with
  the basket's tag, no text on the box and the app-fee share to the fee wallet. The runner: `basket/create`, and it
  prints the ids of the boxes a buy, a gift, a basket or a claim makes.
- **A bridge's payout is checked.** A bridge plan carries Relay's order (`summary.route.order`), and the deposit's id is
  that order's EIP-712 hash (Relay's settlement SDK, `getOrderId`). `verify.mjs` recomputes the hash and stops unless it
  is the deposit's id and the order takes exactly the deposit, pays only your wallet on the other chain in the token
  asked at least `summary.to.minimumOut`, makes no calls there and refunds only your wallet. A bridge plan without the
  order stops. Before, only the deposit was checked: a plan whose deposit funded another order passed. Found in Bankr's
  review of BankrBot/skills#859.
- Run the `verify.mjs` installed with the skill, from its own folder, never a fresh clone of the default branch: it
  moves, and its verifier is not the one you reviewed. Without the folder, check out the exact commit you installed
  before `npm ci`. SKILL.md and README say so.
- Send `"skill": "1.5.0"`. Agents on 1.4.0 keep working as before; campaigns need 1.5.0.

## 1.4.0 note - 2026-11-26

- Opened boxes can be burned by their holder (`burnOpened` on all four boxes since 2026-11-26). `GET /box/{chain}/{box}/{id}`
  answers a burned box with `owner: null` and `burned: true`, its prize as it was; `GET /wallet/{address}` lists only the
  boxes still in the wallet. No request changes: send `"skill": "1.4.0"` as before.

## 1.4.0 - 2026-11-25

- AXIS on Base swaps through its Uniswap v4 pool, where its market is: through Uniswap's Universal Router on Base
  (`0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40`, pinned) with Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`,
  pinned), as every Robinhood Chain swap does: an exact approval to Permit2, Permit2's own exact approval for the router
  until the swap's deadline, then `execute` with the fee to the fee wallet and the rest to your wallet. The API takes
  whichever of a token's routes pays more, so other tokens keep Aero's router or Uniswap's SwapRouter02.
- `verify.mjs` checks `execute` on Base as on Robinhood Chain, through USDC between two hops, and allows one Uniswap v4
  pool with a hook, AXIS/USDC on Base, by its whole key (`HOOKED_POOLS`): its hook can refuse a swap, never take from
  one. Every other v4 pool must have no hook.
- Send `"skill": "1.4.0"`. Agents on 1.3.0 keep AXIS on its Uniswap v3 route.

## 1.3.0 - 2026-11-13

- Every request names the skill's version: `"skill": "1.3.0"` in each POST body, `?skill=1.3.0` on `GET /api/agent/v1`
  and `/tokens` (rule 12). Without it the API answers as 1.2.0 did, so agents on 1.2.0 keep working.
- Gifts go through the gift router v2 (`0x60C52b3552B62bbaf7082B285FE269fc659ec439`): each item on its own exchange
  (Aerodrome Slipstream, Aero, Uniswap v3, Aerodrome classic, Uniswap v4), ETH as an item, tokens such as cbBTC and BNKR
  in boxes. A gift is always bought, with USDC or ETH: `payWith: "held"` and the gift box's `create` are gone.
- The fee on a gift is 2.5% on top, as on the site: the gift box's own fee (read from it) and the app-fee slot's share,
  to the fee wallet. `verify.mjs` holds the slot to exactly that share and that wallet, and counts it in every budget.
- `verify.mjs` quotes each item of a gift or a basket on its exchange's own quoter (pinned in `QUOTERS`, read only) and
  stops a leg allowed to spend more than 3% over that; it never lets a leg buy on Aerodrome classic. The box's design
  must be the one asked. The API holds a gift's quote to 3% over its contents at today's prices (`price_moved`).
- Baskets: `POST /tx/basket` buys boxes of a basket someone published at giftedstock.com/basket, to your own wallet.
  The slot's share goes to the basket's maker when you are not them. `verify.mjs` reads the maker's first box of the
  basket on the chain (theirs, with its tag, no link, the same tokens as yours) and refuses text on a basket's box;
  that box shows the maker bought the basket, so check the maker against the basket's page. The example script has a
  `basket` action.
- Tokens on Base (cbBTC, BNKR, VVV and the rest of `/tokens` with `kind` `token`) swap for USDC or ETH at 1%, through
  Aero's router or Uniswap's SwapRouter02 (`0x2626664c2603336E57B271c5C0b26F421741e481`, pinned); each trade answers
  `confirm_pool_price` first, as a stock with no Chainlink price does, and is held to the token's price on the site's
  Swap tab.
- An ETH payment for a gift or a basket is held to ETH's Chainlink price: no more than 5% over what it buys, and none
  while that price is over an hour old.
- `GET /wallet/{address}` lists tokens held too.

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
