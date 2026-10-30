#!/usr/bin/env node
/**
 * Gifted Stock from your own wallet: asks the agent API (https://www.giftedstock.com/SKILL.md) for a plan, checks every
 * step against the contracts and functions pinned below, runs the whole plan on the chain without sending it, shows
 * you what it does and sends it only after your yes.
 *
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs buy  '{"chain":"base","box":"normal","quantity":1,"payWith":"USDC"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs swap '{"from":{"chain":"base","token":"USDC"},"to":{"chain":"base","token":"NVDAc"},"amount":"2"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs gift '{"items":[{"token":"NVDAc","usd":"1"}],"payWith":"USDC","link":{"boxes":3,"who":"anyone"}}'
 *   PRIVATE_KEY=0x… GIFT_URL='https://www.giftedstock.com/gift?batch=12#k=0x…' node examples/giftedstock.mjs claim
 *
 * Actions: buy, open, send, swap, gift, gift/open, gift/take-back, claim. `wallet` is filled in from the key. Add
 * --yes to send without asking (only where your human said so). BASE_RPC_URL and ROBINHOOD_RPC_URL pick other RPCs.
 *
 * The key never leaves this process: requests carry addresses and signatures only. A gift link's key is made here,
 * saved to a file only you can read before anything is sent, and only its address goes to the API.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  createPublicClient, createWalletClient, decodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, http,
  isAddress, parseAbi, zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";

const API = "https://www.giftedstock.com/api/agent/v1";
const SITE = "https://www.giftedstock.com";

// Every contract a step may be sent to or approve, besides the token being approved (SKILL.md, "Contracts a step may
// target"). Pinned here, not read from the API: a plan that names anything else is refused before it is signed.
const PINNED = {
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
const GIFT_BOX = PINNED[8453].giftBox;

// The only functions a plan may call on each kind of contract. Anything else on a pinned contract - setApprovalForAll,
// approve or transferFrom on a box, rekeyLink, withdrawPending - is refused.
const boxAbi = parseAbi([
  "function mint(uint256 qty)",
  "function mintWithEth(uint256 qty) payable",
  "function open(uint256[] ids) payable",
  "function sendCards(address to, uint256[] ids)",
]);
const giftAbi = parseAbi([
  "struct Item { address token; uint256 amount; }",
  "struct Options { address linkKey; uint8 gateKind; bytes32 gate; bytes32 design; bytes32 messageHash; uint40 claimFrom; uint40 claimUntil; address frontend; uint16 frontendBps; uint32 maxFeeBps; }",
  "struct Permit { address token; uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "struct Leg { bytes path; uint256 maxIn; }",
  "struct UsdcPermit { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; }",
  "struct Pay { uint256 budget; uint256 deadline; bytes ethPath; UsdcPermit permit; }",
  "function create(Item[] items, uint32 boxes, address[] recipients, Options opt, Permit[] permits) payable",
  "function buy(Item[] items, Leg[] legs, uint32 boxes, address[] recipients, Options opt, Pay pay) payable",
  "function claim(uint256 batchId, bytes linkSig, uint256 deadline, bytes verifierSig, bytes32[] proof)",
  "function open(uint256[] ids)",
  "function reclaim(uint256 batchId, uint32 count, address to)",
]);
const routerAbi = parseAbi(["function multicall(bytes[] data) payable"]);
const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const relayAbi = parseAbi([
  "function depositNative(address depositor, bytes32 id) payable",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);
const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);

/** For each action: the contracts it may call, the functions on each, and the spenders its approvals may name. */
const ACTIONS = {
  buy: { path: "tx/buy", calls: { normalBox: ["mint", "mintWithEth"], premiumBox: ["mint", "mintWithEth"] }, spenders: ["normalBox", "premiumBox"], gains: true },
  open: { path: "tx/open", calls: { normalBox: ["open"], premiumBox: ["open"] }, spenders: [] },
  send: { path: "tx/send", calls: { normalBox: ["sendCards"], premiumBox: ["sendCards"] }, spenders: [] },
  swap: {
    path: "tx/swap",
    calls: { aerodromeRouter: ["multicall"], aeroRouter: ["multicall"], uniswapRouter: ["execute"], permit2: ["approve"], relayDepository: ["depositNative", "depositErc20"] },
    spenders: ["aerodromeRouter", "aeroRouter", "permit2", "relayDepository"],
  },
  gift: { path: "tx/gift", calls: { giftBox: ["create"], giftRouter: ["buy"] }, spenders: ["giftBox", "giftRouter"] },
  "gift/open": { path: "tx/gift/open", calls: { giftBox: ["open"] }, spenders: [], gains: true },
  "gift/take-back": { path: "tx/gift/take-back", calls: { giftBox: ["reclaim"] }, spenders: [], gains: true },
  claim: { path: "tx/gift/claim", calls: { giftBox: ["claim"] }, spenders: [], gains: true },
};
const ABI_OF = {
  normalBox: boxAbi, premiumBox: boxAbi, giftBox: giftAbi, giftRouter: giftAbi, aerodromeRouter: routerAbi, aeroRouter: routerAbi,
  uniswapRouter: universalRouterAbi, permit2: permit2Abi, relayDepository: relayAbi,
};

