#!/usr/bin/env node
/**
 * Gifted Stock from your own wallet: asks the agent API (https://www.giftedstock.com/SKILL.md) for a plan, checks every
 * step with ../verify.mjs (the contracts, functions, inner calls, fee wallet and builder code pinned there), runs the
 * whole plan on the chain without sending it, shows you what it does and sends it only after your yes.
 *
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs buy  '{"chain":"base","box":"normal","quantity":1,"payWith":"USDC"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs swap '{"from":{"chain":"base","token":"USDC"},"to":{"chain":"base","token":"NVDAc"},"amount":"2"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs gift '{"items":[{"token":"NVDAc","usd":"1"}],"payWith":"USDC","link":{"boxes":3,"who":"anyone"}}'
 *   PRIVATE_KEY=0x… GIFT_URL='https://www.giftedstock.com/gift?batch=12#k=0x…' node examples/giftedstock.mjs claim
 *   BANKR_API_KEY=bk_… node examples/giftedstock.mjs buy '{"chain":"base","box":"normal","quantity":1,"payWith":"USDC"}' --bankr
 *
 * Actions: buy, open, send, settle, swap, gift, gift/open, gift/take-back, claim. `wallet` is filled in from the key. Add
 * --yes to send without asking (only where your human said so). BASE_RPC_URL and ROBINHOOD_RPC_URL pick other RPCs.
 *
 * The key never leaves this process: requests carry addresses and signatures only. A gift link's key is made here,
 * saved to a file only you can read before anything is sent, and only its address goes to the API.
 *
 * --bankr sends through a Bankr wallet instead (SKILL.md, "With a Bankr wallet"): the wallet is the Bankr key's EVM
 * address (GET /wallet/me), each step goes to Bankr's POST /wallet/submit as it is, and BANKR_API_KEY goes to
 * api.bankr.bot only. The checks and the dry run are the same.
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";
import { PINNED, verifyPlan } from "../verify.mjs";

const API = "https://www.giftedstock.com/api/agent/v1";
const SITE = "https://www.giftedstock.com";
const BANKR = "https://api.bankr.bot";

const GIFT_BOX = PINNED[8453].giftBox;

/** Each action: its endpoint, the plan it answers with, and whether a dry run must show the wallet gaining. */
const ACTIONS = {
  buy: { path: "tx/buy", plan: "buy", gains: true },
  open: { path: "tx/open", plan: "open" },
  send: { path: "tx/send", plan: "send" },
  settle: { path: "tx/settle", plan: "settle" },
  swap: { path: "tx/swap", plan: "swap" },
  gift: { path: "tx/gift", plan: "gift_create" },
  "gift/open": { path: "tx/gift/open", plan: "gift_open", gains: true },
  "gift/take-back": { path: "tx/gift/take-back", plan: "gift_take_back", gains: true },
  claim: { path: "tx/gift/claim", plan: "gift_claim", gains: true },
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
const bankr = flags.includes("--bankr");
if (!(action in ACTIONS) || (action !== "claim" && (!input || input.startsWith("--")))) {
  fail("usage: node examples/giftedstock.mjs <buy|open|send|settle|swap|gift|gift/open|gift/take-back> '<json body>' [--yes] [--bankr], or GIFT_URL='<share url>' node examples/giftedstock.mjs claim [--yes] [--bankr]");
}

/** Bankr's Wallet API with the key from BANKR_API_KEY: the key goes in its header to api.bankr.bot, nowhere else. */
async function bankrApi(path, body) {
  const res = await fetch(`${BANKR}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": process.env.BANKR_API_KEY, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, out: await res.json().catch(() => null) };
}

let account = null;
let address;
if (bankr) {
  if (process.env.PRIVATE_KEY) fail("--bankr sends through Bankr: leave PRIVATE_KEY unset");
  if (!process.env.BANKR_API_KEY) fail("--bankr needs BANKR_API_KEY: a Bankr API key with Wallet API access that is not read-only");
  const { res, out } = await bankrApi("/wallet/me");
  const evm = out?.wallets?.find?.((w) => w.chain === "evm")?.address;
  if (!res.ok || !evm) fail(`Bankr's /wallet/me answered ${res.status}${typeof out?.error === "string" ? `: ${out.error.slice(0, 200)}` : ""}`);
  address = getAddress(evm);
} else {
  if (!/^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY ?? "")) fail("PRIVATE_KEY must be set to your wallet's key (0x and 64 hex), or use --bankr with BANKR_API_KEY");
  account = privateKeyToAccount(process.env.PRIVATE_KEY);
  address = account.address;
}

const clients = Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [id, {
  pub: createPublicClient({ chain: c.chain, transport: http(c.rpc) }),
  wallet: account ? createWalletClient({ account, chain: c.chain, transport: http(c.rpc) }) : null,
}]));

