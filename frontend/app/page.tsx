"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { parseAbiItem } from "viem";
import { toast } from "sonner";
import { useAccount, usePublicClient } from "wagmi";

import { CreatePostModal } from "@/components/CreatePostModal";
import { PostCard } from "@/components/PostCard";
import { getFeedStartBlock, getIpfsGatewayBaseUrl, getVeritasAddress, normalizePostState, VERITAS_ABI } from "@/lib/contract";

type FeedItem = {
  postId: number;
  author: `0x${string}`;
  cid: string;
  tag: string;
  timestamp: number;
  state: "ACTIVE" | "UNDER_REVIEW" | "BANNED";
  content: string;
};

type ContractPost = {
  id: bigint;
  author: `0x${string}`;
  timestamp: bigint;
  state: number;
  flagCount: bigint;
};

type IpfsPostPayload = {
  text?: unknown;
};

type PostCreatedLogArgs = {
  postId?: bigint;
  author?: `0x${string}`;
  cid?: string;
  tag?: string;
  timestamp?: bigint;
};

const LOG_BLOCK_RANGE = BigInt(9);
const FALLBACK_LOOKBACK_BLOCKS = BigInt(200);
const DUPLICATE_FEED_WINDOW_SECONDS = 10 * 60;

async function readIpfsContent(gatewayBaseUrl: string, cid: string): Promise<string> {
  try {
    const response = await fetch(`${gatewayBaseUrl}/ipfs/${cid}`, {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      return "";
    }

    const data = (await response.json()) as IpfsPostPayload;
    return typeof data.text === "string" ? data.text : "";
  } catch {
    return "";
  }
}

function toSeconds(timestamp: number): number {
  return timestamp > 1_000_000_000_000 ? Math.floor(timestamp / 1000) : timestamp;
}

async function getPostCreatedLogsChunked({
  publicClient,
  address,
  event,
  fromBlock,
  toBlock,
}: {
  publicClient: NonNullable<ReturnType<typeof usePublicClient>>;
  address: `0x${string}`;
  event: unknown;
  fromBlock: bigint;
  toBlock: bigint;
}) {
  const logs: Array<{ args?: PostCreatedLogArgs }> = [];
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const chunkToBlock = cursor + LOG_BLOCK_RANGE > toBlock ? toBlock : cursor + LOG_BLOCK_RANGE;
    const chunk = await publicClient.getLogs({
      address,
      event: event as never,
      fromBlock: cursor,
      toBlock: chunkToBlock,
    });
    logs.push(...chunk);
    cursor = chunkToBlock + BigInt(1);
  }

  return logs;
}