// the gift box contract's logs: BatchCreated's topics[1] is a new link's id, Claimed's topics[2] the box claimed
const BATCH_CREATED = "0x6780e18cae4367542f9523587cc962e780a8ac6a98b18b19dd3c48dc04a1c21b";
const CLAIMED = "0xc09f7b3c1c5b70bf6d30e485a4525d625d4723aed5d319376825446ef135c7ca";
const giftLog = (receipt, topic0, index) => {
  const log = receipt.logs.find((l) => getAddress(l.address) === GIFT_BOX && l.topics[0] === topic0);
  return log ? BigInt(log.topics[index]) : null;
};

const CHAINS = {
  8453: { chain: base, rpc: process.env.BASE_RPC_URL },
  4663: { chain: robinhood, rpc: process.env.ROBINHOOD_RPC_URL },
};

function fail(message) {
  console.error(`stopped: ${message}`);
  process.exit(1);
}

const [, , action, input, ...rest] = process.argv;
const flags = [input, ...rest].filter((a) => a?.startsWith("--"));
const yes = flags.includes("--yes");
if (!(action in ACTIONS) || (action !== "claim" && (!input || input.startsWith("--")))) {
  fail("usage: node examples/giftedstock.mjs <buy|open|send|swap|gift|gift/open|gift/take-back> '<json body>' [--yes], or GIFT_URL='<share url>' node examples/giftedstock.mjs claim [--yes]");
}
if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY ?? "")) fail("PRIVATE_KEY must be set to your wallet's key (0x and 64 hex)");
const account = privateKeyToAccount(process.env.PRIVATE_KEY);

const clients = Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [id, {
  pub: createPublicClient({ chain: c.chain, transport: http(c.rpc) }),
  wallet: createWalletClient({ account, chain: c.chain, transport: http(c.rpc) }),
}]));

