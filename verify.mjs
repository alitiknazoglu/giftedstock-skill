#!/usr/bin/env node
/**
 * Checks a Gifted Stock plan (https://www.giftedstock.com/SKILL.md) before you sign it, against the request you sent:
 * every step's contract, function and arguments, the calls inside a swap, what goes in, what comes out, the fee and
 * who is paid - all pinned in this file or read on the chain, never taken from the API's own word. It needs no key.
 *
 *   node verify.mjs plan.json --wallet 0xYou --request '<the JSON body you sent>' [--link-key 0xKeyAddress] [--offline]
 *   curl -s … | node verify.mjs - --wallet 0xYou --request '…'
 *
 *   import { verifyPlan } from "./verify.mjs";
 *   const { ok, problems, lines, review, unchecked, expect } = await verifyPlan(plan, { wallet, request, clients });
 *
 * `ok` false: do not send. `review`: what the API resolved for you (a name to an address, a symbol to a token): check
 * it is what your human meant. `unchecked`: what this file cannot see. `expect`: what a swap or bridge must take from the wallet and bring it, for a
 * dry run to hold the plan to. The command line reads the chain through BASE_RPC_URL
 * and ROBINHOOD_RPC_URL, else each chain's public RPC; --offline checks opens, sends, claims and take-backs without it.
 *
 * 1.3.0: a gift or a basket goes through router v2 (each item on its own exchange, ETH an item) with the app-fee slot
 * filled - the fee wallet's, or a basket maker's shown by a gift of theirs on the chain - 2.5% on top in all; a token
 * (cbBTC, BNKR...) swaps through Aero's router or Uniswap's SwapRouter02; no gift paid with tokens held. Requests carry
 * "skill": "1.3.0" (a gift or a basket without it is refused here: the API answers it as 1.2.0 did).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  concat, createPublicClient, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData,
  erc20Abi, formatEther, formatUnits, getAddress, hashStruct, http, isAddress, keccak256, parseAbi, parseAbiParameters, parseUnits, toBytes,
  toFunctionSelector, zeroAddress, zeroHash,
} from "viem";
import { formatAbiItem } from "viem/utils";
import { base, robinhood } from "viem/chains";

export const VERSION = "1.5.0";

// Every contract a step may be sent to or approve, besides the token being approved (SKILL.md, "Contracts a step may
// target"). If GET /api/agent/v1 ever names others, this file is right and the API is not: stop.
export const PINNED = {
  8453: {
    normalBox: "0xFc4633d297E936072cbf83e43F26B104B70188DC",
    premiumBox: "0xc7E36409B4F6A9D4F7Dd575E11C4C5beA682e827",
    giftBox: "0x5a095D4aB6f9aea04D87e10312FBf1d2695ABa8A",
    giftRouter: "0x60C52b3552B62bbaf7082B285FE269fc659ec439",
    aerodromeRouter: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
    aeroRouter: "0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418",
    uniswapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    // 1.4.0: Uniswap's Universal Router 2.1.2 on Base and Permit2, a token's Uniswap v4 route (AXIS)
    uniswapRouter: "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    relayDepository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
    // 1.5.0: partners and campaigns (the campaign vault, the same address on both chains)
    campaignVault: "0xc5Fefb7D57c5D58DbC1E6C8D0B637C15F1cAb1Af",
  },
  4663: {
    normalBox: "0xB669dF5aB27db31c20696743e9C78951c863c1Ca",
    premiumBox: "0x9e0C3611EFf93aB12346a6C9c35D3BcEa69C58e6",
    uniswapRouter: "0x204FAca1764B154221e35c0d20aBb3c525710498",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    relayDepository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
    campaignVault: "0xc5Fefb7D57c5D58DbC1E6C8D0B637C15F1cAb1Af",
  },
};
/** Each chain's money (6 decimals) and its WETH, which swaps trade ETH as. */
export const MONEY = {
  8453: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", weth: "0x4200000000000000000000000000000000000006" },
  4663: { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" },
};
/**
 * The only Uniswap v4 pools with a hook a swap may trade through, by their whole key (currency0, currency1, fee,
 * tickSpacing, hooks), by chain: on Base AXIS/USDC (its hook can refuse a swap, never take from one: its address flags
 * no delta-returning permission and the fee is static). Every other v4 pool must have no hook.
 */
export const HOOKED_POOLS = {
  8453: [["0x5bE75e3b0aFf5D1A042A5363Ae36AcB1d6d755ea", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 100, 1, "0xB0b24B89dB0dafbE43C5b40226b63A179f592880"]],
  4663: [],
};
/** The one address besides yours a swap or bridge pays: the fee in a plan's `summary.fee`. It is never called. */
export const FEE_WALLET = "0xd98EE65e5271267EBE34f87B846403107c068A0f";
/** The bytes after every Base step's arguments: Base's ERC-8021 builder code bc_lfbayxwx. The contract never reads them. */
export const BUILDER_SUFFIX = "0x62635f6c666261797877780b0080218021802180218021802180218021";
/** A swap's fee: 1% when a stock token or a token (cbBTC, BNKR...) is on either side, 0.75% between money and ETH. */
export const STOCK_FEE_BPS = 100n;
export const MONEY_FEE_BPS = 75n;
/** What a gift or a basket pays on top in all: the gift box's own fee, read from it, and the app-fee slot's share of it. */
export const TOTAL_FEE_BPS = 250n;
/** Base's Chainlink ETH/USD feed: the most an ETH payment for a gift may be worth, against what it buys. Read only. */
export const ETH_USD_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
/** Each exchange's own quoter (and Aero's pool factory), read only, never a step's target: what a gift's item costs now,
 *  to hold its leg's maxIn to. */
export const QUOTERS = {
  slipstream: "0x514c8B5f54112481E28028F1166Bd78501089259",
  aero: "0x1dDfeC5058180C207F55BB77D95AcDd0d8227868",
  aeroFactory: "0x9CB220581b91b0C83223012FE69688b92aD07a76",
  uniswapV3: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  uniswapV4: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
};
/** A leg's maxIn may be what its item costs now and this much more: the API's 0.5% margin and the price's moves since. */
const LEG_ROOM_BPS = 300n;
/** Uniswap's Universal Router reads this address as "the router itself", and ALL as "all the router holds". */
const ROUTER_ITSELF = "0x0000000000000000000000000000000000000002";
const ALL = 1n << 255n;
/** A gift link for verified wallets names this rule as its gate. */
const VERIFIED_RULE = keccak256(toBytes("gifted-stock verified v1"));
const CHAIN_ID = { base: 8453, robinhood: 4663 };
const CHAIN_NAME = { 8453: "Base", 4663: "Robinhood Chain" };
const DAY = 86_400;

// The only functions a plan calls on each contract. Anything else - setApprovalForAll, approve or transferFrom on a
// box, rekeyLink, withdrawPending - does not decode here and is refused.
const boxCalls = [
  "function mint(uint256 qty)",
  "function mintWithEth(uint256 qty) payable",
  "function open(uint256[] tokenIds) payable",
  "function sendCards(address to, uint256[] tokenIds)",
];
const baseBoxAbi = parseAbi([
  ...boxCalls,
  "function settle(uint256 batchId, uint256[] tokenIds)",
  "function cancelStuck(uint256 batchId, uint256[] tokenIds)",
]);
const rhBoxAbi = parseAbi([...boxCalls, "function revealAndSettle(uint256 batchId, uint256[] tokenIds, bytes signature)"]);
const giftStructs = [
  "struct Item { address token; uint256 amount; }",
  "struct Options { address linkKey; uint8 gateKind; bytes32 gate; bytes32 design; bytes32 messageHash; uint40 claimFrom; uint40 claimUntil; address frontend; uint16 frontendBps; uint32 maxFeeBps; }",
];
// no `create`: a 1.3.0 gift is always bought through the router
const giftAbi = parseAbi([
  "function claim(uint256 batchId, bytes linkSig, uint256 deadline, bytes verifierSig, bytes32[] proof)",
  "function open(uint256[] ids)",
  "function reclaim(uint256 batchId, uint32 count, address to)",
]);
// router v2: each leg names its exchange (0 Aerodrome Slipstream, 1 Aero, 2 Uniswap v3, 3 Aerodrome classic, 4 Uniswap v4)
const giftRouterAbi = parseAbi([
  ...giftStructs,
  "struct Leg { uint8 venue; bytes path; uint256 maxIn; }",
  "struct UsdcPermit { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "struct Pay { uint256 budget; uint256 deadline; uint8 ethVenue; bytes ethPath; UsdcPermit permit; }",
  "function buy(Item[] items, Leg[] legs, uint32 boxes, address[] recipients, Options opt, Pay pay) payable",
]);
const routerAbi = parseAbi(["function multicall(bytes[] data) payable"]);
// Uniswap's SwapRouter02: its multicall carries the deadline, its exactInput takes none
const router02Abi = parseAbi(["function multicall(uint256 deadline, bytes[] data) payable"]);
// what a Base router's multicall may hold (SKILL.md, "Inside multicall and execute")
const routerInnerAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; int24 tickSpacing; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable",
  "struct ExactInputParams { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable",
  "function sweepTokenWithFee(address token, uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable",
  "function unwrapWETH9WithFee(uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable",
  "function refundETH() payable",
]);
const router02InnerAbi = parseAbi([
  "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable",
  "function sweepTokenWithFee(address token, uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable",
  "function unwrapWETH9WithFee(uint256 amountMinimum, address recipient, uint256 feeBips, address feeRecipient) payable",
  "function refundETH() payable",
]);
const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const relayAbi = parseAbi([
  "function depositNative(address depositor, bytes32 id) payable",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);
const approveAbi = parseAbi(["function approve(address spender, uint256 amount)"]);
// the campaign vault (1.5.0): a partner's fee, its pool, its campaigns and its managers - nothing else of it
const PAYMENT = "(bool inEth,uint256 maxUsdc,uint256 permitDeadline,bytes permitSig)";
const TERMS = "(uint64 partnerId,address box,uint8 style,uint32 perWinner,uint40 startsAt,uint40 endsAt,bytes32 ref)";
const vaultAbi = parseAbi([
  `function createPartner(address owner_, ${PAYMENT} pay) payable returns (uint64)`,
  `function buy(uint64 partnerId, address box, uint32 qty, ${PAYMENT} pay) payable`,
  `function buyAndLaunch(${TERMS} t, uint32 qty, ${PAYMENT} pay) payable returns (uint64)`,
  `function launch(${TERMS} t, uint32 count, ${PAYMENT} pay) payable returns (uint64)`,
  `function buyAndRaise(uint64 campaignId, uint32 qty, ${PAYMENT} pay) payable`,
  `function raise(uint64 campaignId, uint32 count, ${PAYMENT} pay) payable`,
  "function cancel(uint64 campaignId, uint32 max) returns (uint256)",
  "function withdraw(uint64 partnerId, address box, uint32 count, address to) returns (uint256[])",
  "function setPartnerManager(uint64 partnerId, address wallet, bool on)",
  "function claimFirstCome(uint64 campaignId, uint32 total, uint256 deadline, bytes signature, uint32 max, address to) returns (uint256[])",
  "function claimRaffle(uint64 campaignId, uint32 total, bytes32[] proof, uint32 max, address to) returns (uint256[])",
]);
const vaultReadAbi = parseAbi([
  "function partnerOf(uint64 partnerId) view returns ((address owner,address pendingOwner,uint40 createdAt,bool blocked))",
  "function isPartnerManager(uint64 partnerId, address wallet) view returns (bool)",
  "function campaign(uint64 campaignId) view returns ((uint64 partnerId,address box,uint8 style,bool published,bool closed,bool cancelled,uint32 perWinner,uint32 boxes,uint32 owed,uint40 startsAt,uint40 endsAt,uint40 claimUntil,bytes32 ref,bytes32 winnersRoot))",
  "function partnerFeeQuote() view returns (uint256 usdcUnits, uint256 wei_)",
  "function campaignFeeQuote(address box, uint256 count) view returns (uint256 usdcUnits, uint256 wei_)",
  "function buyQuote(address box, uint256 qty) view returns (uint256 usdcUnits, uint256 wei_)",
  "function pool(uint64 partnerId, address box) view returns (uint32 count, (uint64 start,uint32 count,uint32 mintedAt)[] ranges)",
]);
// reads
const boxReadAbi = parseAbi(["function price() view returns (uint256)", "function mintPriceWei(uint256 qty) view returns (uint256)", "function ownerOf(uint256 id) view returns (address)"]);
const batchOwnerAbi = parseAbi(["function batchOf(uint256 batchId) view returns ((address owner,uint32 requestedAt,uint16 count,bool revealed,bool settled,bool cancelled))"]);
const giftSettingsAbi = parseAbi(["function settings() view returns (address feeWallet, uint32 feeBps, bool paused, address verifier, address renderer, uint8 maxSticker, uint256 boxesMade, uint256 batchesMade)"]);
const giftBatchAbi = parseAbi(["function batchOf(uint256 batchId) view returns (address creator, uint40 createdAt, uint8 gateKind, address linkKey, uint32 boxes, uint32 unclaimed, uint40 claimFrom, uint40 claimUntil, bytes32 gate, bytes32 design, bytes32 messageHash)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]);
const giftItemsAbi = parseAbi(["function batchItems(uint256 batchId) view returns ((address token, uint256 amount)[])"]);
// the quoters as views (they revert inside and catch), as the site reads them
const pathQuoterAbi = parseAbi(["function quoteExactOutput(bytes path, uint256 amountOut) view returns (uint256 amountIn, uint160[] a, uint32[] b, uint256 c)"]);
const aeroQuoterAbi = parseAbi(["function quoteExactOutputSingleV3(address pool, address tokenIn, uint256 amountOut, uint160 sqrtPriceLimitX96) view returns (uint256 amountIn, uint160 a, uint32 b)"]);
const aeroFactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)"]);
const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactOutputSingle(QuoteExactSingleParams params) view returns (uint256 amountIn, uint256 gasEstimate)",
]);