export default function Home() {
  const { isConnected } = useAccount();
  const publicClient = usePublicClient();
  const latestErrorRef = useRef<string | null>(null);
  const gatewayBaseUrl = useMemo(() => getIpfsGatewayBaseUrl(), []);
  const postCreatedEvent = useMemo(
    () =>
      parseAbiItem(
        "event PostCreated(uint256 indexed postId, address indexed author, string cid, string tag, uint256 timestamp)",
      ),
    [],
  );

  const {
    data: feed = [],
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery<FeedItem[]>({
    queryKey: ["veritas-feed"],
    enabled: Boolean(publicClient) && isConnected,
    queryFn: async () => {
      if (!publicClient) return [];

      const contractAddress = getVeritasAddress();
      const latestBlock = await publicClient.getBlockNumber();
      const configuredStartBlock = getFeedStartBlock();
      const fallbackStartBlock =
        latestBlock > FALLBACK_LOOKBACK_BLOCKS ? latestBlock - FALLBACK_LOOKBACK_BLOCKS : BigInt(0);
      const fromBlock = configuredStartBlock > BigInt(0) ? configuredStartBlock : fallbackStartBlock;
      const logs = await getPostCreatedLogsChunked({
        publicClient,
        address: contractAddress,
        event: postCreatedEvent,
        fromBlock,
        toBlock: latestBlock,
      });

      const eventPosts = logs
        .map((log) => {
          const args = (log as { args?: PostCreatedLogArgs }).args;

          if (!args) return null;
          if (
            typeof args.postId === "undefined" ||
            typeof args.author === "undefined" ||
            typeof args.cid === "undefined" ||
            typeof args.tag === "undefined" ||
            typeof args.timestamp === "undefined"
          ) {
            return null;
          }

          return {
            postId: Number(args.postId),
            author: args.author,
            cid: args.cid,
            tag: args.tag,
            timestamp: Number(args.timestamp),
          };
        })
        .filter((value): value is NonNullable<typeof value> => value !== null)
        .sort((a, b) => b.postId - a.postId);

      const feedItems = await Promise.all(
        eventPosts.map(async (eventPost) => {
          const contractPost = await publicClient.readContract({
            address: contractAddress,
            abi: VERITAS_ABI,
            functionName: "getPost",
            args: [BigInt(eventPost.postId)],
          });
          const { timestamp: postTimestamp, state } = contractPost as ContractPost;
          const content = await readIpfsContent(gatewayBaseUrl, eventPost.cid);

          return {
            postId: eventPost.postId,
            author: eventPost.author,
            cid: eventPost.cid,
            tag: eventPost.tag,
            timestamp: eventPost.timestamp || Number(postTimestamp),
            state: normalizePostState(state),
            content,
          } satisfies FeedItem;
        }),
      );

      const dedupedFeedItems: FeedItem[] = [];
      const latestByContentKey = new Map<string, number>();

      for (const item of feedItems) {
        const normalizedContent = item.content.trim().toLowerCase();
        if (!normalizedContent) {
          dedupedFeedItems.push(item);
          continue;
        }

        const key = `${item.author.toLowerCase()}::${item.tag.toLowerCase()}::${normalizedContent}`;
        const currentTimestamp = toSeconds(item.timestamp);
        const previousTimestamp = latestByContentKey.get(key);

        if (
          typeof previousTimestamp !== "undefined" &&
          Math.abs(previousTimestamp - currentTimestamp) <= DUPLICATE_FEED_WINDOW_SECONDS
        ) {
          continue;
        }

        latestByContentKey.set(key, currentTimestamp);
        dedupedFeedItems.push(item);
      }

      return dedupedFeedItems;
    },
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!isError || !error) return;

    const message = error instanceof Error ? error.message : "Unable to load feed.";
    if (latestErrorRef.current === message) return;

    latestErrorRef.current = message;
    toast.error(message);
  }, [error, isError]);

  if (!isConnected) {
    return (
      <section className="relative flex min-h-[85vh] items-center justify-center overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(52,211,153,0.22),transparent_30%),radial-gradient(circle_at_85%_10%,rgba(16,185,129,0.2),transparent_25%),linear-gradient(180deg,rgba(9,12,10,0.98),rgba(5,8,7,1))]" />
        <div className="relative mx-auto flex w-full max-w-4xl flex-col items-center justify-center px-4 py-8 text-center sm:px-6 lg:px-8">
          <div className="mb-4 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-sm font-medium text-emerald-300">
            Phase 5 Initialized
          </div>
          <h1 className="mt-2 text-5xl font-extrabold tracking-tight text-zinc-50 sm:text-7xl">
            Welcome to <span className="text-emerald-400">Veritas</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-zinc-400 sm:text-xl">
            A decentralized, censorship-resistant social feed powered by Ethereum and IPFS. Connect your wallet to
            start posting, reading, and moderating on-chain.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/moderator"
              className="inline-flex items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-400/15 px-5 py-3 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/50 hover:bg-emerald-400/25"
            >
              Open Moderator Dashboard
            </Link>
          </div>
          <div className="mt-10 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900/50 px-6 py-4 text-sm text-zinc-300">
            Click <strong className="text-white">Connect Wallet</strong> in the header to enter the dApp.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(52,211,153,0.22),transparent_30%),radial-gradient(circle_at_85%_10%,rgba(16,185,129,0.2),transparent_25%),linear-gradient(180deg,rgba(9,12,10,0.98),rgba(5,8,7,1))]" />
      <div className="relative mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/65 p-4">
          <div>
            <h1 className="text-xl font-bold tracking-[0.16em] text-emerald-200 uppercase">Feed</h1>
            {/* <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50 sm:text-3xl">
              Events-only timeline with on-chain moderation
            </h1> */}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/moderator"
              className="inline-flex items-center justify-center rounded-xl border border-zinc-700/90 bg-zinc-800/80 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-700/80"
            >
              Moderator Dashboard
            </Link>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="inline-flex items-center justify-center rounded-xl border border-zinc-700/90 bg-zinc-800/80 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isFetching ? "Refreshing..." : "Refresh Feed"}
            </button>
            <CreatePostModal />
          </div>
        </div>

        {isLoading ? (
          <div className="flex min-h-[40vh] items-center justify-center rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-8">
            <div className="flex items-center gap-3 text-zinc-300">
              <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-30" />
                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" />
              </svg>
              Loading on-chain posts...
            </div>
          </div>
        ) : null}

        {!isLoading && feed.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-8 text-center">
            <p className="text-base text-zinc-200">No posts yet. Create the first one to initialize the feed.</p>
          </div>
        ) : null}

        {!isLoading && feed.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            {feed.map((post) => (
              <PostCard
                key={post.postId}
                postId={post.postId}
                author={post.author}
                cid={post.cid}
                tag={post.tag}
                content={post.content}
                timestamp={post.timestamp}
                state={post.state}
                onFlagged={() => void refetch()}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
