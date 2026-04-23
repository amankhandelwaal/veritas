"use client";

import { useMemo, useState } from "react";
import { BaseError } from "viem";
import { toast } from "sonner";
import { useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { getVeritasAddress, normalizePostState, type PostState, VERITAS_ABI } from "@/lib/contract";

type PostCardProps = {
  postId: number;
  author: string;
  cid: string;
  tag: string;
  content?: string;
  timestamp: number;
  state: PostState | string | number;
  onFlagged?: () => void;
};

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function truncateCid(cid: string): string {
  if (cid.length <= 22) return cid;
  return `${cid.slice(0, 10)}...${cid.slice(-8)}`;
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof BaseError) {
    return error.shortMessage || error.message || fallback;
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}

export function PostCard({ postId, author, cid, tag, content, timestamp, state, onFlagged }: PostCardProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [pendingHash, setPendingHash] = useState<`0x${string}` | undefined>();
  const normalizedState = normalizePostState(state);

  const { writeContractAsync, isPending: isAwaitingWalletSignature } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: pendingHash,
    query: {
      enabled: Boolean(pendingHash),
    },
  });

  const cardStateStyles =
    normalizedState === "ACTIVE"
      ? "border-zinc-800/90 bg-zinc-900/80"
      : normalizedState === "UNDER_REVIEW"
        ? "border-amber-500/40 bg-amber-500/10"
        : "border-rose-500/40 bg-zinc-900/60 saturate-0 opacity-80";

  const contentStateStyles =
    normalizedState === "ACTIVE" ? "" : normalizedState === "UNDER_REVIEW" ? "blur-[1px]" : "blur-sm";

  const stateLabelStyles =
    normalizedState === "ACTIVE"
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
      : normalizedState === "UNDER_REVIEW"
        ? "border-amber-400/25 bg-amber-400/10 text-amber-200"
        : "border-rose-400/25 bg-rose-400/10 text-rose-200";

  const isOwnPost = Boolean(
    address && author && address.toLowerCase() === author.toLowerCase(),
  );
  const canFlag = normalizedState === "ACTIVE" && !isOwnPost;
  const isFlagging = isAwaitingWalletSignature || isConfirming;
  const flagButtonText = useMemo(() => {
    if (isAwaitingWalletSignature) return "Awaiting Signature...";
    if (isConfirming) return "Confirming...";
    if (isOwnPost) return "Cannot Flag Own Post";
    return "Flag Post";
  }, [isAwaitingWalletSignature, isConfirming, isOwnPost]);

  const handleFlagPost = async () => {
    if (!canFlag || isFlagging) return;

    try {
      const hash = await writeContractAsync({
        address: getVeritasAddress(),
        abi: VERITAS_ABI,
        functionName: "flagPost",
        args: [BigInt(postId)],
      });

      toast.success("Flag transaction submitted.");
      setPendingHash(hash);
      if (!publicClient) {
        throw new Error("Public client unavailable. Please reconnect wallet and retry.");
      }

      await publicClient.waitForTransactionReceipt({ hash });

      toast.success(`Post #${postId} flagged for moderation.`);
      setPendingHash(undefined);
      onFlagged?.();
    } catch (error) {
      setPendingHash(undefined);
      toast.error(getErrorMessage(error, "Could not submit flag transaction."));
    }
  };

  return (
    <article className={`rounded-2xl border p-5 shadow-[0_12px_42px_rgba(0,0,0,0.24)] ${cardStateStyles}`}>
      {normalizedState !== "ACTIVE" ? (
        <div className="mb-4 rounded-lg border border-current/30 bg-black/20 px-3 py-2 text-xs font-medium text-amber-100/90">
          {normalizedState === "UNDER_REVIEW"
            ? "This post is under moderator review. Visibility is reduced until voting resolves the case."
            : "This post has been banned by moderator vote and should not be promoted in feeds."}
        </div>
      ) : null}

      <div className={`space-y-4 ${contentStateStyles}`}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold tracking-wide text-zinc-100">Post #{postId}</p>
            <p className="text-xs text-zinc-400">{formatTimestamp(timestamp)}</p>
          </div>
          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] ${stateLabelStyles}`}
          >
            {normalizedState.replace("_", " ")}
          </span>
        </header>

        {content ? (
          <p className="rounded-xl border border-zinc-800/80 bg-zinc-950/80 px-3 py-3 text-sm leading-6 text-zinc-100">
            {content}
          </p>
        ) : (
          <p className="rounded-xl border border-zinc-800/80 bg-zinc-950/80 px-3 py-3 text-sm text-zinc-400 italic">
            Content unavailable from IPFS gateway.
          </p>
        )}

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.12em] text-zinc-500">Author</p>
          <p className="font-mono text-sm text-zinc-200">{truncateAddress(author)}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-zinc-700/80 bg-zinc-800/80 px-2.5 py-1 text-xs font-medium text-zinc-200">
            #{tag}
          </span>
          <span className="rounded-md border border-zinc-700/80 bg-zinc-800/80 px-2.5 py-1 text-xs font-medium text-zinc-300">
            CID {truncateCid(cid)}
          </span>
        </div>

        <div className="pt-1">
          <button
            type="button"
            disabled={!canFlag || isFlagging}
            onClick={handleFlagPost}
            className="inline-flex items-center justify-center rounded-lg border border-rose-400/35 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold tracking-wide text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {flagButtonText}
          </button>
          {isOwnPost ? (
            <p className="mt-2 text-xs text-zinc-500">Authors cannot flag their own posts.</p>
          ) : null}
        </div>
      </div>
    </article>
  );
}