const ABI_OF = {
  8453: { normalBox: baseBoxAbi, premiumBox: baseBoxAbi, giftBox: giftAbi, giftRouter: giftRouterAbi, aerodromeRouter: routerAbi, aeroRouter: routerAbi, uniswapRouter02: router02Abi, uniswapRouter: universalRouterAbi, permit2: permit2Abi, relayDepository: relayAbi, campaignVault: vaultAbi },
  4663: { normalBox: rhBoxAbi, premiumBox: rhBoxAbi, uniswapRouter: universalRouterAbi, permit2: permit2Abi, relayDepository: relayAbi, campaignVault: vaultAbi },
};

const sig = (abi) => abi.filter((x) => x.type === "function").map((f) => ({ signature: formatAbiItem(f), selector: toFunctionSelector(f) }));
/** Each contract's functions with their signatures and selectors: GET /api/agent/v1 `functions` must list the same. */
export const FUNCTIONS = {
  base: Object.fromEntries(Object.entries(ABI_OF[8453]).map(([k, abi]) => [k, sig(abi)])),
  robinhood: Object.fromEntries(Object.entries(ABI_OF[4663]).map(([k, abi]) => [k, sig(abi)])),
  token: sig(approveAbi),
  // every call a Base router's multicall may hold: Aerodrome's and Aero's, and SwapRouter02's own exactInput
  multicall: [...sig(routerInnerAbi), ...sig(router02InnerAbi)].filter((f, i, all) => all.findIndex((g) => g.signature === f.signature) === i),
};

// Uniswap's Universal Router commands a plan uses, and each input's layout
const CMD = {
  0x00: { name: "V3_SWAP_EXACT_IN", layout: "address, uint256, uint256, bytes, bool, uint256[]" },
  0x04: { name: "SWEEP", layout: "address, address, uint256" },
  0x06: { name: "PAY_PORTION", layout: "address, address, uint256" },
  0x0b: { name: "WRAP_ETH", layout: "address, uint256" },
  0x0c: { name: "UNWRAP_WETH", layout: "address, uint256" },
  0x10: { name: "V4_SWAP", layout: "bytes, bytes[]" },
};
const V4_ACTIONS = "0x0b060e"; // SETTLE, SWAP_EXACT_IN_SINGLE, TAKE: one v4 hop
const V4 = {
  settle: "address, uint256, bool",
  swap: "((address, address, uint24, int24, address), bool, uint128, uint128, uint256, bytes)",
  take: "address, address, uint256",
};

/** The campaign vault's plans (1.5.0): POST tx/partner and tx/campaign, by their request's `action`. */
/** 1.5.0: a new basket's first box, by its maker (POST tx/basket/create). */
const BASKET_CREATE = "basket_create";
const VAULT_ACTIONS = ["partner_create", "pool_withdraw", "partner_manager", "campaign_launch", "campaign_raise", "campaign_cancel", "campaign_claim"];
const VAULT_ACTION_OF = { create: "partner_create", withdraw: "pool_withdraw", manager: "partner_manager", launch: "campaign_launch", raise: "campaign_raise", cancel: "campaign_cancel", claim: "campaign_claim" };

/** The actions a plan can be, and which of them are checked against the chain itself. */
export const ACTIONS = ["buy", "open", "send", "settle", "swap", "bridge", "gift_create", "gift_link_create", "basket_buy", BASKET_CREATE, "gift_claim", "gift_open", "gift_take_back", ...VAULT_ACTIONS];
const READS_CHAIN = new Set(["buy", "settle", "swap", "bridge", "gift_create", "gift_link_create", "basket_buy", BASKET_CREATE, ...VAULT_ACTIONS]);
/** The actions whose plan 1.3.0 builds differently from 1.2.0 (and the vault's, 1.5.0's own): their request must name this version. */
const NEEDS_SKILL = new Set(["gift_create", "gift_link_create", "basket_buy", BASKET_CREATE, ...VAULT_ACTIONS]);

/** What a request body asks for, by its shape: the plan must be that, whatever it calls itself. */
export function actionOf(r) {
  if (!r || typeof r !== "object") return null;
  // the vault's requests name their action; a campaign's always name its partner page and code, a partner fee its chain
  if (typeof r.action === "string" && Object.hasOwn(VAULT_ACTION_OF, r.action)) {
    const kind = VAULT_ACTION_OF[r.action];
    if (kind === "campaign_claim" ? r.code === undefined : kind.startsWith("campaign_") && (r.slug === undefined || r.code === undefined)) return null;
    return kind;
  }
  if (r.from && r.to && typeof r.from === "object" && typeof r.to === "object" && r.amount !== undefined) return r.from.chain === r.to.chain ? "swap" : "bridge";
  // a new basket names itself and its items, never a recipient or a link
  if (Array.isArray(r.items) && typeof r.name === "string" && r.to === undefined && r.link === undefined) return BASKET_CREATE;
  if (Array.isArray(r.items)) return r.link ? "gift_link_create" : "gift_create";
  if (r.basket !== undefined) return "basket_buy";
  if (r.quantity !== undefined) return "buy";
  if (r.id !== undefined) return "settle";
  if (Array.isArray(r.ids) && r.to !== undefined) return "send";
  if (Array.isArray(r.ids) && r.chain !== undefined) return "open";
  if (Array.isArray(r.ids)) return "gift_open";
  // { wallet, chain, box } with no ids: open every sealed box of that kind the wallet holds (a recipient or a link
  // in it means another action written wrong, never an open)
  if (r.ids === undefined && r.to === undefined && r.batchId === undefined && r.chain !== undefined && r.box !== undefined) return "open";
  if (r.batchId !== undefined && r.signature !== undefined) return "gift_claim";
  if (r.batchId !== undefined) return "gift_take_back";
  return null;
}

class Stop extends Error {}
const stop = (m) => {
  throw new Stop(m);
};
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const nameOf = (chainId, address) => Object.entries(PINNED[chainId] ?? {}).find(([, a]) => same(a, address))?.[0];
const hexBytes = (hex) => (hex.length > 2 ? hex.slice(2).match(/../g).map((b) => parseInt(b, 16)) : []);
const isAddr = (v) => typeof v === "string" && isAddress(v, { strict: false });
const an = (word) => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;

/** A decimal amount in a token's units: "2" USDC is 2000000. */
function units(v, decimals, field) {
  if (typeof v !== "string" && typeof v !== "number") stop(`${field} is missing`);
  const s = String(v);
  if (!/^\d+(\.\d+)?$/.test(s) || (s.split(".")[1]?.length ?? 0) > decimals) stop(`${field} is not an amount in the token's units`);
  return parseUnits(s, decimals);
}
function int(v, field) {
  if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= 0) && !(typeof v === "string" && /^\d{1,30}$/.test(v))) stop(`${field} is not a whole number`);
  return BigInt(v);
}
/** Unix seconds or an ISO 8601 date, as the API reads link times. */
function when(v, field) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : typeof v === "string" ? Math.floor(Date.parse(v) / 1000) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) stop(`${field} is not a time`);
  return n;
}

/** A step's arguments, its Base builder code taken off: what follows the arguments must be that code or nothing. */
function strip(chainId, data) {
  const d = data.toLowerCase();
  const tag = BUILDER_SUFFIX.slice(2);
  return chainId === 8453 && d.endsWith(tag) && d.length > 10 + tag.length ? `0x${d.slice(2, d.length - tag.length)}` : d;
}

/** `data` decoded with `abi`, and nothing else in it: encoding the decoded call again must give the same bytes. */
function exact(abi, data, where) {
  let call;
  try {
    call = decodeFunctionData({ abi, data });
  } catch {
    stop(`${where} calls a function this file does not allow`);
  }
  if (encodeFunctionData({ abi, functionName: call.functionName, args: call.args }).toLowerCase() !== data.toLowerCase()) {
    stop(`${where} carries bytes besides its arguments (and Base's builder code)`);
  }
  return call;
}

function exactParams(layout, data, where) {
  const params = parseAbiParameters(layout);
  let out;
  try {
    out = decodeAbiParameters(params, data);
  } catch {
    stop(`${where} does not decode`);
  }
  if (encodeAbiParameters(params, out).toLowerCase() !== data.toLowerCase()) stop(`${where} carries extra bytes`);
  return out;
}

/** A Slipstream or Uniswap v3 path's tokens: 20 bytes each, 3 between them (a tick spacing or a fee tier). */
function pathTokens(path, where) {
  const hex = path.slice(2);
  if (hex.length < 86 || (hex.length - 40) % 46 !== 0) stop(`${where}'s path is malformed`);
  const out = [];
  for (let i = 0; i < hex.length; i += 46) out.push(getAddress(`0x${hex.slice(i, i + 40)}`));
  return out;
}

/** Each step decoded: an exact approve on a token, or a call on a pinned contract, nothing else. */
function decodeStep(s, i, chainId) {
  const n = `step ${i + 1}`;
  if (s?.chainId !== chainId) stop(`${n} is for chain ${s?.chainId}, not ${CHAIN_NAME[chainId]} (${chainId})`);
  if (!isAddr(s.to) || typeof s.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(s.data)) stop(`${n} is malformed`);
  if (typeof s.value !== "string" || !/^\d+$/.test(s.value)) stop(`${n}'s value is not wei as a decimal string`);
  const value = BigInt(s.value);
  // the same amount in ETH, for a wallet that takes ETH (Bankr's agent): never a different number from the wei
  if (s.valueEth !== undefined && s.valueEth !== formatEther(value)) stop(`${n}'s valueEth is ${String(s.valueEth).slice(0, 40)}, not its value of ${formatEther(value)} ETH`);
  const data = strip(chainId, s.data);
  const name = nameOf(chainId, s.to);
  if (!name) {
    const { args: [spender, amount] } = exact(approveAbi, data, `${n} (on ${s.to})`);
    if (value !== 0n) stop(`${n} sends ETH with an approve`);
    const spenderName = nameOf(chainId, spender);
    if (!spenderName) stop(`${n} approves ${spender}, which is not a Gifted Stock contract`);
    return { n, kind: "approve", token: getAddress(s.to), spender: spenderName, amount, value };
  }
  const { functionName: fn, args } = exact(ABI_OF[chainId][name], data, `${n} (${name})`);
  return { n, kind: "call", name, to: getAddress(s.to), fn, args, value };
}

function call(s, names, fns, what) {
  if (!s || s.kind !== "call" || !names.includes(s.name) || !fns.includes(s.fn)) stop(`${s?.n ?? "a step"} is not ${what}`);
  return s;
}
function approval(s, token, spender, amount) {
  if (s.kind !== "approve") stop(`${s.n} is not an approval`);
  if (!same(s.token, token)) stop(`${s.n} approves ${s.token}, not ${token}`);
  if (s.spender !== spender) stop(`${s.n} approves ${s.spender}, not ${spender}`);
  if (s.amount !== amount) stop(`${s.n} approves ${s.amount}, and the step it is for takes ${amount}`);
}
function noEth(s) {
  if (s.value !== 0n) stop(`${s.n} sends ETH it has no use for`);
}
function steps(c, min, max) {
  if (c.steps.length < min || c.steps.length > max) stop(`${an(c.kind)} plan has ${min === max ? min : `${min} to ${max}`} step(s), this one ${c.steps.length}`);
}
function boxOf(c) {
  if (c.request.box !== "normal" && c.request.box !== "premium") stop("request.box is normal or premium");
  return c.request.box === "premium" ? "premiumBox" : "normalBox";
}
function sameIds(ids, asked, n) {
  if (!Array.isArray(asked) || !asked.length) stop("request.ids is missing");
  const a = asked.map((x) => String(int(x, "request.ids"))).sort();
  const b = ids.map(String).sort();
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) stop(`${n} names other boxes than the ones asked`);
}

/** An amount in words: the token's own decimals and symbol, read on the chain when a client can; else raw units. */
function wordsFor(pub, chainId) {
  const known = new Map();
  return async (token, amount) => {
    if (same(token, zeroAddress)) return `${formatUnits(amount, 18)} ETH`;
    if (same(token, MONEY[chainId].address)) return `${formatUnits(amount, 6)} ${MONEY[chainId].symbol}`;
    if (!pub) return `${amount} raw units of ${token}`;
    if (!known.has(token)) {
      const [d, s] = await Promise.all([
        pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
        pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => token),
      ]);
      known.set(token, [d, s]);
    }
    const [d, s] = known.get(token);
    return `${formatUnits(amount, d)} ${s}`;
  };
}

/** What a bridge pays on the other chain: ETH or that chain's money (USDC on Base, USDG on Robinhood Chain), nothing else. */
function bridgeTo(r, fromChainId) {
  const chainId = CHAIN_ID[r.to?.chain];
  if (!chainId || chainId === fromChainId) stop("a bridge goes to the other chain: request.to.chain is base or robinhood, not the one it leaves");
  const asked = r.to?.token;
  if (typeof asked !== "string" || !asked) stop("to names no token");
  if (/^eth$/i.test(asked) || same(asked, zeroAddress)) return { chain: r.to.chain, address: zeroAddress, decimals: 18, symbol: "ETH" };
  const m = MONEY[chainId];
  if (same(asked, m.symbol) || same(asked, m.address)) return { chain: r.to.chain, address: getAddress(m.address), decimals: 6, symbol: m.symbol };
  stop(`a bridge pays ETH or ${m.symbol} on ${CHAIN_NAME[chainId]}, not ${asked.slice(0, 60)}`);
}

/** The EIP-712 types of a Relay v1 order, as Relay's settlement SDK hashes it into the id its deposit carries
 *  (relayprotocol/relay-settlement, packages/sdk/src/order, `getOrderId`). */
/** The solver Relay's orders name (every quote on 27 Nov 2026, both chains, all four directions): another one goes to review. */
const RELAY_SOLVERS = ["0xf70da97812cb96acdf810712aa562db8dfa3dbef"];

