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
 * it is what your human meant. `unchecked`: what this file cannot see. `expect`: what a swap or bridge must take from
 * the wallet and bring it, for a dry run to hold the plan to. The command line reads the chain through BASE_RPC_URL
 * and ROBINHOOD_RPC_URL, else each chain's public RPC; --offline checks opens, sends, claims and take-backs without it.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  concat, createPublicClient, decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData,
  erc20Abi, formatUnits, getAddress, http, isAddress, keccak256, parseAbi, parseAbiParameters, parseUnits, toBytes,
  toFunctionSelector, zeroAddress, zeroHash,
} from "viem";
import { formatAbiItem } from "viem/utils";
import { base, robinhood } from "viem/chains";

export const VERSION = "1.1.0";

// Every contract a step may be sent to or approve, besides the token being approved (SKILL.md, "Contracts a step may
// target"). If GET /api/agent/v1 ever names others, this file is right and the API is not: stop.
export const PINNED = {
  8453: {
    normalBox: "0xFc4633d297E936072cbf83e43F26B104B70188DC",
    premiumBox: "0xc7E36409B4F6A9D4F7Dd575E11C4C5beA682e827",
    giftBox: "0x5a095D4aB6f9aea04D87e10312FBf1d2695ABa8A",
    giftRouter: "0x6f5a51E27452e5e6873cE9b253a0BF1f4145607B",
    aerodromeRouter: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
    aeroRouter: "0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418",
    relayDepository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
  },
  4663: {
    normalBox: "0xB669dF5aB27db31c20696743e9C78951c863c1Ca",
    premiumBox: "0x9e0C3611EFf93aB12346a6C9c35D3BcEa69C58e6",
    uniswapRouter: "0x204FAca1764B154221e35c0d20aBb3c525710498",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    relayDepository: "0x4cD00E387622C35bDDB9b4c962C136462338BC31",
  },
};
/** Each chain's money (6 decimals) and its WETH, which swaps trade ETH as. */
export const MONEY = {
  8453: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", weth: "0x4200000000000000000000000000000000000006" },
  4663: { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" },
};
/** The one address besides yours a swap or bridge pays: the fee in a plan's `summary.fee`. It is never called. */
export const FEE_WALLET = "0xd98EE65e5271267EBE34f87B846403107c068A0f";
/** The bytes after every Base step's arguments: Base's ERC-8021 builder code bc_lfbayxwx. The contract never reads them. */
export const BUILDER_SUFFIX = "0x62635f6c666261797877780b0080218021802180218021802180218021";
/** A swap's fee: 1% when a stock token is on either side, 0.75% between money and ETH. */
export const STOCK_FEE_BPS = 100n;
export const MONEY_FEE_BPS = 75n;
/** Uniswap's Universal Router reads this address as "the router itself", and ALL as "all the router holds". */
const ROUTER_ITSELF = "0x0000000000000000000000000000000000000002";
const ALL = 1n << 255n;
/** A gift link for verified wallets names this rule as its gate. */
const VERIFIED_RULE = keccak256(toBytes("gifted-stock verified v1"));
const RELAY_STATUS = "https://api.relay.link/intents/status/v3?requestId=";
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
const giftAbi = parseAbi([
  ...giftStructs,
  "struct Permit { address token; uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "function create(Item[] items, uint32 boxes, address[] recipients, Options opt, Permit[] permits) payable",
  "function claim(uint256 batchId, bytes linkSig, uint256 deadline, bytes verifierSig, bytes32[] proof)",
  "function open(uint256[] ids)",
  "function reclaim(uint256 batchId, uint32 count, address to)",
]);
const giftRouterAbi = parseAbi([
  ...giftStructs,
  "struct Leg { bytes path; uint256 maxIn; }",
  "struct UsdcPermit { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "struct Pay { uint256 budget; uint256 deadline; bytes ethPath; UsdcPermit permit; }",
  "function buy(Item[] items, Leg[] legs, uint32 boxes, address[] recipients, Options opt, Pay pay) payable",
]);
const routerAbi = parseAbi(["function multicall(bytes[] data) payable"]);
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
const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const relayAbi = parseAbi([
  "function depositNative(address depositor, bytes32 id) payable",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);
const approveAbi = parseAbi(["function approve(address spender, uint256 amount)"]);
// reads
const boxReadAbi = parseAbi(["function price() view returns (uint256)", "function mintPriceWei(uint256 qty) view returns (uint256)"]);
const batchOwnerAbi = parseAbi(["function batchOf(uint256 batchId) view returns ((address owner,uint32 requestedAt,uint16 count,bool revealed,bool settled,bool cancelled))"]);
const giftSettingsAbi = parseAbi(["function settings() view returns (address feeWallet, uint32 feeBps, bool paused, address verifier, address renderer, uint8 maxSticker, uint256 boxesMade, uint256 batchesMade)"]);

const ABI_OF = {
  8453: { normalBox: baseBoxAbi, premiumBox: baseBoxAbi, giftBox: giftAbi, giftRouter: giftRouterAbi, aerodromeRouter: routerAbi, aeroRouter: routerAbi, relayDepository: relayAbi },
  4663: { normalBox: rhBoxAbi, premiumBox: rhBoxAbi, uniswapRouter: universalRouterAbi, permit2: permit2Abi, relayDepository: relayAbi },
};

const sig = (abi) => abi.filter((x) => x.type === "function").map((f) => ({ signature: formatAbiItem(f), selector: toFunctionSelector(f) }));
/** Each contract's functions with their signatures and selectors: GET /api/agent/v1 `functions` must list the same. */
export const FUNCTIONS = {
  base: Object.fromEntries(Object.entries(ABI_OF[8453]).map(([k, abi]) => [k, sig(abi)])),
  robinhood: Object.fromEntries(Object.entries(ABI_OF[4663]).map(([k, abi]) => [k, sig(abi)])),
  token: sig(approveAbi),
  multicall: sig(routerInnerAbi),
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

/** The actions a plan can be, and which of them are checked against the chain itself. */
export const ACTIONS = ["buy", "open", "send", "settle", "swap", "bridge", "gift_create", "gift_link_create", "gift_claim", "gift_open", "gift_take_back"];
const READS_CHAIN = new Set(["buy", "settle", "swap", "bridge", "gift_create", "gift_link_create"]);

/** What a request body asks for, by its shape: the plan must be that, whatever it calls itself. */
export function actionOf(r) {
  if (!r || typeof r !== "object") return null;
  if (r.from && r.to && typeof r.from === "object" && typeof r.to === "object" && r.amount !== undefined) return r.from.chain === r.to.chain ? "swap" : "bridge";
  if (Array.isArray(r.items)) return r.link ? "gift_link_create" : "gift_create";
  if (r.quantity !== undefined) return "buy";
  if (r.id !== undefined) return "settle";
  if (Array.isArray(r.ids) && r.to !== undefined) return "send";
  if (Array.isArray(r.ids) && r.chain !== undefined) return "open";
  if (Array.isArray(r.ids)) return "gift_open";
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
  if (!byAddress && !same(symbol, asked)) stop(`${field}: ${address} is ${symbol}, not ${asked}`);
  if (!byAddress) c.review.push(`${field}: the API says ${asked} is ${address}: check it against a list you trust (Coinbase's tokenized stocks on Base, Robinhood's stock token registry on Robinhood Chain)`);
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
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps) || plan.steps.length === 0) stop("the plan has no steps");
    if (plan.action !== kind) stop(`you asked for ${an(kind)} and the plan is ${an(String(plan.action))}`);
    const chainName = kind === "swap" || kind === "bridge" ? request.from?.chain : kind.startsWith("gift") ? "base" : request.chain;
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
    sameIds(s.args[0], c.request.ids, s.n);
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
    if (from.kind === "stock" && to.kind === "stock") stop("a stock token trades against money or ETH, not another stock token");
    const amount = units(r.amount, from.decimals, "request.amount");
    if (amount === 0n) stop("request.amount is 0");
    const bps = from.kind === "stock" || to.kind === "stock" ? STOCK_FEE_BPS : MONEY_FEE_BPS;
    if (sm.fee?.bps !== undefined && BigInt(sm.fee.bps) !== bps) stop(`the summary's fee is ${sm.fee.bps} bps, and this swap's is ${bps}`);
    const minOut = units(sm.to?.minimumOut, to.decimals, "summary.to.minimumOut");
    if (minOut === 0n) stop("the summary's minimumOut is 0");
    if (c.plan.validUntil === undefined) stop("a swap plan has a validUntil");
    const t = { from, to, amount, bps, minOut, until: BigInt(c.plan.validUntil) };
    if (c.chainId === 8453) baseSwap(c, t);
    else rhSwap(c, t);
    c.out.expect = { spend: [{ token: from.address, amount }], gain: [{ token: to.address, atLeast: minOut }] };
    c.lines.push(`in all: ${await c.words(from.address, amount)} for at least ${await c.words(to.address, minOut)} to your wallet, ${bps} bps to the fee wallet`);
    c.unchecked.push("whether the minimum is a fair price: compare summary.to.minimumOut with a price you trust");
  },

  async bridge(c) {
    const r = c.request;
    const from = await tokenOf(c, r.from.token, null, "from");
    if (from.kind === "stock") stop("a bridge moves USDC, USDG or ETH");
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
    c.out.expect = { spend: [{ token: from.address, amount }], gain: [] };
    c.lines.push(`${last.n}: deposit ${await c.words(from.address, amount)} with Relay; a refund comes back to your wallet; Relay request ${id}`);
    c.unchecked.push(`the payout on the other chain: Relay's request ${id} carries where it goes and how much. Look it up with Relay itself (${RELAY_STATUS}${id}), not through a link from the plan`);
  },

  gift_create: (c) => gift(c, false),
  gift_link_create: (c) => gift(c, true),

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
};

