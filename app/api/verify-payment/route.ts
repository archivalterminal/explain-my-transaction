import { NextResponse } from "next/server";
import { ethers } from "ethers";

// Куда должен прийти платёж
const PAYMENT_ADDRESS = "0x3B5Ca729ae7D427616873f5CD0B9418243090c4c";

// USDC на Base (Circle USDC)
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// 3 USDC (6 decimals) — ВАЖНО: без 3000000n (чтобы не требовать ES2020)
const PRICE_USDC_UNITS = BigInt("3000000");

// Base chainId
const BASE_CHAIN_ID = 8453;

// Минимум подтверждений
const MIN_CONFIRMATIONS = 1;

// Public RPC пул
const RPC_URLS = [
  "https://base.publicnode.com",
  "https://mainnet.base.org",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
];

function isTxHash(x: string) {
  return /^0x[a-fA-F0-9]{64}$/.test(x);
}

function norm(addr: string) {
  return ethers.getAddress(addr);
}

function toUSDC(v: bigint) {
  return (Number(v) / 1_000_000).toFixed(6);
}

async function withAnyProvider<T>(fn: (p: ethers.JsonRpcProvider) => Promise<T>) {
  let lastErr: unknown = null;

  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      await provider.getBlockNumber(); // ping
      return await fn(provider);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr ?? new Error("All RPC providers failed");
}

function getPaidAmountFromLogs(logs: any[]) {
  const iface = new ethers.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);

  let total = BigInt(0);

  for (const log of logs) {
    if (!log?.address) continue;
    if (String(log.address).toLowerCase() !== USDC_BASE.toLowerCase()) continue;

    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;

      const to = String((parsed as any).args.to).toLowerCase();
      const value = (parsed as any).args.value as bigint;

      if (to === PAYMENT_ADDRESS.toLowerCase()) {
        total += value;
      }
    } catch {
      // ignore
    }
  }

  return total;
}

async function verify(txHash: string) {
  // 1) Проверяем сеть
  const network = await withAnyProvider((p) => p.getNetwork());
  if (Number(network.chainId) !== BASE_CHAIN_ID) {
    return {
      ok: false,
      status: "FAILED",
      message: "Wrong network. Payment must be on Base.",
    };
  }

  // 2) Пробуем получить receipt
  let receipt: ethers.TransactionReceipt | null = null;
  try {
    receipt = await withAnyProvider((p) => p.getTransactionReceipt(txHash));
  } catch {
    receipt = null;
  }

  if (receipt) {
    if (receipt.status !== 1) {
      return { ok: false, status: "FAILED", message: "Transaction failed." };
    }

    const latestBlock = await withAnyProvider((p) => p.getBlockNumber());
    const confirmations = latestBlock - receipt.blockNumber + 1;

    if (confirmations < MIN_CONFIRMATIONS) {
      return {
        ok: true,
        status: "PENDING",
        message: "Waiting for confirmations.",
      };
    }

    const paid = getPaidAmountFromLogs(receipt.logs);

    if (paid >= PRICE_USDC_UNITS) {
      return {
        ok: true,
        status: "CONFIRMED",
        paidUSDC: toUSDC(paid),
        message: "Payment confirmed.",
      };
    }

    return {
      ok: true,
      status: "PENDING",
      paidUSDC: toUSDC(paid),
      message: "Transaction found, but payment not detected yet.",
    };
  }

  // 3) fallback — ищем транзакцию
  const tx = await withAnyProvider((p) => p.getTransaction(txHash));

  if (!tx) {
    return { ok: true, status: "NOT_FOUND", message: "Transaction not found yet." };
  }

  if (!(tx as any).blockNumber) {
    return { ok: true, status: "PENDING", message: "Transaction is still pending." };
  }

  // 4) fallback по логам блока
  const iface = new ethers.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);
  const topic = iface.getEvent("Transfer")!.topicHash;
  const toTopic = ethers.zeroPadValue(PAYMENT_ADDRESS, 32);

  const logs = await withAnyProvider((p) =>
    p.getLogs({
      fromBlock: (tx as any).blockNumber,
      toBlock: (tx as any).blockNumber,
      address: USDC_BASE,
      topics: [topic, null, toTopic],
    })
  );

  const paid = getPaidAmountFromLogs(logs);

  if (paid >= PRICE_USDC_UNITS) {
    return {
      ok: true,
      status: "CONFIRMED",
      paidUSDC: toUSDC(paid),
      message: "Payment confirmed (logs fallback).",
    };
  }

  return {
    ok: true,
    status: "PENDING",
    paidUSDC: toUSDC(paid),
    message: "Transaction found, waiting for payment.",
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const txHash = String(url.searchParams.get("payTx") || "").trim();

  if (!isTxHash(txHash)) {
    return NextResponse.json(
      { ok: false, status: "FAILED", message: "Invalid tx hash." },
      { status: 400 }
    );
  }

  const result = await verify(txHash);
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const txHash = String((body as any).txHash || "").trim();

  if (!isTxHash(txHash)) {
    return NextResponse.json(
      { ok: false, status: "FAILED", message: "Invalid tx hash." },
      { status: 400 }
    );
  }

  const result = await verify(txHash);
  return NextResponse.json(result);
}