const RELAY_ORDER_TYPES = {
  Order: [{ name: "version", type: "string" }, { name: "solverChainId", type: "string" }, { name: "solver", type: "address" }, { name: "salt", type: "uint256" }, { name: "inputs", type: "Input[]" }, { name: "output", type: "Output" }, { name: "fees", type: "Fee[]" }],
  Input: [{ name: "payment", type: "InputPayment" }, { name: "refunds", type: "InputRefund[]" }],
  InputPayment: [{ name: "chainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }, { name: "weight", type: "uint256" }],
  InputRefund: [{ name: "chainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" }, { name: "deadline", type: "uint32" }, { name: "extraData", type: "bytes" }],
  Output: [{ name: "chainId", type: "string" }, { name: "payments", type: "OutputPayment[]" }, { name: "deadline", type: "uint32" }, { name: "calls", type: "bytes[]" }, { name: "extraData", type: "bytes" }],
  OutputPayment: [{ name: "recipient", type: "bytes" }, { name: "currency", type: "bytes" }, { name: "minimumAmount", type: "uint256" }, { name: "expectedAmount", type: "uint256" }],
  Fee: [{ name: "recipientChainId", type: "string" }, { name: "recipient", type: "bytes" }, { name: "currencyChainId", type: "string" }, { name: "currency", type: "bytes" }, { name: "amount", type: "uint256" }],
};

/**
 * Relay's order behind a bridge's deposit (`summary.route.order`): it must hash to the deposit's id, take exactly the
 * deposit (this chain, token and amount), pay only `me` on the other chain in the token asked at least the summary's
 * minimum, carry no calls and refund only `me`, in what was sent or what was asked. Returns the least it pays and the
 * solver it names.
 */
function relayOrder(o, id, want, n) {
  if (!o || typeof o !== "object") stop(`${n}: the plan carries no Relay order (summary.route.order), so where the bridge pays can not be checked: do not send it`);
  if (o.version !== "v1") stop(`${n}: Relay's order is version ${String(o.version).slice(0, 20)}, which this file does not read`);
  const hex = (v, f) => {
    if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) stop(`Relay's order: ${f} is not hex`);
    return v.toLowerCase();
  };
  const num = (v, f) => {
    if (typeof v !== "string" || !/^(\d{1,78}|0x[0-9a-fA-F]{1,64})$/.test(v)) stop(`Relay's order: ${f} is not a number`);
    return BigInt(v);
  };
  const u32 = (v, f) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) stop(`Relay's order: ${f} is not a time`);
    return v;
  };
  const str = (v, f) => {
    if (typeof v !== "string") stop(`Relay's order: ${f} is missing`);
    return v;
  };
  const list = (v, f) => {
    if (!Array.isArray(v)) stop(`Relay's order: ${f} is not a list`);
    return v;
  };
  const out = o.output ?? {};
  const data = {
    version: "v1",
    solverChainId: str(o.solverChainId, "solverChainId"),
    solver: isAddr(o.solver) ? getAddress(o.solver) : stop("Relay's order: solver is not an address"),
    salt: num(o.salt, "salt"),
    inputs: list(o.inputs, "inputs").map((i) => ({
      payment: { chainId: str(i?.payment?.chainId, "payment.chainId"), currency: hex(i?.payment?.currency, "payment.currency"), amount: num(i?.payment?.amount, "payment.amount"), weight: num(i?.payment?.weight, "payment.weight") },
      refunds: list(i?.refunds, "refunds").map((x) => ({ chainId: str(x?.chainId, "refund.chainId"), recipient: hex(x?.recipient, "refund.recipient"), currency: hex(x?.currency, "refund.currency"), minimumAmount: num(x?.minimumAmount, "refund.minimumAmount"), deadline: u32(x?.deadline, "refund.deadline"), extraData: hex(x?.extraData, "refund.extraData") })),
    })),
    output: {
      chainId: str(out.chainId, "output.chainId"),
      payments: list(out.payments, "output.payments").map((p) => ({ recipient: hex(p?.recipient, "payment.recipient"), currency: hex(p?.currency, "payment.currency"), minimumAmount: num(p?.minimumAmount, "payment.minimumAmount"), expectedAmount: num(p?.expectedAmount, "payment.expectedAmount") })),
      deadline: u32(out.deadline, "output.deadline"),
      calls: list(out.calls, "output.calls").map((x) => hex(x, "output.calls")),
      extraData: hex(out.extraData, "output.extraData"),
    },
    fees: list(o.fees ?? [], "fees").map((f) => ({ recipientChainId: str(f?.recipientChainId, "fee.recipientChainId"), recipient: hex(f?.recipient, "fee.recipient"), currencyChainId: str(f?.currencyChainId, "fee.currencyChainId"), currency: hex(f?.currency, "fee.currency"), amount: num(f?.amount, "fee.amount") })),
  };
  if (!same(hashStruct({ types: RELAY_ORDER_TYPES, primaryType: "Order", data }), id)) stop(`${n} deposits for Relay order ${id}, and the order in the plan is another: do not send it`);
  // what it takes: exactly the deposit
  if (data.inputs.length !== 1) stop(`Relay's order takes ${data.inputs.length} payments, not the one deposit`);
  const [input] = data.inputs;
  if (input.payment.chainId !== want.from.chain || !same(input.payment.currency, want.from.address) || input.payment.amount !== want.amount) stop("Relay's order takes another chain, token or amount than the deposit");
  // where it refunds: only you, in what you sent or what you asked for
  for (const x of input.refunds) {
    if (!same(x.recipient, want.me)) stop(`Relay's order refunds ${x.recipient}, not your wallet`);
    const ok = (x.chainId === want.from.chain && same(x.currency, want.from.address)) || (x.chainId === want.to.chain && same(x.currency, want.to.address));
    if (!ok) stop(`Relay's order refunds in ${x.currency} on ${x.chainId}, not in what you sent or asked for`);
  }
  // what it pays: only you, on the chain and in the token asked, at least the summary's minimum, with no calls
  if (data.output.chainId !== want.to.chain) stop(`Relay's order pays on ${data.output.chainId}, not ${want.to.chain}`);
  if (data.output.calls.length) stop("Relay's order makes calls on the other chain");
  if (data.output.payments.length !== 1) stop(`Relay's order makes ${data.output.payments.length} payments, not one to your wallet`);
  const [p] = data.output.payments;
  if (!same(p.recipient, want.me)) stop(`Relay's order pays ${p.recipient}, not your wallet`);
  if (!same(p.currency, want.to.address)) stop(`Relay's order pays in ${p.currency}, not ${want.to.symbol}`);
  if (p.minimumAmount < want.min) stop(`Relay's order guarantees ${formatUnits(p.minimumAmount, want.to.decimals)} ${want.to.symbol}, under the summary's minimumOut`);
  return { min: p.minimumAmount, solver: data.solver };
}

/**
 * The token a request names: ETH and the chain's money by name, anything else by its address or by the symbol the
 * token itself answers on the chain. A token the API picked for a symbol goes to `review`: a look-alike can carry any
 * symbol, so check its address against a list you trust.
 */
async function tokenOf(c, asked, claimed, field) {
  const m = MONEY[c.chainId];
  if (typeof asked !== "string" || !asked) stop(`${field} names no token`);
  if (/^eth$/i.test(asked) || same(asked, zeroAddress)) return { address: zeroAddress, decimals: 18, symbol: "ETH", kind: "eth" };
  if (same(asked, m.symbol) || same(asked, m.address)) return { address: getAddress(m.address), decimals: 6, symbol: m.symbol, kind: "money" };
  const byAddress = isAddr(asked);
  if (byAddress && claimed && !same(claimed, asked)) stop(`${field}: the plan names ${claimed}, not ${asked}`);
  if (!byAddress && !isAddr(claimed)) stop(`${field}: the plan does not say which token ${asked} is`);
  const address = getAddress(byAddress ? asked : claimed);
  if (same(address, m.weth)) stop(`${field}: name ETH, not WETH`);
  const [decimals, symbol] = await Promise.all([
    c.pub.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    c.pub.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
  ]);
  // on Base a stock's ticker finds its tokenized stock ("NVDA" is NVDAc), as the API and a Swap tab link take it
  if (!byAddress && !same(symbol, asked) && !(c.chainId === 8453 && same(symbol, `${asked}c`))) stop(`${field}: ${address} is ${symbol}, not ${asked}`);
  if (!byAddress) c.review.push(`${field}: the API says ${asked} is ${address}: check it against a list you trust (Coinbase's tokenized stocks on Base, Robinhood's stock token registry on Robinhood Chain, a token's own site)`);
  return { address, decimals: Number(decimals), symbol, kind: "stock" };
}

/**
 * Checks `plan` (an answer of the agent API) for `wallet` against `request`, the body you sent: the plan must be what
 * that body asks for. `action` (optional) must agree with the body. `linkKeyAddress`: the address of a gift link's key
 * you made. `clients`: viem public clients by chain id (swaps, bridges, buys, settles and gifts need them).
 */
export async function verifyPlan(plan, { wallet, request, action, linkKeyAddress, clients, now = Math.floor(Date.now() / 1000) } = {}) {
  const out = { lines: [], review: [], unchecked: [], expect: null };
  try {
    if (!isAddr(wallet)) stop("give your wallet's address");
    const me = getAddress(wallet);
    if (!request || typeof request !== "object") stop("give the request body you sent: the plan is checked against it");
    const asked = actionOf(request);
    const kind = action ?? asked;
    if (!ACTIONS.includes(kind)) stop("the request body is not one this file knows");
    if (action && asked && action !== asked) stop(`the request body asks for ${an(asked)}, not ${an(action)}`);
    if (request.wallet !== undefined && !same(request.wallet, me)) stop("the request names another wallet");
    if (request.skill !== undefined && request.skill !== VERSION) stop(`the request names skill ${String(request.skill).slice(0, 20)}, and this file is ${VERSION}`);
    if (NEEDS_SKILL.has(kind) && request.skill !== VERSION) stop(`send "skill": "${VERSION}" with the request: without it the API answers as skill 1.2.0, through a router this file does not pin`);
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps) || plan.steps.length === 0) stop("the plan has no steps");
    if (plan.action !== kind) stop(`you asked for ${an(kind)} and the plan is ${an(String(plan.action))}`);
    // a launch's chain is the prize's; every other vault action names its own (never the plan's word: security review,
    // 27 Nov 2026)
    const chainName = kind === "swap" || kind === "bridge" ? request.from?.chain : kind.startsWith("gift") || kind === "basket_buy" ? "base"
      : kind === "campaign_launch" ? request.prize?.chain : kind === BASKET_CREATE ? "base" : request.chain;
    const chainId = CHAIN_ID[chainName];
    if (!chainId) stop("the request names no chain (base or robinhood)");
    if (plan.validUntil !== undefined && !(typeof plan.validUntil === "number" && Number.isSafeInteger(plan.validUntil))) stop("the plan's validUntil is not unix seconds");
    if (plan.validUntil !== undefined && !(plan.validUntil > now)) stop("the plan is past its validUntil: build it again");
    if (plan.validUntil !== undefined && plan.validUntil > now + 2 * 3_600) stop("the plan's validUntil is hours away: no plan lasts that long");
    if (plan.summary?.fee?.to !== undefined && !same(plan.summary.fee.to, FEE_WALLET)) stop(`the summary's fee goes to ${plan.summary.fee.to}, not the fee wallet`);
    const pub = clients?.[chainId];
    if (READS_CHAIN.has(kind) && !pub) stop(`${an(kind)} is checked against the chain: run with chain reads (drop --offline)`);
    const c = { kind, me, plan, request, chainId, pub, now, linkKeyAddress, out, review: out.review, lines: out.lines, unchecked: out.unchecked, words: wordsFor(pub, chainId) };
    c.steps = plan.steps.map((s, i) => decodeStep(s, i, chainId));
    await CHECKS[kind](c);
    return { ok: true, problems: [], ...out, unchecked: [...new Set(out.unchecked)] };
  } catch (e) {
    const problem = e instanceof Stop ? e.message : `the plan could not be checked: ${e?.shortMessage ?? e?.message ?? e}`;
    return { ok: false, problems: [problem], ...out };
  }
}

