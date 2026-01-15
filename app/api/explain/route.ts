import { NextResponse } from "next/server";
import { ethers } from "ethers";

// === Payment settings ===
const PAYMENT_ADDRESS = "0x3B5Ca729ae7D427616873f5CD0B9418243090c4c";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PRICE_USDC_UNITS = BigInt("3000000"); // 3 USDC (6 decimals)

// === RPC pool ===
const RPC_URLS = [
  "https://base.publicnode.com",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];

function short(addr?: string | null) {
  if (!addr) return "—";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function isTxHash(x: string) {
  return /^0x[a-fA-F0-9]{64}$/.test(x);
}

async function withAnyProvider<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>) {
  let lastErr: unknown = null;
  for (const url of RPC_URLS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      await p.getBlockNumber();
      return await fn(p);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("All providers failed");
}

// ---- Payment verification (lightweight) ----
async function isPaymentConfirmed(payTx: string): Promise<boolean> {
  if (!isTxHash(payTx)) return false;

  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await withAnyProvider((p) => p.getTransactionReceipt(payTx));
  } catch {
    receipt = null;
  }

  if (!receipt) return false;
  if (receipt.status !== 1) return false;

  const iface = new ethers.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);

  let paid = BigInt(0);

  for (const log of receipt.logs as any[]) {
    if (!log?.address) continue;
    if (String(log.address).toLowerCase() !== USDC_BASE.toLowerCase()) continue;

    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;

      const to = String((parsed as any).args.to).toLowerCase();
      const value = (parsed as any).args.value as bigint;

      if (to === PAYMENT_ADDRESS.toLowerCase()) paid += value;
    } catch {
      // ignore
    }
  }

  return paid >= PRICE_USDC_UNITS;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tx = (url.searchParams.get("tx") || "").trim();
  const payTx = (url.searchParams.get("payTx") || "").trim();

  const basescanUrl = tx ? `https://basescan.org/tx/${tx}` : "https://basescan.org";

  // 1) validate tx
  if (!tx || !isTxHash(tx)) {
    return NextResponse.json({
      summary: "Paste a transaction hash",
      fee: "—",
      explanation: "Enter a valid Base transaction hash (0x...) and press Explain.",
      basescan: basescanUrl,
      accessUnlocked: false, // ✅ NEVER unlock here
    });
  }

  // 2) decide unlock ONLY from payment tx (if provided)
  let accessUnlocked = false;
  if (payTx) {
    try {
      accessUnlocked = await isPaymentConfirmed(payTx);
    } catch {
      accessUnlocked = false;
    }
  }

  try {
    const transaction = await withAnyProvider((p) => p.getTransaction(tx));
    const receipt = await withAnyProvider((p) => p.getTransactionReceipt(tx));

    if (!transaction) {
      return NextResponse.json({
        summary: "We can’t load details right now",
        fee: "—",
        explanation:
          "This transaction may be real, but we couldn’t load its details at the moment. Open it on BaseScan and try again in a minute.",
        basescan: basescanUrl,
        accessUnlocked, // depends ONLY on payTx
      });
    }

    // fee (best-effort)
    let fee = "—";
    if (receipt) {
      const gasUsed = (receipt as any).gasUsed as bigint | undefined;
      const effectiveGasPrice = (receipt as any).effectiveGasPrice as bigint | undefined;
      if (typeof gasUsed === "bigint" && typeof effectiveGasPrice === "bigint") {
        const feeEth = ethers.formatEther(gasUsed * effectiveGasPrice);
        fee = `${Number(feeEth).toFixed(6)} ETH`;
      }
    }

    // basic classification
    const from = transaction.from ? ethers.getAddress(transaction.from) : null;
    const to = transaction.to ? ethers.getAddress(transaction.to) : null;

    const isEthTransfer =
      (transaction.value ?? BigInt(0)) > BigInt(0) && transaction.data === "0x";

    // lightweight "advanced" metrics (real, from logs)
    const touchedContracts = new Set<string>();
    let tokenTransfers = 0;
    let approvals = 0;

    if (receipt) {
      const iface = new ethers.Interface([
        "event Transfer(address indexed from, address indexed to, uint256 value)",
        "event Approval(address indexed owner, address indexed spender, uint256 value)",
      ]);

      for (const log of receipt.logs as any[]) {
        if (log?.address) touchedContracts.add(String(log.address).toLowerCase());

        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (!parsed) continue;
          const eventName = (parsed as any).name as string | undefined;
          if (eventName === "Transfer") tokenTransfers++;
          if (eventName === "Approval") approvals++;
        } catch {
          // ignore unknown
        }
      }
    }

    const risk =
      approvals > 0 ? "Medium" : touchedContracts.size > 1 ? "Low–Medium" : "Low";

    // what the user sees
    const summary = isEthTransfer ? "ETH transfer" : "Contract interaction";

    // ✅ IMPORTANT: we always return real facts,
    // but the UI should show "advanced block" only if accessUnlocked = true
    const explanationLines = [
      `• From: ${short(from)}`,
      `• To: ${short(to)}`,
      `• Contracts touched: ${touchedContracts.size}`,
      `• Token transfers: ${tokenTransfers}`,
      `• Approvals: ${approvals}`,
      `• Risk level: ${risk}`,
    ];

    return NextResponse.json({
      summary,
      fee,
      explanation: explanationLines.join("\n"),
      basescan: basescanUrl,
      accessUnlocked, // ✅ depends ONLY on verified payment tx
    });
  } catch {
    return NextResponse.json({
      summary: "We can’t load details right now",
      fee: "—",
      explanation:
        "We couldn’t load enough information at the moment. Open it on BaseScan and try again.",
      basescan: basescanUrl,
      accessUnlocked, // still only from payTx
    });
  }
}
