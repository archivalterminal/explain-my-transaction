import { NextResponse } from "next/server";
import { ethers } from "ethers";

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

function getBigInt(obj: unknown, key: string): bigint | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as any)[key];
  return typeof v === "bigint" ? v : null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const tx = (url.searchParams.get("tx") || "").trim();
  const basescanUrl = tx ? `https://basescan.org/tx/${tx}` : "https://basescan.org";

  if (!tx || !isTxHash(tx)) {
    return NextResponse.json({
      summary: "Paste a transaction hash",
      explanation: "Enter a valid Base transaction hash to see what really happened.",
      basescan: basescanUrl,
      accessUnlocked: false,
    });
  }

  try {
    const transaction = await withAnyProvider((p) => p.getTransaction(tx));
    const receipt = await withAnyProvider((p) => p.getTransactionReceipt(tx));

    if (!transaction || !receipt) {
      return NextResponse.json({
        summary: "Transaction found",
        explanation: "We found this transaction, but details are still loading. Try again shortly.",
        basescan: basescanUrl,
        accessUnlocked: false,
      });
    }

    const from = transaction.from ? ethers.getAddress(transaction.from) : null;
    const to = transaction.to ? ethers.getAddress(transaction.to) : null;

    const isEthTransfer =
      (transaction.value ?? BigInt(0)) > BigInt(0) && transaction.data === "0x";

    const touchedContracts = new Set<string>();
    let tokenTransfers = 0;
    let approvals = 0;

    const iface = new ethers.Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
      "event Approval(address indexed owner, address indexed spender, uint256 value)",
    ]);

    for (const log of receipt.logs as any[]) {
      touchedContracts.add(log.address.toLowerCase());

      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed.name === "Transfer") tokenTransfers++;
        if (parsed.name === "Approval") approvals++;
      } catch {}
    }

    const risk =
      approvals > 0
        ? "Medium"
        : touchedContracts.size > 1
        ? "Low–Medium"
        : "Low";

    return NextResponse.json({
      summary: isEthTransfer ? "ETH transfer" : "Contract interaction",
      basescan: basescanUrl,
      accessUnlocked: true,

      explanation: [
        `• From: ${short(from)}`,
        `• To: ${short(to)}`,
        `• Contracts touched: ${touchedContracts.size}`,
        `• Token transfers: ${tokenTransfers}`,
        `• Approvals: ${approvals}`,
        `• Risk level: ${risk}`,
      ].join("\n"),
    });
  } catch {
    return NextResponse.json({
      summary: "Unable to analyze transaction",
      explanation: "We couldn’t analyze this transaction right now. Please try again.",
      basescan: basescanUrl,
      accessUnlocked: false,
    });
  }
}