const CHECKS = {
  async buy(c) {
    const box = boxOf(c);
    const qty = int(c.request.quantity, "request.quantity");
    const pay = c.request.payWith ?? "ETH";
    const last = c.steps.at(-1);
    if (pay === "ETH") {
      steps(c, 1, 1);
      call(last, [box], ["mintWithEth"], `a buy of ${box} with ETH`);
      if (last.args[0] !== qty) stop(`${last.n} buys ${last.args[0]} boxes, not ${qty}`);
      // the box refunds what is over its price; more than 5% over today's quote is still no plan of ours
      const cost = await c.pub.readContract({ address: PINNED[c.chainId][box], abi: boxReadAbi, functionName: "mintPriceWei", args: [qty] });
      if (last.value > (cost * 105n) / 100n) stop(`${last.n} sends ${formatUnits(last.value, 18)} ETH, over 5% above the box's ${formatUnits(cost, 18)}`);
      c.lines.push(`${last.n}: buy ${qty} ${c.request.box} box${qty === 1n ? "" : "es"}, sending ${formatUnits(last.value, 18)} ETH (the box takes its price and sends the rest back)`);
      return;
    }
    if (pay !== MONEY[c.chainId].symbol) stop(`request.payWith is ETH or ${MONEY[c.chainId].symbol} on ${CHAIN_NAME[c.chainId]}`);
    steps(c, 1, 2);
    call(last, [box], ["mint"], `a buy of ${box} with ${pay}`);
    noEth(last);
    if (last.args[0] !== qty) stop(`${last.n} buys ${last.args[0]} boxes, not ${qty}`);
    const price = await c.pub.readContract({ address: PINNED[c.chainId][box], abi: boxReadAbi, functionName: "price" });
    if (c.steps.length === 2) {
      approval(c.steps[0], MONEY[c.chainId].address, box, price * qty);
      c.lines.push(`${c.steps[0].n}: approve exactly ${formatUnits(price * qty, 6)} ${pay} for the ${c.request.box} box`);
    }
    c.lines.push(`${last.n}: buy ${qty} ${c.request.box} box${qty === 1n ? "" : "es"} for ${formatUnits(price * qty, 6)} ${pay}`);
  },

  async open(c) {
    const box = boxOf(c);
    steps(c, 1, 1);
    const s = call(c.steps[0], [box], ["open"], `an open of ${box}`);
    if (c.request.ids !== undefined) sameIds(s.args[0], c.request.ids, s.n);
    else {
      // no ids asked: the API chose them, so each must be a distinct box this wallet holds (the box refuses one not
      // sealed); read on the chain, or left to your own look without chain reads
      const ids = s.args[0];
      if (!ids.length || ids.length > 200 || new Set(ids.map(String)).size !== ids.length) stop(`${s.n} opens ${ids.length} boxes, or some twice`);
      if (c.pub) {
        const owners = await Promise.all(ids.map((id) => c.pub.readContract({ address: PINNED[c.chainId][box], abi: boxReadAbi, functionName: "ownerOf", args: [id] })));
        const other = ids.find((id, i) => !same(owners[i], c.me));
        if (other !== undefined) stop(`${s.n} opens box ${other}, which is not in your wallet`);
      } else c.review.push(`the API chose boxes ${ids.join(", ")} to open: check they are yours to open`);
    }
    c.lines.push(`${s.n}: open boxes ${s.args[0].join(", ")}, sending ${formatUnits(s.value, 18)} ETH (the box takes its fee and sends the rest back)`);
  },

  async send(c) {
    const box = boxOf(c);
    steps(c, 1, 1);
    const s = call(c.steps[0], [box], ["sendCards"], `a send of ${box}`);
    noEth(s);
    sameIds(s.args[1], c.request.ids, s.n);
    const to = c.request.to;
    if (isAddr(to)) {
      if (!same(s.args[0], to)) stop(`${s.n} sends to ${s.args[0]}, not ${to}`);
    } else if (typeof to === "string" && to) {
      c.review.push(`${s.n} sends to ${s.args[0]}, which the API resolved from ${to.slice(0, 80)}: check it is the wallet meant`);
    } else stop("request.to is missing");
    c.lines.push(`${s.n}: send sealed boxes ${s.args[1].join(", ")} to ${s.args[0]}`);
  },

  async settle(c) {
    const box = boxOf(c);
    steps(c, 1, 1);
    const s = call(c.steps[0], [box], ["settle", "cancelStuck", "revealAndSettle"], `a settle of ${box}`);
    noEth(s);
    const id = int(c.request.id, "request.id");
    if (!s.args[1].includes(id)) stop(`${s.n} settles a batch without box ${id}`);
    const batch = await c.pub.readContract({ address: PINNED[c.chainId][box], abi: batchOwnerAbi, functionName: "batchOf", args: [s.args[0]] });
    if (!same(batch.owner, c.me)) stop(`${s.n} settles batch ${s.args[0]}, which another wallet opened`);
    c.lines.push(`${s.n}: ${s.fn === "cancelStuck" ? "return to sealed" : "settle"} batch ${s.args[0]} (boxes ${s.args[1].join(", ")})`);
  },

  async swap(c) {
    const r = c.request;
    const sm = c.plan.summary ?? {};
    const from = await tokenOf(c, r.from.token, sm.from?.address ?? null, "from");
    const to = await tokenOf(c, r.to.token, sm.to?.address ?? null, "to");
    if (from.address === to.address) stop("from and to are the same token");
    if (from.kind === "stock" && to.kind === "stock") stop("a stock token or a token trades against money or ETH, not against another");
    const amount = units(r.amount, from.decimals, "request.amount");
    if (amount === 0n) stop("request.amount is 0");
    const bps = from.kind === "stock" || to.kind === "stock" ? STOCK_FEE_BPS : MONEY_FEE_BPS;
    if (sm.fee?.bps !== undefined && BigInt(sm.fee.bps) !== bps) stop(`the summary's fee is ${sm.fee.bps} bps, and this swap's is ${bps}`);
    const minOut = units(sm.to?.minimumOut, to.decimals, "summary.to.minimumOut");
    if (minOut === 0n) stop("the summary's minimumOut is 0");
    if (c.plan.validUntil === undefined) stop("a swap plan has a validUntil");
    const t = { from, to, amount, bps, minOut, until: BigInt(c.plan.validUntil) };
    // on Base a token's Uniswap v4 route (AXIS) goes through the Uniswap router, as every Robinhood Chain swap does
    if (c.chainId === 8453 && c.steps.at(-1)?.name !== "uniswapRouter") baseSwap(c, t);
    else uniSwap(c, t);
    c.out.expect = { spend: [{ token: from.address, amount }], gain: [{ token: to.address, atLeast: minOut }] };
    c.lines.push(`in all: ${await c.words(from.address, amount)} for at least ${await c.words(to.address, minOut)} to your wallet, ${bps} bps to the fee wallet`);
    c.unchecked.push("whether the minimum is a fair price: compare summary.to.minimumOut with a price you trust");
  },

  async bridge(c) {
    const r = c.request;
    const from = await tokenOf(c, r.from.token, null, "from");
    if (from.kind === "stock") stop("a bridge moves USDC, USDG or ETH");
    const to = bridgeTo(r, c.chainId);
    const amount = units(r.amount, from.decimals, "request.amount");
    if (amount === 0n) stop("request.amount is 0");
    if (c.plan.validUntil === undefined) stop("a bridge plan has a validUntil");
    const last = c.steps.at(-1);
    let id;
    if (from.kind === "eth") {
      steps(c, 1, 1);
      call(last, ["relayDepository"], ["depositNative"], "a Relay deposit of ETH");
      if (!same(last.args[0], c.me)) stop(`${last.n} deposits for ${last.args[0]}, not your wallet`);
      if (last.value !== amount) stop(`${last.n} deposits ${formatUnits(last.value, 18)} ETH, not the ${r.amount} asked`);
      id = last.args[1];
    } else {
      steps(c, 1, 2);
      call(last, ["relayDepository"], ["depositErc20"], `a Relay deposit of ${from.symbol}`);
      noEth(last);
      const [depositor, token, amt] = last.args;
      if (!same(depositor, c.me)) stop(`${last.n} deposits for ${depositor}, not your wallet`);
      if (!same(token, from.address) || amt !== amount) stop(`${last.n} deposits other than the ${r.amount} ${from.symbol} asked`);
      if (c.steps.length === 2) {
        approval(c.steps[0], from.address, "relayDepository", amount);
        c.lines.push(`${c.steps[0].n}: approve exactly ${await c.words(from.address, amount)} for Relay's depository`);
      }
      id = last.args[3];
    }
    // the payout: the deposit's id is Relay's order's EIP-712 hash, so the order the plan carries is the one this deposit
    // funds, and it is checked here, not taken on Relay's or the API's word (Bankr review of BankrBot/skills#859, 27 Nov
    // 2026: before, only the deposit was checked and a plan whose deposit funded another order passed)
    const min = units(c.plan.summary?.to?.minimumOut, to.decimals, "summary.to.minimumOut");
    if (min === 0n) stop("the summary's minimumOut is 0");
    const { min: paid, solver } = relayOrder(c.plan.summary?.route?.order, id, { me: c.me, from: { chain: r.from.chain, address: from.address }, to, amount, min }, last.n);
    // the order's solver fills or refunds it: one Relay's quotes never name could refund nothing (its refunds' minimum is
    // 0), so it waits for your human (security review, 27 Nov 2026)
    if (!RELAY_SOLVERS.some((x) => same(x, solver))) c.review.push(`Relay's order names solver ${solver}, not the one Relay's quotes name: build the plan again, or check with Relay it is theirs`);
    c.out.expect = { spend: [{ token: from.address, amount }], gain: [] };
    c.lines.push(`${last.n}: deposit ${await c.words(from.address, amount)} with Relay for its order ${id}: at least ${formatUnits(paid, to.decimals)} ${to.symbol} to your wallet on ${CHAIN_NAME[CHAIN_ID[to.chain]]}, refunds only to your wallet`);
    c.unchecked.push("whether the minimum is a fair price: compare summary.to.minimumOut with a price you trust");
  },

  gift_create: (c) => gift(c, false),
  gift_link_create: (c) => gift(c, true),
  basket_buy: (c) => basket(c),

  // a new basket's first box: a gift to your own wallet of the items asked, the basket's tag as its note, no text on the
  // box, the app-fee slot the fee wallet's (you make it); the gift check itself, with that request
  async basket_create(c) {
    const r = c.request;
    const sb = c.plan.summary?.basket ?? {};
    if (typeof sb.code !== "string" || !/^(?=[a-z0-9]*\d)[a-z0-9]{5}$/.test(sb.code)) stop("the summary names no basket code");
    if (!same(sb.maker, c.me)) stop(`the summary names ${String(sb.maker).slice(0, 42)} as the new basket's maker, not your wallet`);
    if (sb.firstBox !== true) stop("the plan is not a new basket's first box");
    if (!Array.isArray(r.items) || r.items.length < 2 || r.items.length > 20) stop("a basket holds 2 to 20 tokens");
    const asked = { ...r, to: [c.me], note: `basket:${sb.code}`, design: c.plan.summary?.design };
    delete asked.name;
    const inner = { ...c, request: asked };
    await gift(inner, false);
    const last = c.steps.at(-1);
    if (titleOf(last.args[4].design)) stop(`${last.n} writes "${titleOf(last.args[4].design)}" on the box: a basket's box carries no text`);
    if (last.args[2] !== 1) stop(`${last.n} makes ${last.args[2]} boxes: a new basket's first box is one`);
    c.lines.push(`this is the first box of your new basket ${sb.code}${typeof r.name === "string" ? ` ("${clean(r.name, 24)}")` : ""}: it goes live with it at ${SITE}/basket/${sb.code}`);
  },

  async gift_claim(c) {
    steps(c, 1, 1);
    const s = call(c.steps[0], ["giftBox"], ["claim"], "a claim on the gift box");
    noEth(s);
    if (s.args[0] !== int(c.request.batchId, "request.batchId")) stop(`${s.n} claims from link ${s.args[0]}, not ${c.request.batchId}`);
    if (!same(s.args[1], c.request.signature)) stop(`${s.n} carries another link signature than yours`);
    c.lines.push(`${s.n}: claim a gift box from link ${s.args[0]}`);
  },

  async gift_open(c) {
    steps(c, 1, 1);
    const s = call(c.steps[0], ["giftBox"], ["open"], "an open of gift boxes");
    noEth(s);
    sameIds(s.args[0], c.request.ids, s.n);
    c.lines.push(`${s.n}: open gift boxes ${s.args[0].join(", ")}`);
  },

  async gift_take_back(c) {
    steps(c, 1, 1);
    const s = call(c.steps[0], ["giftBox"], ["reclaim"], "a take-back on the gift box");
    noEth(s);
    if (s.args[0] !== int(c.request.batchId, "request.batchId")) stop(`${s.n} takes back from link ${s.args[0]}, not ${c.request.batchId}`);
    if (!same(s.args[2], c.me)) stop(`${s.n} takes boxes back to ${s.args[2]}, not your wallet`);
    c.lines.push(`${s.n}: take back ${s.args[1]} unclaimed box(es) from link ${s.args[0]}`);
  },

  // ── the campaign vault (1.5.0) ─────────────────────────────────────────────────────────────────────────────────
  async partner_create(c) {
    const r = c.request;
    if (CHAIN_ID[r.chain] !== c.chainId) stop("request.chain is base or robinhood");
    const last = c.steps.at(-1);
    steps(c, 1, 2);
    if (c.steps.length === 2 && c.steps[0].kind !== "approve") stop(`${c.steps[0].n} is not an approval`);
    call(last, ["campaignVault"], ["createPartner"], "createPartner on the campaign vault");
    if (!same(last.args[0], c.me)) stop(`${last.n} makes a partner for ${last.args[0]}, not your wallet`);
    const [u, w] = await vaultRead(c, "partnerFeeQuote");
    await vaultPays(c, [{ s: last, pay: last.args[1], quote: { units: u, wei: w } }]);
    c.lines.push(`${last.n}: create your partner on the ${CHAIN_NAME[c.chainId]} campaign vault, run by your wallet${u ? `, the partner fee ${formatUnits(u, 6)} ${MONEY[c.chainId].symbol}${last.args[1].inEth ? " in ETH" : ""}` : ", no fee"}`);
  },

  async campaign_launch(c) {
    const p = c.request.prize;
    if (!p || typeof p !== "object") stop("request.prize is missing: { chain, box, boxes, perWinner, style } as you saved the campaign");
    const box = boxAddress(c, p.box, "request.prize.box");
    const boxes = int(p.boxes, "request.prize.boxes");
    const perWinner = int(p.perWinner, "request.prize.perWinner");
    if (p.style !== "raffle" && p.style !== "fcfs") stop('request.prize.style is "raffle" or "fcfs"');
    const style = p.style === "raffle" ? 1 : 0;
    const last = c.steps.at(-1);
    call(last, ["campaignVault"], ["launch", "buyAndLaunch"], "a launch on the campaign vault");
    const [t, n, pay] = last.args;
    if (!same(t.box, box)) stop(`${last.n} launches ${t.box}, not the ${p.box} box`);
    if (t.style !== style) stop(`${last.n} launches a ${t.style === 1 ? "raffle" : "first-come"} campaign, not ${p.style}`);
    if (BigInt(t.perWinner) !== perWinner) stop(`${last.n} gives ${t.perWinner} boxes a winner, not ${perWinner}`);
    if (BigInt(n) !== boxes) stop(`${last.n} launches ${n} boxes, not the ${boxes} of the prize`);
    if (t.partnerId !== askedId(c.request, "partnerId")) stop(`${last.n} launches for partner #${t.partnerId}, not #${c.request.partnerId}`);
    // the dates as saved: the end exactly, the start as saved or - one already past - the moment the plan was built
    const ends = Math.floor(Date.parse(p.endsAt) / 1000);
    const starts = Math.floor(Date.parse(p.startsAt) / 1000);
    if (!Number.isSafeInteger(ends) || !Number.isSafeInteger(starts)) stop("request.prize.startsAt and endsAt are the campaign's dates as saved (ISO 8601)");
    if (t.endsAt !== ends) stop(`${last.n}'s campaign ends ${new Date(t.endsAt * 1000).toISOString()}, not ${p.endsAt}`);
    if (t.startsAt < starts || t.startsAt > Math.max(starts, c.now + 600)) stop(`${last.n}'s campaign starts ${new Date(t.startsAt * 1000).toISOString()}, not as saved (${p.startsAt})`);
    if (!(t.endsAt > c.now)) stop(`${last.n}'s campaign has already ended`);
    if (!(t.startsAt < t.endsAt)) stop(`${last.n}'s campaign starts after it ends`);
    // the window itself, as the site keeps it (a start can be any time ahead: bug review, 27 Nov 2026)
    if (t.endsAt - Math.max(t.startsAt, c.now) > 30 * DAY + 3_600) stop(`${last.n}'s campaign runs over 30 days`);
    const who = await runsPartner(c, t.partnerId, last.n);
    // what the launch takes from the pool and what is bought for it: buys into this partner's pool of this box, 200 a call
    const buys = c.steps.slice(0, -1).filter((s) => s.kind === "call");
    const approve = c.steps.slice(0, -1).filter((s) => s.kind === "approve");
    if (approve.length > 1 || (approve.length && c.steps[0] !== approve[0])) stop("a launch has one approval at most, first");
    let bought = 0n;
    const quoted = [];
    for (const b of buys) {
      call(b, ["campaignVault"], ["buy"], "a buy into your pool");
      if (b.args[0] !== t.partnerId || !same(b.args[1], box)) stop(`${b.n} buys into another partner's pool or another box`);
      if (b.args[2] < 1 || b.args[2] > 200) stop(`${b.n} buys ${b.args[2]} boxes: one call buys 1 to 200`);
      bought += BigInt(b.args[2]);
      const [u, w] = await vaultRead(c, "buyQuote", [box, BigInt(b.args[2])]);
      quoted.push({ s: b, pay: b.args[3], quote: { units: u, wei: w } });
    }
    if (bought > boxes) stop(`the plan buys ${bought} boxes for a prize of ${boxes}`);
    if (last.fn === "buyAndLaunch") {
      if (buys.length) stop(`${last.n} buys its boxes itself: no buys before it`);
      const [bu, bw] = await vaultRead(c, "buyQuote", [box, BigInt(n)]);
      const [fu, fw] = await vaultRead(c, "campaignFeeQuote", [box, BigInt(n)]);
      quoted.push({ s: last, pay, quote: { units: bu + fu, wei: bw + fw } });
    } else {
      const [fu, fw] = await vaultRead(c, "campaignFeeQuote", [box, BigInt(n)]);
      quoted.push({ s: last, pay, quote: { units: fu, wei: fw } });
    }
    await vaultPays(c, quoted);
    const fresh = last.fn === "buyAndLaunch" ? BigInt(n) : bought;
    c.lines.push(`${last.n}: launch a ${p.style === "raffle" ? "raffle" : "first-come"} campaign of ${n} ${p.box} boxes, ${t.perWinner} a winner, ${new Date(t.startsAt * 1000).toISOString()} to ${new Date(t.endsAt * 1000).toISOString()}, for partner #${t.partnerId} (${who}); ${fresh} bought, ${BigInt(n) - fresh} from your pool`);
    c.unchecked.push("the campaign's name, text and tasks: they live on the site, not on the chain (GET your campaign to read them)");
    c.unchecked.push("the launch's ref, which ties it to the campaign on the site: if the site does not count the launch, ask us - never launch it again");
  },

  async campaign_raise(c) {
    const more = int(c.request.winners, "request.winners");
    const last = c.steps.at(-1);
    call(last, ["campaignVault"], ["raise", "buyAndRaise"], "a raise on the campaign vault");
    const [id, n, pay] = last.args;
    if (id !== askedId(c.request, "campaignId")) stop(`${last.n} raises campaign ${id}, not #${c.request.campaignId}`);
    const k = await vaultRead(c, "campaign", [id]);
    if (k.partnerId === 0n) stop(`${last.n} raises campaign ${id}, which is not on this vault`);
    if (k.partnerId !== askedId(c.request, "partnerId")) stop(`${last.n} raises a campaign of partner #${k.partnerId}, not #${c.request.partnerId}`);
    const who = await runsPartner(c, k.partnerId, last.n);
    if (BigInt(n) !== more * BigInt(k.perWinner)) stop(`${last.n} adds ${n} boxes, not ${more} winner(s) of ${k.perWinner}`);
    const box = k.box;
    const buys = c.steps.slice(0, -1).filter((s) => s.kind === "call");
    const approve = c.steps.slice(0, -1).filter((s) => s.kind === "approve");
    if (approve.length > 1 || (approve.length && c.steps[0] !== approve[0])) stop("a raise has one approval at most, first");
    let bought = 0n;
    const quoted = [];
    for (const b of buys) {
      call(b, ["campaignVault"], ["buy"], "a buy into your pool");
      if (b.args[0] !== k.partnerId || !same(b.args[1], box)) stop(`${b.n} buys into another partner's pool or another box`);
      if (b.args[2] < 1 || b.args[2] > 200) stop(`${b.n} buys ${b.args[2]} boxes: one call buys 1 to 200`);
      bought += BigInt(b.args[2]);
      const [u, w] = await vaultRead(c, "buyQuote", [box, BigInt(b.args[2])]);
      quoted.push({ s: b, pay: b.args[3], quote: { units: u, wei: w } });
    }
    if (bought > BigInt(n)) stop(`the plan buys ${bought} boxes for a raise of ${n}`);
    if (last.fn === "buyAndRaise") {
      if (buys.length) stop(`${last.n} buys its boxes itself: no buys before it`);
      const [bu, bw] = await vaultRead(c, "buyQuote", [box, BigInt(n)]);
      const [fu, fw] = await vaultRead(c, "campaignFeeQuote", [box, BigInt(n)]);
      quoted.push({ s: last, pay, quote: { units: bu + fu, wei: bw + fw } });
    } else {
      const [fu, fw] = await vaultRead(c, "campaignFeeQuote", [box, BigInt(n)]);
      quoted.push({ s: last, pay, quote: { units: fu, wei: fw } });
    }
    await vaultPays(c, quoted);
    c.lines.push(`${last.n}: add ${more} winner(s), ${n} boxes, to campaign ${id} of partner #${k.partnerId} (${who})`);
  },

  async campaign_cancel(c) {
    steps(c, 1, 1);
    const s = call(c.steps[0], ["campaignVault"], ["cancel"], "a cancel on the campaign vault");
    noEth(s);
    const [id, max] = s.args;
    if (max !== 0) stop(`${s.n} cancels only part of campaign ${id}`);
    if (id !== askedId(c.request, "campaignId")) stop(`${s.n} cancels campaign ${id}, not #${c.request.campaignId}`);
    const k = await vaultRead(c, "campaign", [id]);
    if (k.partnerId === 0n) stop(`${s.n} cancels campaign ${id}, which is not on this vault`);
    if (k.partnerId !== askedId(c.request, "partnerId")) stop(`${s.n} cancels a campaign of partner #${k.partnerId}, not #${c.request.partnerId}`);
    if ((await runsPartner(c, k.partnerId, s.n)) !== "yours") stop(`${s.n} cancels a campaign of partner #${k.partnerId}, which your wallet does not own`);
    c.lines.push(`${s.n}: cancel campaign ${id} of your partner #${k.partnerId}: its ${k.boxes} boxes go back to your pool`);
  },

  async campaign_claim(c) {
    const asked = askedId(c.request, "campaignId");
    let total = 0n;
    for (const s of c.steps) {
      call(s, ["campaignVault"], ["claimFirstCome", "claimRaffle"], "a claim on the campaign vault");
      noEth(s);
      const id = s.args[0];
      const to = s.args.at(-1);
      const max = s.args.at(-2);
      if (id !== asked) stop(`${s.n} claims from campaign ${id}, not #${c.request.campaignId}`);
      if (!same(to, zeroAddress) && !same(to, c.me)) stop(`${s.n} sends the boxes to ${to}, not your wallet`);
      if (max < 1 || max > 200) stop(`${s.n} claims ${max} boxes: one call takes 1 to 200`);
      total += BigInt(max);
    }
    const k = await vaultRead(c, "campaign", [asked]);
    if (k.partnerId === 0n) stop(`campaign ${asked} is not on this vault`);
    c.lines.push(`claim up to ${total} box${total === 1n ? "" : "es"} of campaign ${asked} on ${CHAIN_NAME[c.chainId]} to your wallet; nothing is paid but gas`);
  },

  async pool_withdraw(c) {
    const r = c.request;
    if (CHAIN_ID[r.chain] !== c.chainId) stop("request.chain is base or robinhood");
    const box = boxAddress(c, r.box, "request.box");
    const count = int(r.count, "request.count");
    let id = null;
    let total = 0n;
    for (const s of c.steps) {
      call(s, ["campaignVault"], ["withdraw"], "a take-back from your pool");
      noEth(s);
      const [pid, b, k, to] = s.args;
      if (id !== null && pid !== id) stop(`${s.n} takes from another partner's pool`);
      id = pid;
      if (!same(b, box)) stop(`${s.n} takes ${b}, not the ${r.box} box`);
      if (!same(to, c.me)) stop(`${s.n} sends the boxes to ${to}, not your wallet`);
      if (k < 1 || k > 200) stop(`${s.n} takes ${k} boxes: one call takes 1 to 200`);
      total += BigInt(k);
    }
    if (total !== count) stop(`the plan takes ${total} boxes back, not ${count}`);
    if (id !== askedId(r, "partnerId")) stop(`the plan takes boxes from partner #${id}'s pool, not #${r.partnerId}`);
    if ((await runsPartner(c, id, "the plan")) !== "yours") stop(`partner #${id} is not your wallet's: only its owner takes boxes back`);
    c.lines.push(`take ${count} ${r.box} boxes from your partner #${id}'s pool back to your wallet`);
  },

  async partner_manager(c) {
    const r = c.request;
    if (CHAIN_ID[r.chain] !== c.chainId) stop("request.chain is base or robinhood");
    steps(c, 1, 1);
    const s = call(c.steps[0], ["campaignVault"], ["setPartnerManager"], "setPartnerManager on the campaign vault");
    noEth(s);
    const [id, wallet, on] = s.args;
    if (id !== askedId(r, "partnerId")) stop(`${s.n} is for partner #${id}, not #${r.partnerId}`);
    if (!isAddr(r.manager) || !same(wallet, r.manager)) stop(`${s.n} names ${wallet}, not the manager asked`);
    if (on !== r.on) stop(`${s.n} ${on ? "names" : "removes"} the manager, not what was asked`);
    if ((await runsPartner(c, id, s.n)) !== "yours") stop(`partner #${id} is not your wallet's: only its owner names managers`);
    c.lines.push(`${s.n}: ${on ? "name" : "remove"} ${wallet} as a manager of your partner #${id}`);
  },
};