/** A Base swap: an exact approval for the router (unless ETH goes in), then multicall: one swap that pays the router
 *  itself, then one fee sweep that pays you, then refundETH when ETH went in. */
function baseSwap(c, { from, to, amount, bps, minOut, until }) {
  const { weth, address: usdc } = MONEY[8453];
  const ethIn = from.kind === "eth";
  const ethOut = to.kind === "eth";
  const last = call(c.steps.at(-1), ["aerodromeRouter", "aeroRouter"], ["multicall"], "a swap on a Base router");
  if (ethIn) {
    steps(c, 1, 1);
    if (last.value !== amount) stop(`${last.n} sends ${formatUnits(last.value, 18)} ETH, not the ${formatUnits(amount, 18)} asked`);
  } else {
    steps(c, 1, 2);
    noEth(last);
    if (c.steps.length === 2) approval(c.steps[0], from.address, last.name, amount);
  }
  const calls = last.args[0].map((raw, j) => exact(routerInnerAbi, raw, `${last.n}, call ${j + 1} inside multicall`));
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
    if (tokens.length > 3 || tokens.slice(1, -1).some((x) => !same(x, usdc))) stop(`${where} routes through a token other than USDC`);
  } else stop(`${where} is not a swap`);
  if (!same(p.recipient, last.to)) stop(`${where} sends the swap's output to ${p.recipient}, not the router itself`);
  if (p.amountIn !== amount) stop(`${where} swaps ${p.amountIn}, not the ${amount} asked`);
  if (p.deadline > until) stop(`${where}'s deadline is after the plan's validUntil`);
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

