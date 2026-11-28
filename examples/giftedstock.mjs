#!/usr/bin/env node
/**
 * Gifted Stock from your own wallet: asks the agent API (https://www.giftedstock.com/SKILL.md) for a plan, checks every
 * step with ../verify.mjs (the contracts, functions, inner calls, fee wallet and builder code pinned there), runs the
 * whole plan on the chain without sending it, shows you what it does and sends it only after your yes.
 *
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs buy  '{"chain":"base","box":"normal","quantity":1,"payWith":"USDC"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs swap '{"from":{"chain":"base","token":"USDC"},"to":{"chain":"base","token":"NVDAc"},"amount":"2"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs gift '{"items":[{"token":"NVDAc","usd":"1"}],"payWith":"USDC","link":{"boxes":3,"who":"anyone"}}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs basket '{"basket":"a1b2c","quantity":1,"payWith":"USDC"}'
 *   PRIVATE_KEY=0x… GIFT_URL='https://www.giftedstock.com/gift?batch=12#k=0x…' node examples/giftedstock.mjs claim
 *   BANKR_API_KEY=bk_… node examples/giftedstock.mjs buy '{"chain":"base","box":"normal","quantity":1,"payWith":"USDC"}' --bankr
 *
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs login                       (the agent token, 24 hours)
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs partner  '{"action":"create","chain":"base","payWith":"USDC","profile":{"name":"Acme","slug":"acme","logo":"logo.png"}}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs upload   '{"slug":"acme","kind":"banner","file":"banner.png"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs call     '{"method":"POST","path":"/api/partner/acme/campaigns","body":{...}}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs campaign '{"action":"launch","slug":"acme","code":"a1b2c","partnerId":"12","prize":{...}}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs join     '{"code":"a1b2c"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs basket/create '{"name":"AI LEADERS","items":[{"token":"0x…","usd":"0.90"},{"token":"0x…","usd":"0.10"}],"payWith":"USDC"}'
 *   PRIVATE_KEY=0x… node examples/giftedstock.mjs campaign '{"action":"claim","code":"a1b2c","chain":"base","campaignId":"7"}'
 *
 * Actions: buy, open, send, settle, swap, gift, basket, gift/open, gift/take-back, claim; 1.5.0: login, logout, partner,
 * campaign, upload, call, join, basket/create. After a buy, a gift, a basket or a claim it prints the ids of the boxes made. `wallet` is filled in from the
 * key, and `skill` with this repo's version (SKILL.md rule 12). Add --yes to send without asking (only where your human
 * said so). BASE_RPC_URL and ROBINHOOD_RPC_URL pick other RPCs.
 *
 * The key never leaves this process: requests carry addresses and signatures only. A gift link's key is made here,
 * saved to a file only you can read before anything is sent, and only its address goes to the API.
 *
 * --bankr sends through a Bankr wallet instead (SKILL.md, "With a Bankr wallet"): the wallet is the Bankr key's EVM
 * address (GET /wallet/me), each step goes to Bankr's POST /wallet/submit as it is, and BANKR_API_KEY goes to
 * api.bankr.bot only. The checks and the dry run are the same.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, formatUnits, getAddress, http, parseAbi, parseEventLogs, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, robinhood } from "viem/chains";
import { PINNED, VERSION, verifyPlan } from "../verify.mjs";

const API = "https://www.giftedstock.com/api/agent/v1";
const SITE = "https://www.giftedstock.com";
const BANKR = "https://api.bankr.bot";

const GIFT_BOX = PINNED[8453].giftBox;
// an ERC-721 Transfer's topic, and the contracts whose new tokens are boxes
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BOXES = new Set([PINNED[8453].normalBox, PINNED[8453].premiumBox, PINNED[8453].giftBox, PINNED[4663].normalBox, PINNED[4663].premiumBox].map(getAddress));
// the vault's own events: a new partner's id and a launched campaign's, read off your receipts (requests name them after)
const VAULT_EVENTS = parseAbi([
  "event PartnerCreated(uint64 indexed partnerId, address indexed owner, uint256 feeUsdc, uint256 feeWei)",
  "event Claimed(uint64 indexed campaignId, address indexed wallet, address to, uint256[] ids)",
  "event CampaignLaunched(uint64 indexed campaignId, uint64 indexed partnerId, address indexed box, (uint64 partnerId,address box,uint8 style,uint32 perWinner,uint40 startsAt,uint40 endsAt,bytes32 ref) terms, uint32 boxes, uint40 claimUntil)",
]);
// the campaign vault on either chain (a receipt is from one of them)
const VAULTS_PINNED = [PINNED[8453].campaignVault, PINNED[4663].campaignVault].map(getAddress);
const vaultEvent = (receipt, name) => parseEventLogs({ abi: VAULT_EVENTS, eventName: name, logs: receipt.logs }).find((l) => VAULTS_PINNED.includes(getAddress(l.address)))?.args ?? null;

/** Each action: its endpoint, the plan it answers with, and whether a dry run must show the wallet gaining. */
const ACTIONS = {
  buy: { path: "tx/buy", plan: "buy", gains: true },
  open: { path: "tx/open", plan: "open" },
  send: { path: "tx/send", plan: "send" },
  settle: { path: "tx/settle", plan: "settle" },
  swap: { path: "tx/swap", plan: "swap" },
  gift: { path: "tx/gift", plan: "gift_create" },
  basket: { path: "tx/basket", plan: "basket_buy" },
  // 1.5.0: a new basket and its first box (it goes live when that box lands)
  "basket/create": { path: "tx/basket/create", plan: "basket_create" },
  "gift/open": { path: "tx/gift/open", plan: "gift_open", gains: true },
  "gift/take-back": { path: "tx/gift/take-back", plan: "gift_take_back", gains: true },
  claim: { path: "tx/gift/claim", plan: "gift_claim", gains: true },
  // 1.5.0: partners and campaigns. The plan is the body's own `action` (verify.mjs reads it from the request)
  partner: { path: "tx/partner", plan: null },
  campaign: { path: "tx/campaign", plan: null },
  // the agent token, and the site's partner routes with it (no plan: nothing is sent on a chain)
  login: { path: null },
  logout: { path: null },
  call: { path: null },
  upload: { path: null },
  join: { path: null },
};
const NO_INPUT = new Set(["claim", "login", "logout"]);

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
if (!(action in ACTIONS) || (!NO_INPUT.has(action) && (!input || input.startsWith("--")))) {
  fail("usage: node examples/giftedstock.mjs <buy|open|send|settle|swap|gift|basket|basket/create|gift/open|gift/take-back|partner|campaign|call|upload> '<json body>' [--yes] [--bankr], GIFT_URL='<share url>' node examples/giftedstock.mjs claim [--yes] [--bankr], or node examples/giftedstock.mjs login|logout [--bankr]");
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

// ── the agent token (1.5.0) ─────────────────────────────────────────────────────────────────────────────────
/** Where `login` keeps the wallet's agent token (readable by you only); GS_AGENT_TOKEN wins over it. */
const tokenFile = () => `giftedstock-agent-${address}.token`;
function partnerToken() {
  if (process.env.GS_AGENT_TOKEN) return process.env.GS_AGENT_TOKEN.trim();
  return existsSync(tokenFile()) ? readFileSync(tokenFile(), "utf8").trim() : null;
}
const authHeader = () => {
  const t = partnerToken();
  return t ? { authorization: `Bearer ${t}` } : {};
};

/** A plain message signed by the wallet (EIP-191): the key here, or Bankr's /wallet/sign (personal_sign). */
async function signMessage(message) {
  if (account) return account.signMessage({ message });
  const { res, out } = await bankrApi("/wallet/sign", { signatureType: "personal_sign", message });
  if (!res.ok || typeof out?.signature !== "string") fail(`Bankr did not sign (${res.status}): ${String(out?.error ?? out?.message ?? "no reason given").slice(0, 300)}`);
  return out.signature;
}

/**
 * One of the site's partner routes with the agent token (a program's request: no cookie). A 428 is the site asking the
 * wallet to confirm exactly this action: its message is shown in full, checked to be the site's for this wallet, and
 * signed only after your yes (or --yes), then the same body goes again with the signature.
 */
async function partnerApi(method, path, body) {
  if (!/^\/api\/(partner|campaign|verify)\//.test(path)) fail("call takes the site's partner, campaign and verify routes only (/api/partner/..., /api/campaign/..., /api/verify/...)");
  if (!partnerToken()) fail("no agent token: run `node examples/giftedstock.mjs login` first");
  const go = async (b) => {
    const res = await fetch(`${SITE}${path}`, { method, headers: { ...authHeader(), ...(b !== undefined ? { "content-type": "application/json" } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
    return { res, out: await res.json().catch(() => null) };
  };
  let { res, out } = await go(body);
  // a transaction that just landed, on a node of the site's a block behind: asked again for half a minute
  for (let i = 0; i < 10 && res.status === 409 && /isn't on the chain yet/.test(String(out?.error)); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    ({ res, out } = await go(body));
  }
  if (res.status === 428 && out?.confirm?.message && out?.confirm?.nonce) {
    const m = String(out.confirm.message);
    if (!m.startsWith(`${new URL(SITE).host} asks you to confirm:`) || !m.includes(`Wallet: ${getAddress(address)}`)) fail("the confirmation to sign is not the site's for this wallet");
    console.log(`\nthe site asks this wallet to confirm:\n${m.split("\n").map((l) => `  ${l}`).join("\n")}`);
    if (!yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = await new Promise((resolve) => {
        rl.once("close", () => resolve(""));
        rl.question("sign it? [y/N] ").then(resolve, () => resolve(""));
      });
      rl.close();
      if (String(a).trim().toLowerCase() !== "y") fail("not signed");
    }
    const signature = await signMessage(m);
    ({ res, out } = await go({ ...(body ?? {}), confirm: { nonce: out.confirm.nonce, signature } }));
  }
  if (!res.ok) fail(`${method} ${path} answered ${res.status}: ${String(out?.error ?? out?.message ?? "no reason given").slice(0, 300)}`);
  return out;
}

async function ask(path, body) {
  const res = await fetch(`${API}/${path}`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify(body) });
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
    : ACTIONS[action].plan ?? undefined;
  const r = await verifyPlan(plan, { wallet: me(), action: asked, request, linkKeyAddress: ctx.linkKeyAddress, clients: pubs });
  if (!r.ok) fail(r.problems.join("; "));
  // --yes only when nothing needs your own look: names and symbols resolved by the API, a box design you described, a
  // basket's maker and mix (always: the basket's page shows them)
  if (r.review.length && yes) fail(`with --yes nothing may need your own look (give addresses rather than names or symbols; a basket always needs it): ${r.review.join("; ")}`);
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
  const receipts = await send(plan);
  // the boxes this made: every ERC-721 Transfer from nobody on a pinned box or the gift box (mystery boxes, gift boxes)
  const made = receipts.flatMap((r) => r.logs.filter((l) => l.topics[0] === TRANSFER && l.topics.length === 4 && BigInt(l.topics[1]) === 0n && BOXES.has(getAddress(l.address)))
    .map((l) => `${l.address === GIFT_BOX || getAddress(l.address) === GIFT_BOX ? "gift box" : "box"} #${BigInt(l.topics[3])} to ${getAddress(`0x${l.topics[2].slice(26)}`)}`));
  if (made.length) console.log(`made: ${made.join(", ")}`);
  return receipts;
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

if (action === "login") {
  // the sign-in for the partner routes: a message for this site and this wallet, signed here, a token for 24 hours
  const r = await fetch(`${API}/session?wallet=${address}`);
  const { message } = await r.json().catch(() => ({}));
  if (!r.ok || typeof message !== "string") fail(`the sign-in message could not be had (${r.status})`);
  const host = new URL(SITE).host;
  if (!message.startsWith(`${host} wants you to sign in with your Ethereum account:\n${getAddress(address)}\n`) || !/Sign in your agent to manage your campaigns on Gifted Stock/.test(message)) fail("the sign-in message is not the site's for this wallet");
  console.log(`signing in, the wallet signs:\n${message.split("\n").map((l) => `  ${l}`).join("\n")}`);
  const signature = await signMessage(message);
  const res = await fetch(`${API}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) });
  const out = await res.json().catch(() => null);
  if (!res.ok || typeof out?.token !== "string") fail(`sign-in refused (${res.status}): ${String(out?.message ?? out?.error ?? "").slice(0, 200)}`);
  writeFileSync(tokenFile(), `${out.token}\n`, { mode: 0o600 });
  // a file kept from an earlier sign-in keeps its own mode: set it again
  chmodSync(tokenFile(), 0o600);
  console.log(`signed in until ${out.expiresAt}: the token is in ${tokenFile()} (only you can read it). Keep it secret: it runs your partners`);
} else if (action === "logout") {
  const res = await fetch(`${API}/session`, { method: "DELETE", headers: authHeader() });
  console.log(res.ok ? "signed out everywhere: every agent token and site sign-in of this wallet stopped working" : `sign-out answered ${res.status}`);
} else if (action === "call") {
  // { method, path, body }: a partner route, e.g. save a campaign (POST /api/partner/<slug>/campaigns)
  let c;
  try {
    c = JSON.parse(input);
  } catch {
    fail("the body must be JSON: { method, path, body }");
  }
  if (!["GET", "POST", "PUT", "DELETE"].includes(c?.method)) fail("method: GET, POST, PUT or DELETE");
  console.log(JSON.stringify(await partnerApi(c.method, String(c.path ?? ""), c.method === "GET" ? undefined : c.body ?? {}), null, 2));
} else if (action === "join") {
  // { code }: join a campaign once every task is done - a raffle's draw, or a first-come campaign outside the vault (its
  // slot and boxes at once); a first-come campaign in the vault takes no join: `campaign` with action claim takes its slot.
  // The wallet signs a line naming the campaign, nothing else
  let jb;
  try {
    jb = JSON.parse(input);
  } catch {
    fail("the body must be JSON: { code }");
  }
  const code = String(jb?.code ?? "");
  if (!/^[a-z0-9]{5}(-[a-z0-9]{5})?$/.test(code)) fail("code: the campaign's code, or its private link's code-key");
  if (!partnerToken()) fail("no agent token: run `node examples/giftedstock.mjs login` first");
  const r = await fetch(`${SITE}/api/campaign/${code}/join?address=${address}`);
  const { message } = await r.json().catch(() => ({}));
  if (!r.ok || typeof message !== "string") fail(`the join message could not be had (${r.status})`);
  const host = new URL(SITE).host;
  if (!/^.+ wants you to (join|claim from) ".*" \([a-z0-9-]+\/[A-Za-z0-9_-]+\)\.\n/.test(message) || !message.startsWith(`${host} wants you to `) || !message.includes(`Wallet: ${getAddress(address)}`)) fail("the join message is not the site's for this wallet");
  console.log(`\nthe wallet signs:\n${message.split("\n").map((l) => `  ${l}`).join("\n")}`);
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = await new Promise((resolve) => {
      rl.once("close", () => resolve(""));
      rl.question("sign it? [y/N] ").then(resolve, () => resolve(""));
    });
    rl.close();
    if (String(a).trim().toLowerCase() !== "y") fail("not signed");
  }
  const signature = await signMessage(message);
  const res = await fetch(`${SITE}/api/campaign/${code}/join`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ message, signature }) });
  const out = await res.json().catch(() => null);
  if (!res.ok) fail(`join answered ${res.status}: ${String(out?.error ?? "").slice(0, 200)}${out?.identity ? " (GET /api/agent/v1/verify?wallet= says how to verify)" : ""}`);
  console.log(JSON.stringify(out, null, 2));
} else if (action === "upload") {
  // { slug, kind: "banner" | "logo", file }: an image for a campaign's bannerUrl or the partner's logo
  let u;
  try {
    u = JSON.parse(input);
  } catch {
    fail("the body must be JSON: { slug, kind, file }");
  }
  if (!/^[a-z0-9-]{2,32}$/.test(u?.slug ?? "") || !["banner", "logo"].includes(u?.kind)) fail("slug and kind (banner or logo)");
  if (!partnerToken()) fail("no agent token: run `node examples/giftedstock.mjs login` first");
  const bytes = readFileSync(String(u.file));
  const type = /\.png$/i.test(u.file) ? "image/png" : /\.jpe?g$/i.test(u.file) ? "image/jpeg" : /\.webp$/i.test(u.file) ? "image/webp" : fail("file: a png, jpg or webp");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), String(u.file).split("/").pop());
  const res = await fetch(`${SITE}/api/partner/${u.slug}/upload?kind=${u.kind}`, { method: "POST", headers: authHeader(), body: form });
  const out = await res.json().catch(() => null);
  if (!res.ok) fail(`upload answered ${res.status}: ${String(out?.error ?? "").slice(0, 200)}`);
  console.log(JSON.stringify(out, null, 2));
} else if (action === "partner" || action === "campaign") {
  let body;
  try {
    body = { ...JSON.parse(input), wallet: me(), skill: VERSION };
  } catch {
    fail("the body must be JSON");
  }
  // a new partner's page, registered once its createPartner lands: { name, slug, description, site, logo: a file }
  const profile = action === "partner" && body.action === "create" ? body.profile ?? null : null;
  delete body.profile;
  if (profile && !partnerToken()) fail("registering the partner needs your agent token: run `node examples/giftedstock.mjs login` first");
  let logoData;
  if (profile?.logo) {
    const f = String(profile.logo);
    const type = /\.png$/i.test(f) ? "png" : /\.jpe?g$/i.test(f) ? "jpeg" : /\.webp$/i.test(f) ? "webp" : fail("profile.logo: a png, jpg or webp file");
    logoData = `data:image/${type};base64,${readFileSync(f).toString("base64")}`;
  }
  const page = profile ? { name: profile.name, slug: profile.slug, description: profile.description, site: profile.site, wallet: me(), logoData } : null;
  if (page) {
    // the page checked before any fee is paid (slug, name, logo, the wallet's partners): the site's own check
    const pre = await partnerApi("POST", "/api/partner/create", { ...page, check: true });
    if (pre.onChain) {
      // this wallet already runs a vault partner with no page: that one is registered, nothing to pay
      const out = await partnerApi("POST", "/api/partner/create", page);
      console.log(`partner made: ${SITE}/partner/${out.partner?.slug ?? page.slug}, vault partner #${pre.onChain.id} on ${pre.onChain.chain} - name it as "partnerId" in its campaigns' requests`);
      process.exit(0);
    }
  }
  const receipts = await run(body);
  const hash = receipts.at(-1).transactionHash;
  if (action === "campaign" && body.action === "claim") {
    // each claim transaction told to the site (the vault's index counts them within a minute anyway)
    for (const r of receipts) await partnerApi("POST", `/api/campaign/${body.code}/vault-claim`, { hash: r.transactionHash });
    const ids = receipts.flatMap((r) => (vaultEvent(r, "Claimed")?.ids ?? []).map(String));
    console.log(`claimed (${receipts.map((r) => r.transactionHash).join(", ")}): ${ids.length ? `box${ids.length === 1 ? "" : "es"} #${ids.join(", #")}` : "the boxes"} in your wallet, sealed`);
  } else if (action === "campaign") {
    const counted = { launch: "launched", raise: "raised", cancel: "cancelled" }[body.action];
    // the site counts it now (the vault's index does within a minute anyway); never sent twice, only counted again
    console.log(`sent ${hash}: counting it on the site (if this stops, POST the same hash again later; never send it twice)`);
    await partnerApi("POST", `/api/partner/${body.slug}/campaigns/${body.code}/vault`, { action: counted, hash });
    const launched = body.action === "launch" ? vaultEvent(receipts.at(-1), "CampaignLaunched") : null;
    console.log(`${counted} (${hash})${launched ? `: vault campaign #${launched.campaignId} - name it as "campaignId" to raise or cancel it` : ""}`);
  } else if (body.action === "manager") {
    await partnerApi("POST", `/api/partner/${body.slug}/managers`, { wallet: body.manager, chain: body.chain, hash });
    console.log(`manager ${body.on ? "named" : "removed"} (${hash})`);
  } else if (page) {
    const out = await partnerApi("POST", "/api/partner/create", { ...page, vault: { chain: body.chain, hash } });
    const made = vaultEvent(receipts.at(-1), "PartnerCreated");
    console.log(`partner made: ${SITE}/partner/${out.partner?.slug ?? page.slug}${made ? `, vault partner #${made.partnerId} - name it as "partnerId" in its campaigns' requests` : ""}`);
  } else {
    const made = body.action === "create" ? vaultEvent(receipts.at(-1), "PartnerCreated") : null;
    console.log(`done (${hash})${made ? `: vault partner #${made.partnerId}; register the page with POST /api/partner/create and vault: { chain, hash }` : ""}`);
  }
} else if (action === "claim") {
  // the link key signs here and goes nowhere: only a Claim for this wallet, this link, on the gift box contract
  const { batchId, linkKey } = await shareUrl();
  const first = await ask(ACTIONS.claim.path, { wallet: me(), skill: VERSION, batchId });
  const td = first.sign?.typedData;
  if (
    !td || td.primaryType !== "Claim" || Number(td.domain?.chainId) !== 8453 || getAddress(td.domain?.verifyingContract ?? zeroAddress) !== GIFT_BOX ||
    getAddress(td.message?.claimer ?? zeroAddress) !== me() || String(td.message?.batchId) !== String(batchId)
  ) fail("the claim to sign is not a Claim of this link for this wallet on the gift box contract");
  const signature = await privateKeyToAccount(linkKey).signTypedData({
    domain: td.domain, primaryType: "Claim", message: { batchId: BigInt(batchId), claimer: me() },
    types: { Claim: [{ name: "batchId", type: "uint256" }, { name: "claimer", type: "address" }] },
  });
  const receipts = await run({ wallet: me(), skill: VERSION, batchId, signature });
  const box = giftLog(receipts.at(-1), CLAIMED, 2);
  console.log(box !== null ? `claimed gift box #${box}: open it with gift/open` : "claimed");
} else {
  let body;
  try {
    body = { ...JSON.parse(input), wallet: me(), skill: VERSION };
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
  if (action === "basket") {
    // a basket buy filed now under its basket (the gift index does within minutes anyway)
    const tx = receipts.at(-1).transactionHash;
    await fetch(`${SITE}/api/basket/record`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ tx }) }).catch(() => null);
  }
  if (action === "basket/create") {
    // the site files the first box now (the gift index does within minutes anyway): the basket goes live with it
    const tx = receipts.at(-1).transactionHash;
    const res = await fetch(`${SITE}/api/basket/record`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ tx }) });
    const out = await res.json().catch(() => null);
    console.log(res.ok ? `basket live: ${SITE}/basket/${out?.slugs?.[0] ?? "<code>"} (${tx})` : `sent (${tx}); the site did not file it yet (${res.status}): it goes live within minutes`);
  }
  if (linkKey) {
    const batchId = giftLog(receipts.at(-1), BATCH_CREATED, 1);
    if (batchId === null) fail("the gift was made but its batch id was not in the receipt: read it on basescan and build the URL with the saved key");
    console.log(`\nshare URL (anyone holding it can claim while boxes are left):\n${SITE}/gift?batch=${batchId}#k=${linkKey}`);
  }
}