/**
 * The vault ids a request names, as the chain gave them to you (security review, 27 Nov 2026: a plan for another partner
 * your wallet merely manages, or another campaign of yours, passed): `partnerId` from your createPartner receipt's
 * PartnerCreated (or the partner's vault page), `campaignId` from the launch receipt's CampaignLaunched.
 */
function askedId(r, field) {
  const v = r?.[field];
  if (v === undefined || v === null || v === "") stop(`request.${field} is missing: the vault id as your receipt gave it`);
  return int(v, `request.${field}`);
}

/** A view of the campaign vault on the plan's chain. */
const vaultRead = (c, functionName, args = []) => c.pub.readContract({ address: PINNED[c.chainId].campaignVault, abi: vaultReadAbi, functionName, args });

/** The box contract a request names ("normal" or "premium") on the plan's chain: the vault holds the same four boxes. */
function boxAddress(c, asked, field) {
  if (asked !== "normal" && asked !== "premium") stop(`${field} is "normal" or "premium"`);
  return PINNED[c.chainId][asked === "premium" ? "premiumBox" : "normalBox"];
}

/** Whether your wallet runs partner `id` on this chain: "yours" (its owner) or "you manage it"; anything else stops. */
async function runsPartner(c, id, n) {
  const p = await vaultRead(c, "partnerOf", [id]);
  if (same(p.owner, c.me)) return "yours";
  if (await vaultRead(c, "isPartnerManager", [id, c.me])) return "you manage it";
  stop(`${n} is for partner #${id}, which your wallet neither owns nor manages on ${CHAIN_NAME[c.chainId]}`);
}

/**
 * Each vault call's payment against the vault's own quote read now: in the chain's dollar, maxUsdc no more than the quote
 * (and 1% for a box price the owner moves) and no ETH sent, all of them covered by one exact approval first; in ETH,
 * the value no more than the quote's ETH and 3% (the plan adds 1%, the price moves; the vault sends the change back).
 * No permit, ever.
 */
async function vaultPays(c, quoted) {
  const m = MONEY[c.chainId];
  // paid as asked: ETH when the request says ETH, else the chain's dollar
  const inEth = typeof c.request.payWith === "string" && c.request.payWith.trim().toUpperCase() === "ETH";
  let dollars = 0n;
  for (const { s, pay, quote } of quoted) {
    if (pay.inEth !== inEth && (pay.maxUsdc > 0n || s.value > 0n)) stop(`${s.n} pays in ${pay.inEth ? "ETH" : m.symbol}, not what the request asked`);
    if (pay.permitDeadline !== 0n || pay.permitSig !== "0x") stop(`${s.n} carries a permit: plans approve exactly instead`);
    if (pay.maxUsdc > (quote.units * 101n) / 100n) stop(`${s.n} lets the vault take up to ${formatUnits(pay.maxUsdc, 6)} ${m.symbol}, over its quote of ${formatUnits(quote.units, 6)}`);
    if (pay.inEth) {
      if (s.value > (quote.wei * 103n) / 100n) stop(`${s.n} sends ${formatUnits(s.value, 18)} ETH, over 3% above the vault's quote of ${formatUnits(quote.wei, 18)}`);
    } else {
      noEth(s);
      dollars += pay.maxUsdc;
    }
  }
  const approvals = c.steps.filter((s) => s.kind === "approve");
  if (dollars === 0n) {
    if (approvals.length) stop(`${approvals[0].n} approves ${m.symbol} for a plan that pays none`);
    return;
  }
  // an approval only when the wallet's own is short: one, first, exactly what the calls may take
  if (approvals.length > 1) stop("the plan has more than one approval");
  if (approvals.length) {
    approval(approvals[0], getAddress(m.address), "campaignVault", dollars);
    c.lines.push(`${approvals[0].n}: approve exactly ${formatUnits(dollars, 6)} ${m.symbol} for the campaign vault`);
  } else {
    const allowance = await c.pub.readContract({ address: getAddress(m.address), abi: erc20Abi, functionName: "allowance", args: [c.me, PINNED[c.chainId].campaignVault] });
    if (allowance < dollars) stop(`the vault may take ${formatUnits(dollars, 6)} ${m.symbol} and the plan approves none of it`);
  }
}