/** A Robinhood Chain swap: an exact approval for Permit2 and Permit2's for the Uniswap router (unless ETH goes in or
 *  they stand already), then execute: one or two hops into the router itself, the amount asked on the first and all
 *  the router holds after, through USDG only, then the fee to the fee wallet, then SWEEP to you. */
function rhSwap(c, { from, to, amount, bps, minOut, until }) {
  const { weth, address: usdg } = MONEY[4663];
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
        if (!same(token, from.address) || !same(spender, PINNED[4663].uniswapRouter) || amt !== amount) stop(`${s.n} gives Permit2 rights other than the amount asked, to Uniswap's router`);
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
      const [c0, c1, , , hooks] = key;
      const [taken, takeTo, takeAmt] = exactParams(V4.take, params[2], `${where}, TAKE`);
      if (same(cur, weth) || !same(currency, cur) || amt !== (first ? amount : ALL) || payerIsUser !== (first && !ethIn)) stop(`${where} pays in other than ${first ? "the amount asked" : "all the router holds"}`);
      if (!same(hooks, zeroAddress) || hookData !== "0x") stop(`${where} trades through a pool with a hook`);
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
      if (!same(cur, usdg)) stop(`${where} routes through a token other than USDG`);
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

/** A gift to wallets or behind a link: who gets it, what is inside, the fee and what pays for it, all as asked. */
async function gift(c, link) {
  const r = c.request;
  const pay = typeof r.payWith === "string" ? r.payWith.trim().toLowerCase() : "";
  if (!["held", "hold", "usdc", "eth"].includes(pay)) stop("request.payWith is held, USDC or ETH");
  const held = pay === "held" || pay === "hold";
  const { address: usdc, weth } = MONEY[8453];
  const [, feeBps] = await c.pub.readContract({ address: PINNED[8453].giftBox, abi: giftSettingsAbi, functionName: "settings" });
  const fee = BigInt(feeBps);
  const last = held ? call(c.steps.at(-1), ["giftBox"], ["create"], "the gift box's create") : call(c.steps.at(-1), ["giftRouter"], ["buy"], "the gift router's buy");
  const a = last.args;
  const [items, boxes, recipients, opt] = held ? [a[0], a[1], a[2], a[3]] : [a[0], a[2], a[3], a[4]];
  const n = last.n;

  // who
  if (opt.frontend !== zeroAddress || opt.frontendBps !== 0) stop(`${n} pays a frontend fee to ${opt.frontend}`);
  if (BigInt(opt.maxFeeBps) !== fee) stop(`${n} allows a fee of ${opt.maxFeeBps} bps, and the gift box's is ${fee}`);
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
  const read = (fn, it) => (same(it.token, zeroAddress) ? (fn === "symbol" ? "ETH" : 18) : same(it.token, usdc) ? (fn === "symbol" ? "USDC" : 6) : c.pub.readContract({ address: it.token, abi: erc20Abi, functionName: fn }));
  const symbols = await Promise.all(items.map((it) => read("symbol", it)));
  const decimals = await Promise.all(items.map((it) => read("decimals", it)));
  const unmatched = items.map((_, i) => i);
  let usdTotal = 0n;
  let allUsd = true;
  const usdAsked = []; // tokens asked in dollars, priced by the API
  for (const want of r.items) {
    const t = typeof want?.token === "string" ? want.token : "";
    const i = unmatched.find((k) => (isAddr(t) ? same(items[k].token, t) : same(symbols[k], t)));
    if (i === undefined) stop(`${n} does not hold the ${t} asked`);
    unmatched.splice(unmatched.indexOf(i), 1);
    if (!isAddr(t) && !/^(eth|usdc)$/i.test(t)) c.review.push(`${n}: the API says ${t} is ${items[i].token}: check it against a list you trust (Coinbase's tokenized stocks)`);
    if (want.amount !== undefined) {
      if (items[i].amount !== units(want.amount, Number(decimals[i]), `request.items ${t} amount`)) stop(`${n} puts other than ${want.amount} ${t} in each box`);
      allUsd = false;
    } else {
      const usd = units(want.usd, 2, `request.items ${t} usd`) * 10_000n; // dollars in USDC's 6 decimals
      if (same(items[i].token, usdc) && items[i].amount !== usd) stop(`${n} puts other than ${want.usd} USDC in each box`);
      if (!same(items[i].token, usdc)) usdAsked.push(t);
      usdTotal += usd;
    }
    if (items[i].amount === 0n) stop(`${n} puts no ${t} in the boxes`);
  }
  const each = await Promise.all(items.map((it) => c.words(it.token, it.amount)));

  // what pays: what the wallet holds, exactly what the contract takes; or the router, buying with USDC or ETH
  const nb = BigInt(boxes);
  const needOf = (amount) => amount * nb + (amount * nb * fee + 9_999n) / 10_000n;
  if (held) {
    if (a[4].length) stop(`${n} carries permits you did not sign`);
    if (usdAsked.length) c.review.push(`${n} puts ${each.join(" + ")} in each box, priced by the API from the dollars asked: check it matches`);
    const ethItem = items.find((it) => same(it.token, zeroAddress));
    if (last.value !== (ethItem ? needOf(ethItem.amount) : 0n)) stop(`${n} sends other ETH than the boxes and the fee take`);
    const approved = new Set();
    for (const s of c.steps.slice(0, -1)) {
      const it = items.find((x) => s.kind === "approve" && same(x.token, s.token));
      if (!it || approved.has(it.token.toLowerCase())) stop(`${s.n} approves a token the gift does not take`);
      approval(s, it.token, "giftBox", needOf(it.amount));
      approved.add(it.token.toLowerCase());
      c.lines.push(`${s.n}: approve exactly ${await c.words(it.token, needOf(it.amount))} for the gift box: what the boxes hold and the fee`);
    }
  } else {
    if (c.plan.validUntil === undefined) stop("a gift bought through the router has a validUntil");
    const [, legs, , , , p] = a;
    if (legs.length !== items.length) stop(`${n} buys ${legs.length} legs for ${items.length} tokens`);
    let budget = 0n;
    items.forEach((it, i) => {
      if (same(it.token, usdc)) {
        if (legs[i].path !== "0x" || legs[i].maxIn !== 0n) stop(`${n} swaps for the USDC it puts in as is`);
        budget += needOf(it.amount);
      } else {
        const tokens = pathTokens(legs[i].path, `${n}, leg ${i + 1}`);
        if (tokens.length !== 2 || !same(tokens[0], it.token) || !same(tokens[1], usdc)) stop(`${n}, leg ${i + 1}, buys other than ${symbols[i]} with USDC in one pool`);
        budget += legs[i].maxIn;
      }
    });
    if (p.budget !== budget) stop(`${n}'s budget is not what its legs and the fee take`);
    if (p.deadline > BigInt(c.plan.validUntil)) stop(`${n}'s deadline is after the plan's validUntil`);
    if (p.permit.value !== 0n || p.permit.v !== 0) stop(`${n} carries a permit you did not sign`);
    if (allUsd && budget > (usdTotal * nb * (10_000n + fee) * 103n) / 1_000_000n) stop(`${n} may spend ${formatUnits(budget, 6)} USDC, over 3% above the dollars asked and the fee`);
    if (pay === "usdc") {
      if (p.ethPath !== "0x") stop(`${n} pays with ETH, not USDC`);
      noEth(last);
      steps(c, 1, 2);
      if (c.steps.length === 2) {
        approval(c.steps[0], usdc, "giftRouter", budget);
        c.lines.push(`${c.steps[0].n}: approve exactly ${formatUnits(budget, 6)} USDC for the gift router`);
      }
      c.lines.push(`${n}: pays at most ${formatUnits(budget, 6)} USDC; what it does not spend comes back`);
    } else {
      const path = pathTokens(p.ethPath, `${n}'s ETH path`);
      if (path.length !== 2 || !same(path[0], usdc) || !same(path[1], weth)) stop(`${n} buys its USDC with ETH other than in one WETH/USDC pool`);
      steps(c, 1, 1);
      if (last.value === 0n) stop(`${n} sends no ETH`);
      c.review.push(`${n} sends ${formatUnits(last.value, 18)} ETH for at most ${formatUnits(budget, 6)} USDC of stocks; what it does not spend comes back`);
    }
    if (!allUsd) c.review.push(`${n} may spend up to ${formatUnits(budget, 6)} USDC: check it fits the amounts asked`);
  }
  c.lines.push(`${n}: make ${boxes} gift box${boxes === 1 ? "" : "es"}, each holding ${each.join(" + ")}, ${who}, the gift box's ${fee} bps fee on top`);
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