async function ask(path, body) {
  const res = await fetch(`${API}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out) fail(out && typeof out.error === "string" ? `${out.error}: ${String(out.message).slice(0, 300)}` : `the API answered ${res.status}`);
  return out;
}

const me = () => address;
const pubs = Object.fromEntries(Object.entries(clients).map(([id, c]) => [id, c.pub]));

/**
 * Each step checked before anything is signed (../verify.mjs): its chain, contract, function and every argument that
 * says who gains, the calls inside a swap, exact approvals no larger than the wallet holds. Returns each step in words.
 */
async function check(plan, request, ctx) {
  const asked = action === "swap" ? (request.from?.chain === request.to?.chain ? "swap" : "bridge")
    : action === "gift" ? (request.link ? "gift_link_create" : "gift_create")
    : ACTIONS[action].plan;
  const r = await verifyPlan(plan, { wallet: me(), action: asked, request, linkKeyAddress: ctx.linkKeyAddress, clients: pubs });
  if (!r.ok) fail(r.problems.join("; "));
  if (r.review.length && yes) fail(`with --yes, give addresses rather than names or symbols: ${r.review.join("; ")}`);
  return { lines: [...r.lines, ...r.review.map((l) => `look yourself: ${l}`), ...r.unchecked.map((l) => `not checked: ${l}`)], expect: r.expect };
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

// how simulateCalls names ETH among the asset changes
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const tokenKey = (t) => (t === zeroAddress ? NATIVE : t.toLowerCase());
const GAS = 10n ** 15n;

/** A swap or bridge's dry run against what verify.mjs expects: exactly the amount asked leaves the wallet, nothing
 *  else does, and at least the minimum arrives. */
function heldTo(expect, changes) {
  const diff = (t) => changes.filter((c) => c.token.address.toLowerCase() === tokenKey(t)).reduce((a, c) => a + c.value.diff, 0n);
  // a node may charge the dry run's gas in ETH: up to GAS of it is gas, not the plan
  const gas = (t) => (tokenKey(t) === NATIVE ? GAS : 0n);
  for (const s of expect.spend) {
    const took = -diff(s.token);
    if (took < s.amount || took > s.amount + gas(s.token)) fail(`the dry run takes ${took} of ${s.token} from the wallet, not the ${s.amount} asked`);
  }
  const spent = new Set(expect.spend.map((s) => tokenKey(s.token)));
  const other = changes.find((c) => c.value.diff < -gas(c.token.address.toLowerCase() === NATIVE ? zeroAddress : c.token.address) && !spent.has(c.token.address.toLowerCase()));
  if (other) fail(`the dry run also takes ${changeText(other)} from the wallet`);
  for (const g of expect.gain) if (diff(g.token) < g.atLeast) fail(`the dry run brings ${diff(g.token)} of ${g.token}, under the ${g.atLeast} promised`);
}

const changeText = (c) => `${c.value.diff > 0n ? "+" : ""}${formatUnits(c.value.diff, c.token.decimals ?? 0)} ${c.token.symbol ?? c.token.address}`;

async function confirm(plan, { lines, expect }, changes, request) {
  const chainId = plan.steps[0].chainId;
  console.log(`\n${action} on ${chainId === 8453 ? "Base" : "Robinhood Chain"} from ${me()}${bankr ? " (a Bankr wallet)" : ""}`);
  lines.forEach((l) => console.log(`  ${l}`));
  if (changes) {
    console.log(`the wallet, after all steps: ${changes.map(changeText).join(", ") || "no token changes"} (plus gas)`);
    if (expect) heldTo(expect, changes);
    // a buy, a claim, an open of gift boxes, a take-back and a swap on one chain must bring the wallet something
    const sameChain = action !== "swap" || request.from?.chain === request.to?.chain;
    if (ACTIONS[action].gains !== false && (ACTIONS[action].gains || (action === "swap" && sameChain)) && !changes.some((c) => c.value.diff > 0n)) {
      fail("the dry run shows nothing reaching this wallet");
    }
  } else {
    if (yes) fail("this RPC could not run the plan ahead: without a dry run, send only with your own look (drop --yes)");
    console.log("this RPC could not run the plan ahead: each step is estimated before it is sent");
  }
  if (plan.validUntil) console.log(`send before ${new Date(plan.validUntil * 1000).toISOString()}`);
  if (yes) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // no terminal to answer (stdin closed): the same as no
  const answer = await new Promise((resolve) => {
    rl.once("close", () => resolve(""));
    rl.question(`send ${plan.steps.length} transaction${plan.steps.length === 1 ? "" : "s"}? [y/N] `).then(resolve, () => resolve(""));
  });
  rl.close();
  if (answer.trim().toLowerCase() !== "y") fail("not sent");
}

/** One step through Bankr's /wallet/submit, as it is: a refusal stops here, and a step sent but not mined with success
 *  stops with its hash, never sent again (the endpoint takes no idempotency key). Its label in Bankr's activity is this
 *  script's own, never the API's text (SKILL.md rule 8). */
async function bankrSubmit(s, i, total, gas) {
  const maybeSent = (why) => fail(`step ${i + 1}: ${why}. It may have been sent: look at the wallet's activity before running anything again`);
  let res, out;
  try {
    ({ res, out } = await bankrApi("/wallet/submit", {
      transaction: { to: s.to, data: s.data, value: s.value, chainId: s.chainId, gas: gas.toString() },
      description: `Gifted Stock ${action}, step ${i + 1} of ${total}`,
      waitForConfirmation: true,
    }));
  } catch (e) {
    maybeSent(`the request to Bankr broke off (${String(e?.cause?.code ?? e?.message ?? "no answer").slice(0, 80)})`);
  }
  const hash = typeof out?.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(out.transactionHash) ? out.transactionHash : null;
  if (res.ok && out?.success !== false && hash) return hash;
  if (res.ok && !hash) maybeSent(`Bankr answered ${res.status} without a transaction hash`);
  if (hash) fail(`step ${i + 1} was sent and did not succeed (${String(out?.status ?? res.status).slice(0, 40)}): ${hash}. Look it up before sending anything again`);
  // Bankr's words as they are: its code, its error and message, and any link it gives (an approval, its docs)
  const said = [out?.errorCode ?? out?.code, out?.error, out?.message].filter((x) => typeof x === "string").join(": ").slice(0, 500);
  const links = Object.entries(out ?? {}).filter(([k, v]) => typeof v === "string" && /url|link/i.test(k)).map(([k, v]) => `${k}: ${v.slice(0, 300)}`);
  fail(`Bankr did not send step ${i + 1} (${res.status}): ${said || "no reason given"}${links.length ? `\n  ${links.join("\n  ")}` : ""}${out && typeof out === "object" ? `\n  (its answer's fields: ${Object.keys(out).join(", ")})` : ""}. Only your human can change their Bankr settings`);
}

/** A step's gas, estimated from the wallet. Right after the step before it is mined, an RPC behind a load balancer may
 *  not have that block yet (Bankr's first real run: the buy estimated against a node without its approval), so a later
 *  step is estimated again for up to ten seconds before its revert counts. */
async function estimate(pub, tx, i) {
  for (let tries = i === 0 ? 1 : 6; ; tries--) {
    try {
      return await pub.estimateGas(tx);
    } catch (e) {
      if (tries <= 1) fail(`step ${i + 1} would fail: ${e.shortMessage ?? "reverted"}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** The steps in order, each once the one before is mined with success. */
async function send(plan) {
  const receipts = [];
  for (const [i, s] of plan.steps.entries()) {
    if (plan.validUntil && Date.now() / 1000 > plan.validUntil) fail("the plan is past validUntil: build it again");
    const { pub, wallet } = clients[s.chainId];
    const tx = { account: account ?? me(), to: s.to, data: s.data, value: BigInt(s.value) };
    const gas = await estimate(pub, tx, i);
    const hash = bankr ? await bankrSubmit(s, i, plan.steps.length, (gas * 3n) / 2n) : await wallet.sendTransaction({ ...tx, gas: (gas * 3n) / 2n });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
    if (receipt.status !== "success") fail(`step ${i + 1} failed: ${hash}`);
    console.log(`  ${i + 1}. done ${hash}`);
    receipts.push(receipt);
  }
  return receipts;
}

async function run(body, ctx = {}) {
  const plan = await ask(ACTIONS[action].path, body);
  const checked = await check(plan, body, ctx);
  await confirm(plan, checked, await dryRun(plan), body);
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