/** A Base swap: an exact approval for the router (unless ETH goes in), then multicall: one swap that pays the router
 *  itself, then one fee sweep that pays you, then refundETH when ETH went in. On Aerodrome's or Aero's router
 *  `multicall(data)`; on Uniswap's SwapRouter02 (a token's swap) `multicall(deadline, data)`, its exactInput without one. */
function baseSwap(c, { from, to, amount, bps, minOut, until }) {
  const { weth, address: usdc } = MONEY[8453];
  const ethIn = from.kind === "eth";
  const ethOut = to.kind === "eth";
  const last = call(c.steps.at(-1), ["aerodromeRouter", "aeroRouter", "uniswapRouter02"], ["multicall"], "a swap on a Base router");
  const uni = last.name === "uniswapRouter02";
  const [outerDeadline, inner] = uni ? last.args : [null, last.args[0]];
  if (uni && outerDeadline > until) stop(`${last.n}'s deadline is after the plan's validUntil`);
  if (ethIn) {
    steps(c, 1, 1);
    if (last.value !== amount) stop(`${last.n} sends ${formatUnits(last.value, 18)} ETH, not the ${formatUnits(amount, 18)} asked`);
  } else {
    steps(c, 1, 2);
    noEth(last);
    if (c.steps.length === 2) approval(c.steps[0], from.address, last.name, amount);
  }
  const calls = inner.map((raw, j) => exact(uni ? router02InnerAbi : routerInnerAbi, raw, `${last.n}, call ${j + 1} inside multicall`));
  if (calls.length !== (ethIn ? 3 : 2)) stop(`${last.n} carries ${calls.length} calls inside multicall, not ${ethIn ? 3 : 2}`);
  const [swap, payout, refund] = calls;
  const inToken = ethIn ? weth : from.address;
  const outToken = ethOut ? weth : to.address;
  const where = `${last.n}, call 1 inside multicall`;
  const p = swap.args[0];
  if (swap.functionName === "exactInputSingle") {
    if (!same(p.tokenIn, inToken) || !same(p.tokenOut, outToken)) stop(`${where} swaps ${p.tokenIn} for ${p.tokenOut}, not what was asked`);
    if (p.sqrtPriceLimitX96 !== 0n) stop(`${where} sets a price limit`);
  } else if (swap.functionName === "exactInput") {
    const tokens = pathTokens(p.path, where);
    if (!same(tokens[0], inToken) || !same(tokens.at(-1), outToken)) stop(`${where} swaps ${tokens[0]} for ${tokens.at(-1)}, not what was asked`);
    // two pools at most, through USDC or WETH (a token's route), never back through either end
    const mid = tokens.slice(1, -1);
    if (tokens.length > 3 || mid.some((x) => !(same(x, usdc) || same(x, weth)) || same(x, inToken) || same(x, outToken))) stop(`${where} routes through a token other than USDC or WETH`);
  } else stop(`${where} is not a swap`);
  if (!same(p.recipient, last.to)) stop(`${where} sends the swap's output to ${p.recipient}, not the router itself`);
  if (p.amountIn !== amount) stop(`${where} swaps ${p.amountIn}, not the ${amount} asked`);
  if (!uni && p.deadline > until) stop(`${where}'s deadline is after the plan's validUntil`);
  const pw = `${last.n}, call 2 inside multicall`;
  let min, recipient, fee, feeTo;
  if (ethOut) {
    if (payout.functionName !== "unwrapWETH9WithFee") stop(`${pw} does not pay you the ETH`);
    [min, recipient, fee, feeTo] = payout.args;
  } else {
    if (payout.functionName !== "sweepTokenWithFee") stop(`${pw} does not pay you the token`);
    if (!same(payout.args[0], to.address)) stop(`${pw} pays out ${payout.args[0]}, not what the swap brings`);
    [, min, recipient, fee, feeTo] = payout.args;
  }
  if (!same(recipient, c.me)) stop(`${pw} pays ${recipient}, not your wallet`);
  if (!same(feeTo, FEE_WALLET)) stop(`${pw} sends the fee to ${feeTo}, not the fee wallet`);
  if (fee !== bps) stop(`${pw} takes ${fee} bps, and this swap's fee is ${bps}`);
  if (min === 0n || min - (min * fee) / 10_000n !== minOut) stop(`${pw} pays at least ${min - (min * fee) / 10_000n}, and the summary shows ${minOut}`);
  if (ethIn && refund.functionName !== "refundETH") stop(`${last.n}, call 3 inside multicall is not refundETH`);
  if (c.steps.length === 2) c.lines.push(`${c.steps[0].n}: approve exactly the amount asked for ${last.name}`);
  c.lines.push(`${last.n}: swap through ${last.name}: one swap into the router, then one sweep to your wallet with the fee to the fee wallet`);
}

/** A swap through the Uniswap router (every Robinhood Chain swap; on Base a token's Uniswap v4 route, AXIS): an exact
 *  approval for Permit2 and Permit2's for that chain's Uniswap router (unless ETH goes in or they stand already), then
 *  execute: one or two hops into the router itself, the amount asked on the first and all the router holds after,
 *  through the chain's money only (USDG, USDC), v4 pools with no hook or one of HOOKED_POOLS, then the fee to the fee
 *  wallet, then SWEEP to you. */
function uniSwap(c, { from, to, amount, bps, minOut, until }) {
  const { weth, address: usdg, symbol: moneySymbol } = MONEY[c.chainId];
  const router = PINNED[c.chainId].uniswapRouter;
  const ethIn = from.kind === "eth";
  const last = call(c.steps.at(-1), ["uniswapRouter"], ["execute"], "a swap on the Uniswap router");
  const [commands, inputs, deadline] = last.args;
  if (deadline > until) stop(`${last.n}'s deadline is after the plan's validUntil`);
  if (ethIn) {
    steps(c, 1, 1);
    if (last.value !== amount) stop(`${last.n} sends ${formatUnits(last.value, 18)} ETH, not the ${formatUnits(amount, 18)} asked`);
  } else {
    steps(c, 1, 3);
    noEth(last);
    const before = c.steps.slice(0, -1);
    before.forEach((s, k) => {
      if (s.kind === "approve") {
        if (k !== 0) stop(`${s.n} approves after Permit2's approval`);
        approval(s, from.address, "permit2", amount);
        c.lines.push(`${s.n}: approve exactly the amount asked for Permit2`);
      } else {
        call(s, ["permit2"], ["approve"], "Permit2's approval for the Uniswap router");
        noEth(s);
        if (before.filter((x) => x.kind === "call").length > 1) stop(`${s.n} is a second Permit2 approval`);
        const [token, spender, amt, expiration] = s.args;
        if (!same(token, from.address) || !same(spender, router) || amt !== amount) stop(`${s.n} gives Permit2 rights other than the amount asked, to Uniswap's router`);
        if (BigInt(expiration) > deadline) stop(`${s.n}'s Permit2 rights outlast the swap's deadline`);
        c.lines.push(`${s.n}: let Uniswap's router take exactly the amount asked through Permit2, until the swap's deadline`);
      }
    });
  }
  const cmds = hexBytes(commands);
  if (cmds.length !== inputs.length || cmds.length < 3 || cmds.length > 9) stop(`${last.n} has ${cmds.length} commands and ${inputs.length} inputs`);
  let cur = ethIn ? zeroAddress : from.address; // what the router holds: ETH (0x0), WETH or a token
  let hop = 0;
  let fee = null;
  for (const [j, cmd] of cmds.entries()) {
    const where = `${last.n}, command ${j + 1} (0x${cmd.toString(16).padStart(2, "0")})`;
    const spec = CMD[cmd];
    if (!spec) stop(`${where} is not a command a plan uses`);
    const a = exactParams(spec.layout, inputs[j], where);
    const tail = cmds.length - j; // 2: the fee's place, 1: the payout's
    if ((cmd === 0x06) !== (tail === 2) || (cmd === 0x04) !== (tail === 1)) stop(`${last.n} does not end with the fee (PAY_PORTION), then your payout (SWEEP)`);
    const first = hop === 0;
    if (cmd === 0x0b) {
      if (!same(cur, zeroAddress) || !same(a[0], ROUTER_ITSELF) || a[1] !== (first ? amount : ALL)) stop(`${where} wraps other than the ETH held, into the router itself`);
      cur = weth;
    } else if (cmd === 0x0c) {
      if (!same(cur, weth) || !same(a[0], ROUTER_ITSELF) || a[1] !== 0n) stop(`${where} unwraps other than the WETH held, into the router itself`);
      cur = zeroAddress;
    } else if (cmd === 0x00) {
      const [recipient, amtIn, , path, payerIsUser, floors] = a;
      const tokens = pathTokens(path, where);
      if (tokens.length !== 2 || !same(tokens[0], cur)) stop(`${where} swaps other than what the router holds, in one pool`);
      if (!same(recipient, ROUTER_ITSELF)) stop(`${where} sends to ${recipient}, not the router itself`);
      if (amtIn !== (first ? amount : ALL) || payerIsUser !== (first && !ethIn) || floors.length) stop(`${where} swaps other than ${first ? "the amount asked" : "all the router holds"}`);
      cur = tokens[1];
      hop++;
    } else if (cmd === 0x10) {
      const [actions, params] = a;
      if (actions.toLowerCase() !== V4_ACTIONS || params.length !== 3) stop(`${where} is not one v4 hop (SETTLE, SWAP, TAKE)`);
      const [currency, amt, payerIsUser] = exactParams(V4.settle, params[0], `${where}, SETTLE`);
      const [[key, zeroForOne, amountIn, , , hookData]] = exactParams(V4.swap, params[1], `${where}, SWAP`);
      const [c0, c1, poolFee, spacing, hooks] = key;
      const [taken, takeTo, takeAmt] = exactParams(V4.take, params[2], `${where}, TAKE`);
      if (same(cur, weth) || !same(currency, cur) || amt !== (first ? amount : ALL) || payerIsUser !== (first && !ethIn)) stop(`${where} pays in other than ${first ? "the amount asked" : "all the router holds"}`);
      const allowedHook = HOOKED_POOLS[c.chainId].some(([a0, a1, f, t, h]) => same(c0, a0) && same(c1, a1) && poolFee === f && spacing === t && same(hooks, h));
      if ((!same(hooks, zeroAddress) && !allowedHook) || hookData !== "0x") stop(`${where} trades through a pool with a hook`);
      if (!same(zeroForOne ? c0 : c1, currency) || amountIn !== 0n) stop(`${where} swaps other than what it paid in`);
      if (!same(taken, zeroForOne ? c1 : c0) || !same(takeTo, ROUTER_ITSELF) || takeAmt !== 0n) stop(`${where} takes other than the swap's whole output into the router itself`);
      cur = taken;
      hop++;
    } else if (cmd === 0x06) {
      const [token, recipient, bips] = a;
      if (!same(token, cur) || !same(token, to.kind === "eth" ? zeroAddress : to.address)) stop(`${where} takes the fee in other than what the swap brings`);
      if (!same(recipient, FEE_WALLET)) stop(`${where} sends the fee to ${recipient}, not the fee wallet`);
      if (bips !== bps) stop(`${where} takes ${bips} bps, and this swap's fee is ${bps}`);
      fee = token;
    } else if (cmd === 0x04) {
      const [token, recipient, min] = a;
      if (!same(token, fee)) stop(`${where} pays out another token than the fee is taken in`);
      if (!same(recipient, c.me)) stop(`${where} pays ${recipient}, not your wallet`);
      if (min !== minOut || min === 0n) stop(`${where} pays at least ${min}, and the summary shows ${minOut}`);
    }
    // between two hops the router holds USDG (or ETH as WETH or 0x0 around a wrap)
    if ((cmd === 0x00 || cmd === 0x10) && hop === 1 && cmds.slice(j + 1).some((x) => x === 0x00 || x === 0x10)) {
      if (!same(cur, usdg)) stop(`${where} routes through a token other than ${moneySymbol}`);
    }
  }
  if (hop < 1 || hop > 2) stop(`${last.n} has ${hop} hops, not one or two`);
  c.lines.push(`${last.n}: swap through Uniswap: ${hop} hop${hop === 1 ? "" : "s"} into the router itself, then the fee to the fee wallet and SWEEP to your wallet`);
}

/** The root of a gift link's wallet list, as the gift box checks a claim against it (OpenZeppelin's sorted pairs). */
export function listRoot(wallets) {
  const unique = [...new Set(wallets.map((w) => {
    if (!isAddr(w)) stop("request.link.list holds something that is not an address");
    return w.toLowerCase();
  }))];
  let layer = unique.map((w) => keccak256(keccak256(`0x000000000000000000000000${w.slice(2)}`))).sort();
  if (!layer.length) stop("request.link.list is empty");
  while (layer.length > 1) {
    const up = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 >= layer.length) up.push(layer[i]);
      else up.push(layer[i] < layer[i + 1] ? keccak256(concat([layer[i], layer[i + 1]])) : keccak256(concat([layer[i + 1], layer[i]])));
    }
    layer = up;
  }
  return layer[0];
}

const SITE = "https://www.giftedstock.com";
/** A basket's code: five lowercase letters and digits, one digit at least. */
const BASKET_CODE = /^(?=[a-z0-9]*\d)[a-z0-9]{5}$/;

/** The gift box's fee now, and the app-fee slot's share of TOTAL_FEE_BPS it leaves: what a gift pays on top. */
async function feesNow(c) {
  const [, feeBps] = await c.pub.readContract({ address: PINNED[8453].giftBox, abi: giftSettingsAbi, functionName: "settings" });
  const fee = BigInt(feeBps);
  return { fee, slot: fee < TOTAL_FEE_BPS ? TOTAL_FEE_BPS - fee : 0n };
}

