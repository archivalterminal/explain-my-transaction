"use client";

import { useEffect, useMemo, useState } from "react";

const PAYMENT_ADDRESS = "0x3B5Ca729ae7D427616873f5CD0B9418243090c4c";
const PRICE_USDC = "3";

// где мы храним “чек оплаты” в браузере
const STORAGE_KEY = "emt_payTx";

type Result = {
  summary: string;
  fee: string;
  explanation: string;
  basescan?: string;
  accessUnlocked?: boolean;
};

type VerifyResp = {
  ok: boolean;
  status?: "CONFIRMED" | "PENDING" | "NOT_FOUND" | "FAILED";
  paidUSDC?: string;
  message?: string;
  reason?: string;
};

function shortHash(h: string) {
  const v = h.trim();
  if (!v) return "";
  if (v.length <= 18) return v;
  return `${v.slice(0, 10)}…${v.slice(-8)}`;
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function Home() {
  const [tx, setTx] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const [showPayment, setShowPayment] = useState(false);
  const [paid, setPaid] = useState(false);

  const [payTx, setPayTx] = useState("");
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);

  const txClean = useMemo(() => tx.trim(), [tx]);
  const payTxClean = useMemo(() => payTx.trim(), [payTx]);

  // 1) При открытии страницы: достаём сохранённый “чек оплаты”
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) || "";
      if (saved) setPayTx(saved);
    } catch {}
  }, []);

  async function explainTx() {
    if (!txClean) return;

    setLoading(true);
    setResult(null);
    setVerifyMsg(null);
    setShowPayment(false);

    // 2) Всегда пытаемся объяснить + (если есть) приложить чек оплаты
    //    (сайт сам проверит, открыто или нет)
    const pay = (payTxClean || "").trim();
    const url =
      `/api/explain?tx=${encodeURIComponent(txClean)}` +
      (pay ? `&payTx=${encodeURIComponent(pay)}` : "");

    try {
      const res = await fetch(url);
      const data = await res.json();

      const unlocked = Boolean(data.accessUnlocked);

      setResult({
        summary: data.summary || "Transaction",
        fee: data.fee || "—",
        explanation: data.explanation || "No details available.",
        basescan: data.basescan,
        accessUnlocked: unlocked,
      });

      setPaid(unlocked);
    } catch {
      setResult({
        summary: "Network issue",
        fee: "—",
        explanation: "Unable to reach the service. Please try again.",
        accessUnlocked: false,
      });
      setPaid(false);
    }

    setLoading(false);
  }

  function unlock() {
    setShowPayment(true);
    setVerifyMsg(null);
  }

  function copyAddress() {
    navigator.clipboard.writeText(PAYMENT_ADDRESS);
    alert("Payment address copied");
  }

  async function verifyPayment() {
    if (!payTxClean) {
      setVerifyMsg("Paste the payment transaction hash first.");
      return;
    }

    setVerifyLoading(true);
    setVerifyMsg(null);

    try {
      const res = await fetch(`/api/verify-payment?payTx=${encodeURIComponent(payTxClean)}`);
      const data: VerifyResp = await res.json();

      const confirmed = data?.status === "CONFIRMED";

      if (confirmed) {
        setPaid(true);
        setVerifyMsg(`✅ Payment confirmed${data.paidUSDC ? ` (${data.paidUSDC} USDC)` : ""}.`);

        // 3) сохраняем чек оплаты — больше не нужно вставлять снова
        try {
          localStorage.setItem(STORAGE_KEY, payTxClean);
        } catch {}

        // 4) сразу обновляем Explain (чтобы “дверь” открылась)
        await explainTx();

        setShowPayment(false);
      } else {
        setPaid(false);

        if (data?.status === "PENDING") setVerifyMsg("⏳ Payment not confirmed yet. Try again soon.");
        else if (data?.status === "NOT_FOUND") setVerifyMsg("❌ Can’t find this payment hash. Check it.");
        else if (data?.status === "FAILED") setVerifyMsg("❌ This payment transaction failed.");
        else setVerifyMsg(data?.message || "Payment not verified yet. Try again.");
      }
    } catch {
      setPaid(false);
      setVerifyMsg("Could not verify right now. Try again.");
    }

    setVerifyLoading(false);
  }

  const isUnlocked = Boolean(result?.accessUnlocked) && paid;

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center px-4">
      <div className="w-full max-w-xl space-y-6">
        <h1 className="text-2xl font-semibold">Explain My Transaction</h1>

        <p className="text-sm text-neutral-400">
          Paste a transaction hash. No wallet connect. Read-only.
        </p>

        <input
          value={tx}
          onChange={(e) => setTx(e.target.value)}
          placeholder="0x..."
          className="w-full rounded-md bg-neutral-900 border border-neutral-800 px-4 py-3 text-sm focus:outline-none focus:border-neutral-600"
        />

        <button
          onClick={explainTx}
          disabled={loading}
          className="w-full rounded-md bg-white text-black py-3 text-sm font-medium disabled:opacity-50"
        >
          {loading ? "Explaining..." : "Explain →"}
        </button>

        {result && (
          <div className="rounded-md border border-neutral-800 bg-neutral-900 p-4 space-y-4">
            <div className="space-y-1">
              <div className="flex justify-between">
                <div className="font-medium">{result.summary}</div>
                <div className="text-xs text-neutral-400">Fee: {result.fee}</div>
              </div>
              {txClean && (
                <div className="text-xs text-neutral-500">
                  TX: <span className="text-neutral-300">{shortHash(txClean)}</span>
                </div>
              )}
            </div>

            <p className="text-sm">{result.explanation}</p>

            {result.basescan && (
              <a href={result.basescan} target="_blank" rel="noreferrer" className="text-sm underline">
                Open on BaseScan →
              </a>
            )}

            <div className="pt-3 border-t border-neutral-800 space-y-3">
              {!isUnlocked && (
                <>
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="font-medium">Advanced explanation 🔒</div>
                      <div className="text-xs text-neutral-400">
                        Full breakdown, risks, approvals, next steps
                      </div>
                    </div>
                    <button
                      onClick={unlock}
                      className="bg-white text-black px-4 py-2 rounded-md text-sm font-medium"
                    >
                      Unlock for ${PRICE_USDC}
                    </button>
                  </div>

                  {showPayment && (
                    <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 space-y-3">
                      <div className="text-sm font-medium">Pay with USDC (Base)</div>

                      <div className="text-sm text-neutral-400">
                        Amount: <span className="text-white">{PRICE_USDC} USDC</span>
                      </div>

                      <div className="text-sm text-neutral-400">
                        Send to:
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-white">{shortAddr(PAYMENT_ADDRESS)}</span>
                          <button onClick={copyAddress} className="text-xs underline">
                            Copy
                          </button>
                        </div>
                      </div>

                      <div className="text-xs text-neutral-500">
                        Network: Base • Token: USDC • Then paste your payment tx hash below.
                      </div>

                      <input
                        value={payTx}
                        onChange={(e) => setPayTx(e.target.value)}
                        placeholder="Payment tx hash (0x...)"
                        className="w-full rounded-md bg-neutral-900 border border-neutral-800 px-3 py-2 text-sm focus:outline-none focus:border-neutral-600"
                      />

                      <button
                        onClick={verifyPayment}
                        disabled={verifyLoading}
                        className="w-full rounded-md bg-white text-black py-2 text-sm font-medium disabled:opacity-50"
                      >
                        {verifyLoading ? "Verifying..." : "I’ve paid → Verify"}
                      </button>

                      {verifyMsg && <div className="text-sm text-neutral-300">{verifyMsg}</div>}
                    </div>
                  )}
                </>
              )}

              {isUnlocked && (
                <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 space-y-2">
                  <div className="font-medium">Advanced explanation</div>
                  <div className="text-sm text-neutral-300">✅ Access unlocked</div>
                  <div className="text-sm text-neutral-400">
                    This transaction likely involved multiple contract calls (approval + execution).
                    In the next version we’ll decode exact tokens, amounts, and the exact protocol.
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