async function ask(path, body) {
  const res = await fetch(`${API}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out) fail(out && typeof out.error === "string" ? `${out.error}: ${String(out.message).slice(0, 300)}` : `the API answered ${res.status}`);
  return out;
}

const nameOf = (chainId, address) => Object.entries(PINNED[chainId]).find(([, a]) => a.toLowerCase() === address.toLowerCase())?.[0];
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));
const me = () => account.address;

/** A token's amount in words, read from the token itself. */
async function tokenAmount(pub, token, amount) {
  const [decimals, symbol] = await Promise.all([
    pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
    pub.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => token),
  ]);
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

/**
 * Each step checked before anything is signed: its chain, its contract and function for this action, and the
 * arguments that say who gains - an approval no larger than what the wallet holds, Permit2 rights for Uniswap's router
 * for an hour at most, a deposit, take-back or gift that names this wallet and the link key made here. Returns each
 * step in our own words, decoded, for the human.
 */
async function check(plan, request, ctx) {
  const rules = ACTIONS[action];
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) fail("the plan has no steps");
  if (new Set(plan.steps.map((s) => s.chainId)).size !== 1) fail("the plan's steps are on more than one chain");
  const lines = [];
  for (const [i, s] of plan.steps.entries()) {
    const n = i + 1;
    if (!PINNED[s.chainId]) fail(`step ${n} is for chain ${s.chainId}, not Base or Robinhood Chain`);
    if (typeof s.value !== "string" || !/^\d+$/.test(s.value)) fail(`step ${n} has a value that is not wei`);
    if (!isAddress(s.to) || typeof s.data !== "string") fail(`step ${n} is malformed`);
    const { pub } = clients[s.chainId];
    const value = BigInt(s.value);
    const name = nameOf(s.chainId, s.to);

    if (!name) {
      // not a pinned contract: only an ERC-20 approve, sending no ETH, for a spender this action uses
      let call;
      try {
        call = decodeFunctionData({ abi: erc20Abi, data: s.data });
      } catch {
        fail(`step ${n} calls ${s.to}, which is not a Gifted Stock contract`);
      }
      if (call.functionName !== "approve") fail(`step ${n} calls ${call.functionName} on ${s.to}`);
      if (value !== 0n) fail(`step ${n} sends ETH with an approve`);
      const [spender, amount] = call.args;
      const spenderName = nameOf(s.chainId, spender);
      if (!spenderName || !rules.spenders.includes(spenderName)) fail(`step ${n} approves ${spender}, which this action never needs`);
      const held = await pub.readContract({ address: s.to, abi: erc20Abi, functionName: "balanceOf", args: [me()] });
      if (amount > held) fail(`step ${n} approves more than the wallet holds`);
      lines.push(`approve exactly ${await tokenAmount(pub, s.to, amount)} for ${spenderName}`);
      continue;
    }

    const allowed = rules.calls[name];
    if (!allowed) fail(`step ${n} calls ${name}, which ${action} never does`);
    let call;
    try {
      call = decodeFunctionData({ abi: ABI_OF[name], data: s.data });
    } catch {
      fail(`step ${n} calls a function on ${name} this script does not allow`);
    }
    const fn = call.functionName;
    if (!allowed.includes(fn)) fail(`step ${n} calls ${name}.${fn}, which ${action} never does`);
    const a = call.args;

    if (name === "permit2") {
      if (getAddress(a[1]) !== getAddress(PINNED[s.chainId].uniswapRouter)) fail(`step ${n} gives Permit2 rights to an unknown spender`);
      const held = await pub.readContract({ address: a[0], abi: erc20Abi, functionName: "balanceOf", args: [me()] });
      if (a[2] > held) fail(`step ${n} gives Uniswap's router more than the wallet holds`);
      if (a[3] > Math.floor(Date.now() / 1000) + 3600) fail(`step ${n} gives Uniswap's router rights for more than an hour`);
      if (value !== 0n) fail(`step ${n} sends ETH to Permit2`);
    }
    if (name === "relayDepository" && getAddress(a[0]) !== me()) fail(`step ${n} deposits for ${a[0]}, not this wallet`);
    if (fn === "reclaim" && getAddress(a[2]) !== me()) fail(`step ${n} takes boxes back to ${a[2]}, not this wallet`);
    if (fn === "sendCards") {
      if (isAddress(request.to ?? "")) {
        if (getAddress(a[0]) !== getAddress(request.to)) fail(`step ${n} sends to ${a[0]}, not ${request.to}`);
      } else if (yes) fail("with --yes, give `to` as an address: a name is resolved by the API and needs your own look");
    }
    if (fn === "create" || fn === "buy") {
      // create(items, boxes, recipients, opt, permits); the router's buy(items, legs, boxes, recipients, opt, pay)
      const [recipients, opt] = fn === "create" ? [a[2], a[3]] : [a[3], a[4]];
      if (opt.frontend !== zeroAddress || opt.frontendBps !== 0) fail(`step ${n} pays a frontend fee to ${opt.frontend}`);
      if (getAddress(opt.linkKey) !== getAddress(ctx.linkKeyAddress ?? zeroAddress)) fail(`step ${n} makes a link with a key that is not the one made here`);
      const asked = Array.isArray(request.to) ? request.to : [];
      if (asked.length && asked.every((x) => isAddress(x))) {
        if (!sameSet(recipients, asked)) fail(`step ${n} gifts to other wallets than the ones asked`);
      } else if (asked.length && yes) fail("with --yes, give `to` as addresses: names are resolved by the API and need your own look");
    }
    const gifted = fn === "create" ? a[2] : fn === "buy" ? a[3] : null;
    const shown = fn === "sendCards" ? ` to ${a[0]}` : gifted ? (gifted.length ? ` for ${gifted.length} wallet(s): ${gifted.join(", ")}` : " behind a link") : "";
    lines.push(`${name}.${fn}${shown}${value ? `, sending ${formatEther(value)} ETH` : ""}`);
  }
  return lines;
}