/**
 * Who takes the app-fee slot: the fee wallet, or - `maker` named, a basket bought - that maker. Exactly the share of
 * TOTAL_FEE_BPS the gift box's fee leaves, never more: 2.5% on top in all. Returns "the fee wallet", "maker" or null (no
 * slot, while the gift box's own fee is 2.5%).
 */
function slotOf(opt, { fee, slot }, n, maker) {
  if (BigInt(opt.maxFeeBps) !== fee) stop(`${n} allows a fee of ${opt.maxFeeBps} bps, and the gift box's is ${fee}`);
  if (BigInt(opt.frontendBps) !== slot) stop(`${n} pays an app fee of ${opt.frontendBps} bps, and with the gift box's ${fee} bps it is ${slot}: ${Number(TOTAL_FEE_BPS) / 100}% on top in all`);
  if (slot === 0n) {
    if (!same(opt.frontend, zeroAddress)) stop(`${n} names an app fee wallet, ${opt.frontend}, with no app fee`);
    return null;
  }
  if (same(opt.frontend, FEE_WALLET)) return "the fee wallet";
  if (maker && same(opt.frontend, maker)) return "maker";
  stop(`${n} pays the app fee to ${opt.frontend}, not the fee wallet${maker ? " or the basket's maker" : ""}`);
}

/** What `amount` in each of `nb` boxes costs with both fees on it, each rounded up, as the gift box takes them. */
const needOf = (amount, nb, { fee, slot }) => amount * nb + (amount * nb * fee + 9_999n) / 10_000n + (amount * nb * slot + 9_999n) / 10_000n;

/** ETH's price at Base's Chainlink feed, 8 decimals, its age on the chain's own clock: over an hour old, or none, stops -
 *  an ETH payment can't be checked without it. */
async function ethPrice(c) {
  if (c.eth8 !== undefined) return c.eth8;
  const [[, answer, , updatedAt], head] = await Promise.all([
    c.pub.readContract({ address: ETH_USD_FEED, abi: feedAbi, functionName: "latestRoundData" }),
    c.pub.getBlock(),
  ]);
  if (!(answer > 0n) || Number(head.timestamp) - Number(updatedAt) > 3_600) stop("ETH's Chainlink price on Base is missing or over an hour old, so a payment in ETH can't be checked now: pay with USDC or try later");
  c.eth8 = answer;
  return answer;
}