/** The whole plan run on its chain without sending it (eth_simulateV1): what leaves and reaches the wallet. */
async function dryRun(plan) {
  const { pub } = clients[plan.steps[0].chainId];
  const calls = plan.steps.map((s) => ({ to: s.to, data: s.data, value: BigInt(s.value) }));
  let sim;
  try {
    sim = await pub.simulateCalls({ account: me(), calls, traceAssetChanges: true });
  } catch (e) {
    // only an RPC that does not run eth_simulateV1 skips the dry run; any other error stops here
    if (/method.*(not found|not supported|does not exist)|-32601/i.test(`${e?.shortMessage} ${e?.details} ${e?.code}`)) return null;
    fail(`the plan could not be run ahead: ${e?.shortMessage ?? "unknown error"}`);
  }
  const bad = sim.results.findIndex((r) => r.status !== "success");
  if (bad >= 0) fail(`step ${bad + 1} would fail: ${sim.results[bad].error?.shortMessage ?? "reverted"}`);
  return sim.assetChanges.filter((c) => c.value.diff !== 0n);
}

const changeText = (c) => `${c.value.diff > 0n ? "+" : ""}${formatUnits(c.value.diff, c.token.decimals ?? 0)} ${c.token.symbol ?? c.token.address}`;

async function confirm(plan, lines, changes, request) {
  const chainId = plan.steps[0].chainId;
  console.log(`\n${action} on ${chainId === 8453 ? "Base" : "Robinhood Chain"} from ${me()}`);
  lines.forEach((l, i) => console.log(`  ${i + 1}. ${l}`));
  if (changes) {
    console.log(`the wallet, after all steps: ${changes.map(changeText).join(", ") || "no token changes"} (plus gas)`);
    // a buy, a claim, an open of gift boxes, a take-back and a swap on one chain must bring the wallet something
    const sameChain = action !== "swap" || request.from?.chain === request.to?.chain;
    if (ACTIONS[action].gains !== false && (ACTIONS[action].gains || (action === "swap" && sameChain)) && !changes.some((c) => c.value.diff > 0n)) {
      fail("the dry run shows nothing reaching this wallet");
    }
  } else {
    if (yes) fail("this RPC could not run the plan ahead: without a dry run, send only with your own look (drop --yes)");
    console.log("this RPC could not run the plan ahead: each step is estimated before it is sent");
  }
  if (action === "swap" && request.from?.chain !== request.to?.chain) console.log("a bridge pays out on the other chain: this script cannot check that side");
  if (plan.validUntil) console.log(`send before ${new Date(plan.validUntil * 1000).toISOString()}`);
  if (yes) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`send ${plan.steps.length} transaction${plan.steps.length === 1 ? "" : "s"}? [y/N] `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") fail("not sent");
}