/** Text from the API in a line this file prints: the characters a name may hold, at most `max` of them. */
const clean = (v, max) => String(v ?? "").replace(/[^A-Za-z0-9 .,!?'&-]/g, "").slice(0, max);
/** A box design's title (bytes 13 to 28 of its word), cleaned. */
const titleOf = (design) => clean((design.slice(28, 60).match(/../g) ?? []).map((b) => parseInt(b, 16)).filter((x) => x).map((x) => String.fromCharCode(x)).join(""), 16);

/**
 * What `amountOut` of a leg's item costs now along its path, on its exchange's own quoter: a path quoter for Aerodrome
 * Slipstream and Uniswap v3, pool by pool for Aero (each pool from its factory) and Uniswap v4. A leg nobody can quote
 * stops.
 */
async function legCost(c, venue, path, item, amountOut, where) {
  try {
    if (venue === 0 || venue === 2) {
      const [amountIn] = await c.pub.readContract({ address: venue === 0 ? QUOTERS.slipstream : QUOTERS.uniswapV3, abi: pathQuoterAbi, functionName: "quoteExactOutput", args: [path, amountOut] });
      return amountIn;
    }
    let amount = amountOut;
    if (venue === 1) {
      const hex = path.slice(2);
      for (let o = 0; o + 86 <= hex.length; o += 46) {
        const out = getAddress(`0x${hex.slice(o, o + 40)}`);
        const tickSpacing = parseInt(hex.slice(o + 40, o + 46), 16);
        const tokenIn = getAddress(`0x${hex.slice(o + 46, o + 86)}`);
        const pool = await c.pub.readContract({ address: QUOTERS.aeroFactory, abi: aeroFactoryAbi, functionName: "getPool", args: [out, tokenIn, tickSpacing] });
        if (same(pool, zeroAddress)) throw new Error("no pool");
        [amount] = await c.pub.readContract({ address: QUOTERS.aero, abi: aeroQuoterAbi, functionName: "quoteExactOutputSingleV3", args: [pool, tokenIn, amount, 0n] });
      }
      return amount;
    }
    const [keys] = decodeAbiParameters(poolKeysParams, path);
    let out = item;
    for (const k of keys) {
      const zeroForOne = same(k.currency1, out);
      [amount] = await c.pub.readContract({ address: QUOTERS.uniswapV4, abi: v4QuoterAbi, functionName: "quoteExactOutputSingle", args: [{ poolKey: k, zeroForOne, exactAmount: amount, hookData: "0x" }] });
      out = zeroForOne ? k.currency0 : k.currency1;
    }
    return amount;
  } catch (e) {
    if (e instanceof Stop) throw e;
    stop(`${where}: what it buys can't be quoted on its exchange now (no pool fills it): build the plan again later`);
  }
}

/** A path of exchanges 0-3 (token, 3 bytes, token, ...): `first` to `last` in 1 to 3 pools, neither end in between. */
function pathFrom(path, first, last, where) {
  const tokens = pathTokens(path, where);
  if (tokens.length > 4 || !same(tokens[0], first) || !same(tokens.at(-1), last) || tokens.slice(1, -1).some((t) => same(t, first) || same(t, last))) {
    stop(`${where} does not go from ${first} to ${last} in 1 to 3 pools`);
  }
  return tokens;
}

const poolKeysParams = parseAbiParameters("(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)[]");
/** A Uniswap v4 leg: abi.encode(PoolKey[]), 1 to 3 pools from the item to USDC, each joined to the next, no loop. The
 *  router itself takes only pools its owner listed, and none with a hook that could rewrite a swap. */
function v4From(path, item, usdc, where) {
  let keys;
  try {
    [keys] = decodeAbiParameters(poolKeysParams, path);
  } catch {
    stop(`${where}'s Uniswap v4 path does not decode`);
  }
  if (encodeAbiParameters(poolKeysParams, [keys]).toLowerCase() !== path.toLowerCase()) stop(`${where}'s Uniswap v4 path carries extra bytes`);
  if (!keys.length || keys.length > 3) stop(`${where} buys in ${keys.length} Uniswap v4 pools, not 1 to 3`);
  let want = item;
  keys.forEach((k, h) => {
    if (same(k.currency0, want)) want = k.currency1;
    else if (same(k.currency1, want)) want = k.currency0;
    else stop(`${where}'s Uniswap v4 pools do not join`);
    if (same(want, item) || (same(want, usdc) && h + 1 !== keys.length)) stop(`${where}'s Uniswap v4 path loops`);
  });
  if (!same(want, usdc)) stop(`${where} does not end in USDC`);
}

/**
 * How the boxes are paid, through router v2: each item's leg - USDC put in as it is, an ETH payer's ETH from the payment,
 * every other one bought on its exchange from USDC for at most its maxIn - the budget exactly those maxIns and the USDC
 * with both fees, the deadline within validUntil, no permit; in USDC an exact approval of the budget, in ETH the boxes'
 * ETH and no more than the budget is worth at Chainlink's price and 5%. Returns the budget, the boxes' ETH and ETH's price.
 */
async function payment(c, { last, items, legs, nb, fees, pay, symbols }) {
  const { address: usdc, weth } = MONEY[8453];
  const n = last.n;
  const p = last.args[5];
  if (c.plan.validUntil === undefined) stop("a gift bought through the router has a validUntil");
  if (legs.length !== items.length) stop(`${n} buys ${legs.length} legs for ${items.length} tokens`);
  let budget = 0n;
  let ethItem = 0n;
  for (const [i, it] of items.entries()) {
    const leg = legs[i];
    const where = `${n}, leg ${i + 1}`;
    if (same(it.token, usdc) || (same(it.token, zeroAddress) && pay === "eth")) {
      if (leg.venue !== 0 || leg.path !== "0x" || leg.maxIn !== 0n) stop(`${where} swaps for the ${symbols[i]} it puts in as it is`);
      if (same(it.token, usdc)) budget += needOf(it.amount, nb, fees);
      else ethItem = needOf(it.amount, nb, fees);
      continue;
    }
    if (same(it.token, weth)) stop(`${where} puts WETH in a box: ETH is the item`);
    // Aerodrome classic spends all of maxIn whatever the item costs: no plan of ours buys there (review, 13 Nov 2026)
    if (leg.venue === 3) stop(`${where} buys on Aerodrome classic, which spends all of maxIn: no Gifted Stock plan does`);
    const bought = same(it.token, zeroAddress) ? weth : it.token;
    if (same(it.token, zeroAddress)) {
      // a USDC payer's ETH: bought as WETH on exchanges 0-2
      if (leg.venue > 2) stop(`${where} buys ETH on exchange ${leg.venue}`);
      pathFrom(leg.path, weth, usdc, where);
    } else if (leg.venue === 4) v4From(leg.path, it.token, usdc, where);
    else if (leg.venue <= 2) pathFrom(leg.path, it.token, usdc, where);
    else stop(`${where} names exchange ${leg.venue}`);
    if (leg.maxIn === 0n) stop(`${where} buys with nothing`);
    // what the item costs now on that path, from the exchange's own quoter: maxIn no more than that and 3%, whoever
    // priced the amounts (review, 13 Nov 2026: a maxIn left to the API is a price left to it)
    const need = needOf(it.amount, nb, fees);
    const cost = await legCost(c, leg.venue, leg.path, bought, need, where);
    if (leg.maxIn * 10_000n > cost * (10_000n + LEG_ROOM_BPS) + 10_000n) stop(`${where} may spend ${formatUnits(leg.maxIn, 6)} USDC on its ${symbols[i]}, over 3% above the ${formatUnits(cost, 6)} it costs now`);
    budget += leg.maxIn;
  }
  c.lines.push(`${n}: each item's most to spend is within 3% of what it costs now, on its exchange's own quoter`);
  if (p.budget !== budget) stop(`${n}'s budget is not what its legs and the USDC with both fees take`);
  if (p.deadline > BigInt(c.plan.validUntil)) stop(`${n}'s deadline is after the plan's validUntil`);
  const pm = p.permit;
  if (pm.value !== 0n || pm.deadline !== 0n || pm.v !== 0 || pm.r !== zeroHash || pm.s !== zeroHash) stop(`${n} carries a permit you did not sign`);
  if (pay === "usdc") {
    if (p.ethPath !== "0x" || p.ethVenue !== 0) stop(`${n} pays with ETH, not USDC`);
    noEth(last);
    steps(c, 1, 2);
    if (c.steps.length === 2) {
      approval(c.steps[0], usdc, "giftRouter", budget);
      c.lines.push(`${c.steps[0].n}: approve exactly ${formatUnits(budget, 6)} USDC for the gift router`);
    }
    c.lines.push(`${n}: pays at most ${formatUnits(budget, 6)} USDC; what it does not spend comes back`);
    return { budget, ethItem: 0n, eth8: null };
  }
  steps(c, 1, 1);
  if (p.ethVenue > 2) stop(`${n} buys its USDC with ETH on exchange ${p.ethVenue}`);
  pathFrom(p.ethPath, usdc, weth, `${n}'s ETH path`);
  if (budget === 0n ? last.value !== ethItem : last.value <= ethItem) {
    stop(`${n} sends ${formatUnits(last.value, 18)} ETH, and the boxes' own ETH with both fees is ${formatUnits(ethItem, 18)}${budget === 0n ? "" : ", with USDC still to buy"}`);
  }
  const eth8 = await ethPrice(c);
  const buying = last.value - ethItem;
  if (budget > 0n && buying * eth8 * 100n > budget * 10n ** 20n * 105n) stop(`${n} sends ${formatUnits(buying, 18)} ETH to buy at most ${formatUnits(budget, 6)} USDC: over 5% above ETH's Chainlink price`);
  c.lines.push(`${n}: sends ${formatUnits(last.value, 18)} ETH${ethItem ? ` (${formatUnits(ethItem, 18)} of it the boxes' ETH with both fees)` : ""} to buy at most ${formatUnits(budget, 6)} USDC; what it does not spend comes back as ETH`);
  return { budget, ethItem, eth8 };
}

/** The symbols and decimals of what each box holds, ETH and USDC known, the rest read on the chain. */
async function itemFacts(c, items) {
  const { address: usdc } = MONEY[8453];
  const read = (fn, it) => (same(it.token, zeroAddress) ? (fn === "symbol" ? "ETH" : 18) : same(it.token, usdc) ? (fn === "symbol" ? "USDC" : 6) : c.pub.readContract({ address: it.token, abi: erc20Abi, functionName: fn }));
  const [symbols, decimals] = await Promise.all([Promise.all(items.map((it) => read("symbol", it))), Promise.all(items.map((it) => read("decimals", it)))]);
  return { symbols, decimals };
}

/** A gift to wallets or behind a link: who gets it, what is inside, the fee and its slot, and what pays, all as asked. */
async function gift(c, link) {
  const r = c.request;
  const pay = typeof r.payWith === "string" ? r.payWith.trim().toLowerCase() : "";
  if (pay === "held" || pay === "hold") stop(`skill ${VERSION} pays a gift with USDC or ETH: the gift router buys what each box holds`);
  if (pay !== "usdc" && pay !== "eth") stop("request.payWith is USDC or ETH");
  const { address: usdc } = MONEY[8453];
  const fees = await feesNow(c);
  const last = call(c.steps.at(-1), ["giftRouter"], ["buy"], "the gift router's buy");
  const [items, legs, boxes, recipients, opt] = last.args;
  const n = last.n;
  const nb = BigInt(boxes);

  // who, the fee and its slot
  const slotTo = slotOf(opt, fees, n, null);
  // the box's design: none asked, the Gifted Stock box (zero); a design word, that word; the form's fields, as the API
  // wrote them - its title shown here to look at (it shows on the recipients' boxes)
  if (r.design === undefined || r.design === null) {
    if (opt.design !== zeroHash) stop(`${n} puts a design on the box you did not ask for`);
  } else if (typeof r.design === "string") {
    if (!same(opt.design, r.design)) stop(`${n} puts another design on the box than yours`);
  } else c.review.push(`${n}: the box's design is the API's word for yours${titleOf(opt.design) ? `; its title reads "${titleOf(opt.design)}"` : ""}`);
  const note = typeof r.note === "string" ? r.note.trim() : "";
  if (opt.messageHash !== (note ? keccak256(toBytes(note)) : zeroHash)) stop(`${n} carries another note than yours`);
  let who;
  if (link) {
    const l = r.link ?? {};
    if (!c.linkKeyAddress) stop("a gift link: give the address of the link key you made (--link-key)");
    if (!same(opt.linkKey, c.linkKeyAddress)) stop(`${n} makes a link with another key than yours`);
    if (boxes !== Number(int(l.boxes, "request.link.boxes"))) stop(`${n} makes ${boxes} boxes, not ${l.boxes}`);
    if (recipients.length) stop(`${n} makes a link that also sends to wallets`);
    const [kind, gate] = l.who === "anyone" ? [0, zeroHash] : l.who === "verified" ? [1, VERIFIED_RULE] : l.who === "list" ? [2, listRoot(l.list ?? [])] : stop("request.link.who is anyone, verified or list");
    if (opt.gateKind !== kind || opt.gate !== gate) stop(`${n} lets other wallets claim than "${l.who}"`);
    const from = l.opensAt === undefined || l.opensAt === null || l.opensAt === 0 ? 0 : when(l.opensAt, "request.link.opensAt");
    if (Number(opt.claimFrom) !== from) stop(`${n} opens claims at another time than asked`);
    if (l.closesAt === undefined) {
      if (!(Number(opt.claimUntil) > c.now && Number(opt.claimUntil) <= c.now + 7 * DAY + 3_600)) stop(`${n} closes claims at another time than the 7 days asked`);
    } else if (Number(opt.claimUntil) !== (l.closesAt === null || l.closesAt === 0 ? 0 : when(l.closesAt, "request.link.closesAt"))) stop(`${n} closes claims at another time than asked`);
    who = `behind a link (${l.who}), claims ${from ? `from ${new Date(from * 1000).toISOString()} ` : ""}until ${Number(opt.claimUntil) ? new Date(Number(opt.claimUntil) * 1000).toISOString() : "no end"}`;
  } else {
    if (opt.linkKey !== zeroAddress || opt.gateKind !== 0 || opt.gate !== zeroHash || opt.claimFrom !== 0 || opt.claimUntil !== 0) stop(`${n} makes a link you did not ask for`);
    if (!Array.isArray(r.to) || !r.to.length) stop("request.to is missing");
    if (boxes !== r.to.length || recipients.length !== r.to.length) stop(`${n} makes ${boxes} boxes for ${recipients.length} wallets, not ${r.to.length}`);
    const left = recipients.map((x) => x.toLowerCase());
    for (const t of r.to.filter(isAddr)) {
      const i = left.indexOf(t.toLowerCase());
      if (i < 0) stop(`${n} gifts to other wallets than the ones asked`);
      left.splice(i, 1);
    }
    if (left.length !== r.to.filter((t) => !isAddr(t)).length) stop(`${n} gifts to other wallets than the ones asked`);
    if (left.length) c.review.push(`${n} gifts to ${left.join(", ")}, which the API resolved from names: check each is the wallet meant`);
    who = `for ${recipients.join(", ")}`;
  }

  // what is inside: each item asked once, by name or address; an amount asked exactly, a dollar amount as quoted
  if (!Array.isArray(r.items) || r.items.length !== items.length) stop(`${n} holds ${items.length} tokens, not the ${r.items?.length} asked`);
  const { symbols, decimals } = await itemFacts(c, items);
  const unmatched = items.map((_, i) => i);
  let usdTotal = 0n;
  let allUsd = true;
  const usdAsked = []; // tokens asked in dollars, priced by the API
  for (const want of r.items) {
    const t = typeof want?.token === "string" ? want.token : "";
    const i = unmatched.find((k) => (isAddr(t) ? same(items[k].token, t) : same(symbols[k], t)));
    if (i === undefined) stop(`${n} does not hold the ${t} asked`);
    unmatched.splice(unmatched.indexOf(i), 1);
    if (!isAddr(t) && !/^(eth|usdc)$/i.test(t)) c.review.push(`${n}: the API says ${t} is ${items[i].token}: check it against a list you trust (Coinbase's tokenized stocks, the token's own site)`);
    if (want.amount !== undefined) {
      if (items[i].amount !== units(want.amount, Number(decimals[i]), `request.items ${t} amount`)) stop(`${n} puts other than ${want.amount} ${t} in each box`);
      allUsd = false;
    } else {
      const usd = units(want.usd, 2, `request.items ${t} usd`) * 10_000n; // dollars in USDC's 6 decimals
      if (same(items[i].token, usdc) && items[i].amount !== usd) stop(`${n} puts other than ${want.usd} USDC in each box`);
      if (same(items[i].token, zeroAddress)) {
        // ETH asked in dollars: no more than 3% over them at Chainlink's price
        const eth8 = await ethPrice(c);
        if (items[i].amount * eth8 * 100n > usd * 10n ** 20n * 103n) stop(`${n} puts ${formatUnits(items[i].amount, 18)} ETH in each box: over 3% above the $${want.usd} asked at ETH's Chainlink price`);
      } else if (!same(items[i].token, usdc)) usdAsked.push(t);
      // what the USDC budget pays for: an ETH payer's ETH item comes out of the ETH sent, not the budget (review, 13 Nov 2026)
      if (!(pay === "eth" && same(items[i].token, zeroAddress))) usdTotal += usd;
    }
    if (items[i].amount === 0n) stop(`${n} puts no ${t} in the boxes`);
  }
  const each = await Promise.all(items.map((it) => c.words(it.token, it.amount)));

  // what pays: the router, buying with USDC or ETH
  const { budget } = await payment(c, { last, items, legs, nb, fees, pay, symbols });
  if (allUsd && budget > (usdTotal * nb * (10_000n + fees.fee + fees.slot) * 103n) / 1_000_000n) {
    stop(`${n} may spend ${formatUnits(budget, 6)} USDC, over 3% above the dollars asked and the fee`);
  }
  if (usdAsked.length) c.review.push(`${n} puts ${each.join(" + ")} in each box, priced by the API from the dollars asked: check it matches`);
  if (!allUsd) c.review.push(`${n} may spend up to ${formatUnits(budget, 6)} USDC: check it fits the amounts asked`);
  const fee = `${fees.fee} bps to the gift box${slotTo ? ` and ${fees.slot} bps app fee to the fee wallet` : ""} on top`;
  c.lines.push(`${n}: make ${boxes} gift box${boxes === 1 ? "" : "es"}, each holding ${each.join(" + ")}, ${who}, ${fee}`);
}

/** A basket's code from the request: the code, or its link. */
function basketCode(v) {
  const s = typeof v === "string" ? v.trim() : "";
  const code = BASKET_CODE.test(s) ? s : /^https:\/\/(www\.)?giftedstock\.com\/basket\/([a-z0-9]{5})\/?(?:[?#].*)?$/.exec(s)?.[2];
  if (!code || !BASKET_CODE.test(code)) stop("request.basket is a basket's code (5 letters and digits) or its link");
  return code;
}

/**
 * A basket's boxes: that many, all to your wallet, no link, the basket's tag; the app-fee slot to the fee wallet or to the
 * basket's maker - a wallet that made a gift with this tag, read on the chain - and what pays as a gift's. The mix, the
 * box price and the design are the API's word (the basket's page shows them): the budget is held to that price.
 */
async function basket(c) {
  const r = c.request;
  const code = basketCode(r.basket);
  const qty = r.quantity === undefined ? 1n : int(r.quantity, "request.quantity");
  if (qty < 1n || qty > 100n) stop("request.quantity is 1 to 100");
  const pay = r.payWith === undefined ? "usdc" : typeof r.payWith === "string" ? r.payWith.trim().toLowerCase() : "";
  if (pay !== "usdc" && pay !== "eth") stop("request.payWith is USDC or ETH");
  const fees = await feesNow(c);
  const last = call(c.steps.at(-1), ["giftRouter"], ["buy"], "the gift router's buy");
  const [items, legs, boxes, recipients, opt] = last.args;
  const n = last.n;
  const nb = BigInt(boxes);
  if (nb !== qty) stop(`${n} makes ${boxes} boxes, not ${qty}`);
  if (recipients.length !== Number(qty) || recipients.some((x) => !same(x, c.me))) stop(`${n} sends boxes to other wallets than yours`);
  if (opt.linkKey !== zeroAddress || opt.gateKind !== 0 || opt.gate !== zeroHash || opt.claimFrom !== 0 || opt.claimUntil !== 0) stop(`${n} makes a link you did not ask for`);
  const tag = keccak256(toBytes(`basket:${code}`));
  if (opt.messageHash !== tag) stop(`${n} carries another tag than basket ${code}'s`);

  // a basket's box carries no text (its title empty): the page's own boxes never do
  if (titleOf(opt.design)) stop(`${n} writes "${titleOf(opt.design)}" on the box: a basket's box carries no text`);
  if (!items.length || items.length > 20) stop(`${n} holds ${items.length} tokens`);

  // the maker's first gift with this basket's tag, read on the chain: theirs, no link, the tag, the same tokens as
  // these boxes. It shows the wallet bought this basket (anyone can make a tagged gift), so the maker is also named for
  // your own look: the basket's page shows who made it.
  const sb = c.plan.summary?.basket ?? {};
  if (!isAddr(sb.maker)) stop("the summary names no maker for the basket");
  const named = getAddress(sb.maker);
  const id = int(sb.makerBatch, "summary.basket.makerBatch");
  const [[creator, , , linkKey, , , , , , , messageHash], made] = await Promise.all([
    c.pub.readContract({ address: PINNED[8453].giftBox, abi: giftBatchAbi, functionName: "batchOf", args: [id] }),
    c.pub.readContract({ address: PINNED[8453].giftBox, abi: giftItemsAbi, functionName: "batchItems", args: [id] }),
  ]);
  if (!same(creator, named) || !same(linkKey, zeroAddress) || messageHash !== tag) stop(`gift ${id} on the chain is not ${named}'s with basket ${code}'s tag`);
  const tokensOf = (xs) => xs.map((x) => x.token.toLowerCase()).sort().join();
  if (tokensOf(made) !== tokensOf(items)) stop(`${n} holds other tokens than gift ${id}, the maker's own box of basket ${code}`);
  const maker = same(named, c.me) ? null : named;
  const slotTo = slotOf(opt, fees, n, maker);
  c.review.push(`the API names ${named} as basket ${code}'s maker (they made gift ${id} with its tag and tokens): check the basket's page shows the same maker${slotTo === "maker" ? `; the app fee goes to them` : ""}`);
  const { symbols } = await itemFacts(c, items);
  const each = await Promise.all(items.map((it) => c.words(it.token, it.amount)));
  if (items.some((it) => it.amount === 0n)) stop(`${n} puts nothing of a token in the boxes`);
  const { budget, ethItem, eth8 } = await payment(c, { last, items, legs, nb, fees, pay, symbols });
  // held to the basket's price the API names: its box price × boxes, 2.5% on top, 3% room (the page's own limit)
  const boxUsd = units(sb.boxUsd, 6, "summary.basket.boxUsd");
  if (boxUsd === 0n) stop("summary.basket.boxUsd is 0");
  const cap = (boxUsd * qty * (10_000n + TOTAL_FEE_BPS) * 103n) / 1_000_000n;
  const ethUsd = ethItem && eth8 ? (ethItem * eth8) / 10n ** 20n : 0n;
  if (budget + ethUsd > cap) stop(`${n} may spend ${formatUnits(budget + ethUsd, 6)} USDC's worth, over 3% above ${qty} × ${formatUnits(boxUsd, 6)} and the fee`);
  c.review.push(`${n} buys basket ${code}${sb.name ? ` ("${clean(sb.name, 24)}")` : ""} at ${formatUnits(boxUsd, 6)} USDC a box, each holding ${each.join(" + ")}: the API's word for the basket - check it at ${SITE}/basket/${code}`);
  c.unchecked.push("a basket's mix, box price and design: they come from the API; the basket's page shows the same");
  const to = slotTo === "maker" ? "its maker" : slotTo ?? "nobody";
  c.lines.push(`${n}: buy ${qty} box${qty === 1n ? "" : "es"} of basket ${code} to your wallet, each holding ${each.join(" + ")}, ${fees.fee} bps to the gift box and ${fees.slot} bps app fee to ${to} on top`);
}

/** viem public clients for both chains: BASE_RPC_URL and ROBINHOOD_RPC_URL, else each chain's public RPC. */
export function defaultClients() {
  return {
    8453: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) }),
    4663: createPublicClient({ chain: robinhood, transport: http(process.env.ROBINHOOD_RPC_URL) }),
  };
}

// ── the command line ─────────────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = args[0];
  if (!file || file.startsWith("--") || !flag("wallet") || !flag("request")) {
    console.error("usage: node verify.mjs <plan.json | -> --wallet 0xYou --request '<the JSON body you sent>' [--link-key 0x…] [--offline]");
    process.exit(2);
  }
  let plan;
  let request;
  try {
    plan = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));
    request = JSON.parse(flag("request"));
  } catch {
    console.error("the plan and --request must be JSON");
    process.exit(2);
  }
  const r = await verifyPlan(plan, {
    wallet: flag("wallet"), request, action: flag("action"), linkKeyAddress: flag("link-key"),
    clients: args.includes("--offline") ? undefined : defaultClients(),
  });
  r.lines.forEach((l) => console.log(l));
  r.review.forEach((l) => console.log(`look yourself: ${l}`));
  r.unchecked.forEach((l) => console.log(`not checked: ${l}`));
  if (!r.ok) {
    console.error(`STOP: ${r.problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`ok: ${plan.steps.length} step(s) on ${CHAIN_NAME[plan.steps[0].chainId]} are the ${plan.action} asked`);
}