/** The steps in order, each once the one before is mined with success. */
async function send(plan) {
  const receipts = [];
  for (const [i, s] of plan.steps.entries()) {
    if (plan.validUntil && Date.now() / 1000 > plan.validUntil) fail("the plan is past validUntil: build it again");
    const { pub, wallet } = clients[s.chainId];
    const tx = { account, to: s.to, data: s.data, value: BigInt(s.value) };
    const gas = await pub.estimateGas(tx).catch((e) => fail(`step ${i + 1} would fail: ${e.shortMessage ?? "reverted"}`));
    const hash = await wallet.sendTransaction({ ...tx, gas: (gas * 3n) / 2n });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
    if (receipt.status !== "success") fail(`step ${i + 1} failed: ${hash}`);
    console.log(`  ${i + 1}. done ${hash}`);
    receipts.push(receipt);
  }
  return receipts;
}

async function run(body, ctx = {}) {
  const plan = await ask(ACTIONS[action].path, body);
  const lines = await check(plan, body, ctx);
  await confirm(plan, lines, await dryRun(plan), body);
  return send(plan);
}

/** A share URL from GIFT_URL or typed in: never from the command line, where shell history and `ps` keep it. */
async function shareUrl() {
  let raw = process.env.GIFT_URL;
  if (!raw) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    raw = await rl.question("share URL: ");
    rl.close();
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    fail("that is not a URL (a share URL looks like https://www.giftedstock.com/gift?batch=12#k=0x…)");
  }
  const batch = url.searchParams.get("batch") ?? "";
  const linkKey = url.hash.match(/k=(0x[0-9a-fA-F]{64})/)?.[1];
  if (!/^\d{1,15}$/.test(batch) || !linkKey) fail("a share URL looks like https://www.giftedstock.com/gift?batch=12#k=0x…");
  return { batchId: Number(batch), linkKey };
}

if (action === "claim") {
  // the link key signs here and goes nowhere: only a Claim for this wallet, this link, on the gift box contract
  const { batchId, linkKey } = await shareUrl();
  const first = await ask(ACTIONS.claim.path, { wallet: me(), batchId });
  const td = first.sign?.typedData;
  if (
    !td || td.primaryType !== "Claim" || Number(td.domain?.chainId) !== 8453 || getAddress(td.domain?.verifyingContract ?? zeroAddress) !== GIFT_BOX ||
    getAddress(td.message?.claimer ?? zeroAddress) !== me() || String(td.message?.batchId) !== String(batchId)
  ) fail("the claim to sign is not a Claim of this link for this wallet on the gift box contract");
  const signature = await privateKeyToAccount(linkKey).signTypedData({
    domain: td.domain, primaryType: "Claim", message: { batchId: BigInt(batchId), claimer: me() },
    types: { Claim: [{ name: "batchId", type: "uint256" }, { name: "claimer", type: "address" }] },
  });
  const receipts = await run({ wallet: me(), batchId, signature });
  const box = giftLog(receipts.at(-1), CLAIMED, 2);
  console.log(box !== null ? `claimed gift box #${box}: open it with gift/open` : "claimed");
} else {
  let body;
  try {
    body = { ...JSON.parse(input), wallet: me() };
  } catch {
    fail("the body must be JSON");
  }
  // a gift link's key: made here, fresh for this link, saved before anything is sent, only its address sent
  let linkKey = null;
  const ctx = {};
  if (action === "gift" && body.link) {
    if (body.link.linkKeyAddress) fail("leave link.linkKeyAddress out: this script makes the link's key itself");
    linkKey = generatePrivateKey();
    ctx.linkKeyAddress = privateKeyToAccount(linkKey).address;
    body.link = { ...body.link, linkKeyAddress: ctx.linkKeyAddress };
    const file = `giftedstock-link-${ctx.linkKeyAddress}.key`;
    writeFileSync(file, `${linkKey}\n`, { mode: 0o600 });
    console.log(`the link's key is saved in ${file} (only you can read it): keep it until the share URL is made`);
  }
  const receipts = await run(body, ctx);
  if (linkKey) {
    const batchId = giftLog(receipts.at(-1), BATCH_CREATED, 1);
    if (batchId === null) fail("the gift was made but its batch id was not in the receipt: read it on basescan and build the URL with the saved key");
    console.log(`\nshare URL (anyone holding it can claim while boxes are left):\n${SITE}/gift?batch=${batchId}#k=${linkKey}`);
  }
}
