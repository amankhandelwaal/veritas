"use client";

import { FormEvent, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BaseError,
  encodePacked,
  formatEther,
  keccak256,
  parseAbiItem,
  parseEther,
  zeroAddress,
} from "viem";
import { toast } from "sonner";
import { useAccount, usePublicClient, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { getFeedStartBlock, getIpfsGatewayBaseUrl, getVeritasAddress, VERITAS_ABI } from "@/lib/contract";

const CHUNK_BLOCK_DELTA = BigInt(9);
const LOOKBACK_BLOCKS = BigInt(200);
const POST_STATE_UNDER_REVIEW = 1;
const STORAGE_PREFIX = "veritas:tribunal";
const EXPECTED_FLAG_THRESHOLD = BigInt(1);
const FALLBACK_MODERATOR_DEPOSIT_WEI = parseEther("0.01");

type PostCreatedLogArgs = {
  postId?: bigint;
  author?: `0x${string}`;
  cid?: string;
  tag?: string;
  timestamp?: bigint;
};

type PostStruct = {
  id: bigint;
  author: `0x${string}`;
  timestamp: bigint;
  state: number;
  flagCount: bigint;
};

type TribunalCaseView = readonly [bigint, bigint, bigint, bigint, bigint, bigint, boolean];
type VoteTotals = readonly [bigint, bigint];
type ParticipantView = readonly [`0x${string}`, bigint, boolean, boolean, boolean];

type IpfsPayload = {
  text?: unknown;
};

type StoredReveal = {
  vote: boolean;
  secret: string;
};

type QueueItem = {
  postId: number;
  author: `0x${string}`;
  cid: string;
  tag: string;
  content: string;
  timestamp: number;
  commitDeadline: number;
  revealDeadline: number;
  approveWeight: number;
  banWeight: number;
  voterCount: number;
  revealCount: number;
  isFinalized: boolean;
  hasCommitted: boolean;
  hasRevealed: boolean;
  committedStakeWei: bigint;
};

type DashboardData = {
  currentTimestamp: number;
  items: QueueItem[];
};

type CasePhase = "awaiting-first-vote" | "commit" | "reveal" | "ready-finalization";

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof BaseError) return error.shortMessage || error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

async function readIpfsContent(gatewayBaseUrl: string, cid: string): Promise<string> {
  try {
    const response = await fetch(`${gatewayBaseUrl}/ipfs/${cid}`, {
      method: "GET",
      cache: "no-store",
    });
    if (!response.ok) return "";

    const payload = (await response.json()) as IpfsPayload;
    return typeof payload.text === "string" ? payload.text : "";
  } catch {
    return "";
  }
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function getStorageKey(postId: number, walletAddress: string) {
  return `${STORAGE_PREFIX}:${walletAddress.toLowerCase()}:${postId}`;
}

function readStoredReveal(postId: number, walletAddress: string | undefined): StoredReveal | null {
  if (!walletAddress || typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(getStorageKey(postId, walletAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredReveal;
    if (typeof parsed.secret !== "string" || typeof parsed.vote !== "boolean") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredReveal(postId: number, walletAddress: string, value: StoredReveal) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(getStorageKey(postId, walletAddress), JSON.stringify(value));
}

function clearStoredReveal(postId: number, walletAddress: string | undefined) {
  if (!walletAddress || typeof window === "undefined") return;
  window.localStorage.removeItem(getStorageKey(postId, walletAddress));
}

function generateSecret() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${crypto.randomUUID()}-${Date.now()}`;
  }

  return `secret-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getCasePhase(item: QueueItem, now: number): CasePhase {
  if (item.commitDeadline === 0) return "awaiting-first-vote";
  if (now <= item.commitDeadline) return "commit";
  if (now <= item.revealDeadline) return "reveal";
  return "ready-finalization";
}

function getMinutesLeft(deadline: number, now: number) {
  const secondsLeft = Math.max(deadline - now, 0);
  if (secondsLeft >= 60) {
    return `${Math.ceil(secondsLeft / 60)} min left`;
  }

  return `${secondsLeft}s left`;
}

function getPhaseLabel(item: QueueItem, now: number) {
  const phase = getCasePhase(item, now);
  if (phase === "awaiting-first-vote") return "Awaiting First Vote";
  if (phase === "commit") return `Commit Phase - ${getMinutesLeft(item.commitDeadline, now)}`;
  if (phase === "reveal") return `Reveal Phase - ${getMinutesLeft(item.revealDeadline, now)}`;
  return "Ready for Finalization";
}

export default function ModeratorPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();
  const contractAddress = getVeritasAddress();
  const gatewayBaseUrl = getIpfsGatewayBaseUrl();

  const [pendingHash, setPendingHash] = useState<`0x${string}` | undefined>();
  const [txLabel, setTxLabel] = useState("");
  const [stakeInputs, setStakeInputs] = useState<Record<number, string>>({});
  const [commitChoices, setCommitChoices] = useState<Record<number, "approve" | "ban">>({});
  const [manualRevealChoices, setManualRevealChoices] = useState<Record<number, "approve" | "ban">>({});
  const [manualSecrets, setManualSecrets] = useState<Record<number, string>>({});
  const [storedReveals, setStoredReveals] = useState<Record<number, StoredReveal | null>>({});

  const { writeContractAsync, isPending: isAwaitingSignature } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: pendingHash,
    query: { enabled: Boolean(pendingHash) },
  });

  const readEnabled = Boolean(isConnected && address);
  const { data: isModerator = false, isLoading: isModeratorLoading } = useReadContract({
    address: contractAddress,
    abi: VERITAS_ABI,
    functionName: "isModerator",
    args: [address ?? zeroAddress],
    query: { enabled: readEnabled },
  });
  const { data: activeCasesRaw = BigInt(0) } = useReadContract({
    address: contractAddress,
    abi: VERITAS_ABI,
    functionName: "activeCases",
    args: [address ?? zeroAddress],
    query: { enabled: readEnabled },
  });
  const { data: moderatorDepositRaw, error: moderatorDepositError } = useReadContract({
    address: contractAddress,
    abi: VERITAS_ABI,
    functionName: "MODERATOR_DEPOSIT",
    query: { enabled: true },
  });
  const { data: flagThresholdRaw, error: flagThresholdError } = useReadContract({
    address: contractAddress,
    abi: VERITAS_ABI,
    functionName: "FLAG_THRESHOLD",
    query: { enabled: true },
  });
  const { data: moderatorStakeRaw = BigInt(0) } = useReadContract({
    address: contractAddress,
    abi: VERITAS_ABI,
    functionName: "moderatorDeposits",
    args: [address ?? zeroAddress],
    query: { enabled: readEnabled },
  });

  const postCreatedEvent = parseAbiItem(
    "event PostCreated(uint256 indexed postId, address indexed author, string cid, string tag, uint256 timestamp)",
  );

  const {
    data: dashboard,
    isLoading: isQueueLoading,
    isFetching: isQueueFetching,
    refetch: refetchQueue,
  } = useQuery<DashboardData>({
    queryKey: ["tribunal-queue", address],
    enabled: Boolean(publicClient && isConnected && isModerator),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!publicClient) {
        return { currentTimestamp: 0, items: [] };
      }

      const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
      const latestBlockNumber = latestBlock.number;
      const currentTimestamp = Number(latestBlock.timestamp);
      const configuredStartBlock = getFeedStartBlock();
      const fallbackStartBlock =
        latestBlockNumber > LOOKBACK_BLOCKS ? latestBlockNumber - LOOKBACK_BLOCKS : BigInt(0);
      const fromBlock = configuredStartBlock > BigInt(0) ? configuredStartBlock : fallbackStartBlock;

      const logs: Array<{ args?: PostCreatedLogArgs }> = [];
      let cursor = fromBlock;
      while (cursor <= latestBlockNumber) {
        const chunkToBlock =
          cursor + CHUNK_BLOCK_DELTA > latestBlockNumber ? latestBlockNumber : cursor + CHUNK_BLOCK_DELTA;
        const chunk = await publicClient.getLogs({
          address: contractAddress,
          event: postCreatedEvent as never,
          fromBlock: cursor,
          toBlock: chunkToBlock,
        });
        logs.push(...(chunk as Array<{ args?: PostCreatedLogArgs }>));
        cursor = chunkToBlock + BigInt(1);
      }

      const postMetaById = new Map<number, { cid: string; tag: string; timestamp: number }>();
      for (const log of logs) {
        const args = log.args;
        if (
          !args ||
          typeof args.postId === "undefined" ||
          typeof args.cid === "undefined" ||
          typeof args.tag === "undefined" ||
          typeof args.timestamp === "undefined"
        ) {
          continue;
        }

        postMetaById.set(Number(args.postId), {
          cid: args.cid,
          tag: args.tag,
          timestamp: Number(args.timestamp),
        });
      }

      const postCountRaw = await publicClient.readContract({
        address: contractAddress,
        abi: VERITAS_ABI,
        functionName: "getPostCount",
      });
      const postCount = Number(postCountRaw);

      const items: QueueItem[] = [];
      for (let postId = 1; postId <= postCount; postId++) {
        const post = (await publicClient.readContract({
          address: contractAddress,
          abi: VERITAS_ABI,
          functionName: "getPost",
          args: [BigInt(postId)],
        })) as unknown as PostStruct;

        if (post.state !== POST_STATE_UNDER_REVIEW) continue;

        const voteTotals = (await publicClient.readContract({
          address: contractAddress,
          abi: VERITAS_ABI,
          functionName: "getVoteCounts",
          args: [BigInt(postId)],
        })) as unknown as VoteTotals;

        const caseView = (await publicClient.readContract({
          address: contractAddress,
          abi: VERITAS_ABI,
          functionName: "getTribunalCase",
          args: [BigInt(postId)],
        })) as unknown as TribunalCaseView;

        const participantView = (await publicClient.readContract({
          address: contractAddress,
          abi: VERITAS_ABI,
          functionName: "getCaseParticipant",
          args: [BigInt(postId), address ?? zeroAddress],
        })) as unknown as ParticipantView;

        const eventMeta = postMetaById.get(postId);
        const cid = eventMeta?.cid ?? "";
        const content = cid ? await readIpfsContent(gatewayBaseUrl, cid) : "";

        items.push({
          postId,
          author: post.author,
          cid,
          tag: eventMeta?.tag ?? "General",
          content,
          timestamp: eventMeta?.timestamp ?? Number(post.timestamp),
          commitDeadline: Number(caseView[0]),
          revealDeadline: Number(caseView[1]),
          approveWeight: Number(voteTotals[0]),
          banWeight: Number(voteTotals[1]),
          voterCount: Number(caseView[4]),
          revealCount: Number(caseView[5]),
          isFinalized: caseView[6],
          hasCommitted: participantView[2],
          hasRevealed: participantView[3],
          committedStakeWei: participantView[1],
        });
      }

      items.sort((a, b) => b.postId - a.postId);
      return { currentTimestamp, items };
    },
  });

  useEffect(() => {
    if (!address || !dashboard?.items.length) {
      setStoredReveals({});
      return;
    }

    const nextState: Record<number, StoredReveal | null> = {};
    for (const item of dashboard.items) {
      nextState[item.postId] = readStoredReveal(item.postId, address);
    }
    setStoredReveals(nextState);
  }, [address, dashboard]);

  const txBusy = isAwaitingSignature || isConfirming;
  const activeCaseCount = Number(activeCasesRaw);
  const registrationDepositWei =
    typeof moderatorDepositRaw === "bigint" && moderatorDepositRaw > BigInt(0)
      ? moderatorDepositRaw
      : FALLBACK_MODERATOR_DEPOSIT_WEI;
  const moderatorDeposit = formatEther(registrationDepositWei);
  const moderatorStake = formatEther(moderatorStakeRaw);
  const isPhase6Contract =
    typeof moderatorDepositRaw === "bigint" &&
    moderatorDepositRaw > BigInt(0) &&
    flagThresholdRaw === EXPECTED_FLAG_THRESHOLD;
  const hasContractConfigError = Boolean(moderatorDepositError || flagThresholdError);

  const syncLocalReveal = (postId: number) => {
    if (!address) return;
    setStoredReveals((current) => ({
      ...current,
      [postId]: readStoredReveal(postId, address),
    }));
  };

  const handleRegisterModerator = async () => {
    if (!publicClient || txBusy) return;
    if (!isPhase6Contract) {
      toast.error("The configured contract does not match the current tribunal deployment.");
      return;
    }

    try {
      setTxLabel("Depositing into moderator registry...");
      const hash = await writeContractAsync({
        address: contractAddress,
        abi: VERITAS_ABI,
        functionName: "registerModerator",
        value: registrationDepositWei,
        gas: BigInt(150_000),
      });

      setPendingHash(hash);
      toast.success("Moderator registration submitted.");
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("You are now a registered moderator.");
      await queryClient.invalidateQueries({ queryKey: ["tribunal-queue", address] });
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to register as moderator."));
    } finally {
      setPendingHash(undefined);
      setTxLabel("");
    }
  };

  const handleResign = async () => {
    if (!publicClient || txBusy) return;

    try {
      setTxLabel("Withdrawing moderator deposit...");
      const hash = await writeContractAsync({
        address: contractAddress,
        abi: VERITAS_ABI,
        functionName: "resignAsModerator",
      });

      setPendingHash(hash);
      toast.success("Resignation submitted.");
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("Moderator deposit withdrawn.");
      await queryClient.invalidateQueries({ queryKey: ["tribunal-queue", address] });
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to resign as moderator."));
    } finally {
      setPendingHash(undefined);
      setTxLabel("");
    }
  };

  const handleCommit = async (event: FormEvent<HTMLFormElement>, item: QueueItem) => {
    event.preventDefault();
    if (!address || !publicClient || txBusy) return;

    const voteChoice = commitChoices[item.postId] ?? "approve";
    const stakeInput = stakeInputs[item.postId]?.trim() ?? "";
    if (!stakeInput) {
      toast.error("Enter an ETH stake amount before committing.");
      return;
    }

    try {
      const stakeWei = parseEther(stakeInput);
      if (stakeWei <= BigInt(0)) {
        toast.error("Stake must be greater than 0 ETH.");
        return;
      }

      const vote = voteChoice === "approve";
      const secret = generateSecret();
      const secretHash = keccak256(
        encodePacked(["bool", "string", "address"], [vote, secret, address]),
      );

      setTxLabel(`Committing vote for post #${item.postId}...`);
      const hash = await writeContractAsync({
        address: contractAddress,
        abi: VERITAS_ABI,
        functionName: "commitVote",
        args: [BigInt(item.postId), secretHash],
        value: stakeWei,
      });

      writeStoredReveal(item.postId, address, { vote, secret });
      syncLocalReveal(item.postId);
      setPendingHash(hash);
      toast.success("Commit transaction submitted.");
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(`Vote committed for post #${item.postId}.`);
      await refetchQueue();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to commit vote."));
    } finally {
      setPendingHash(undefined);
      setTxLabel("");
    }
  };

  const handleReveal = async (postId: number, fallbackSecret?: string, fallbackVote?: "approve" | "ban") => {
    if (!address || !publicClient || txBusy) return;

    const stored = storedReveals[postId];
    const secret = (stored?.secret ?? fallbackSecret ?? "").trim();
    if (!secret) {
      toast.error("No reveal secret found. Enter it manually to proceed.");
      return;
    }

    const vote = stored?.vote ?? fallbackVote === "approve";

    try {
      setTxLabel(`Revealing vote for post #${postId}...`);
      const hash = await writeContractAsync({
        address: contractAddress,
        abi: VERITAS_ABI,
        functionName: "revealVote",
        args: [BigInt(postId), vote, secret],
      });

      setPendingHash(hash);
      toast.success("Reveal transaction submitted.");
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(`Vote revealed for post #${postId}.`);
      await refetchQueue();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to reveal vote."));
    } finally {
      setPendingHash(undefined);
      setTxLabel("");
    }
  };

  const handleFinalize = async (postId: number) => {
    if (!publicClient || txBusy) return;

    try {
      setTxLabel(`Finalizing case for post #${postId}...`);
      const hash = await writeContractAsync({
        address: contractAddress,
        abi: VERITAS_ABI,
        functionName: "finalizeCase",
        args: [BigInt(postId)],
      });

      setPendingHash(hash);
      toast.success("Finalization transaction submitted.");
      await publicClient.waitForTransactionReceipt({ hash });
      clearStoredReveal(postId, address);
      syncLocalReveal(postId);
      toast.success(`Case finalized for post #${postId}.`);
      await refetchQueue();
    } catch (error) {
      toast.error(getErrorMessage(error, "Failed to finalize case."));
    } finally {
      setPendingHash(undefined);
      setTxLabel("");
    }
  };

  if (!isConnected) {
    return (
      <section className="relative flex min-h-[85vh] items-center justify-center overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(52,211,153,0.18),transparent_30%),radial-gradient(circle_at_85%_10%,rgba(16,185,129,0.14),transparent_25%),linear-gradient(180deg,rgba(9,12,10,0.98),rgba(5,8,7,1))]" />
        <div className="relative mx-auto w-full max-w-2xl rounded-3xl border border-zinc-800/80 bg-zinc-900/70 p-8 text-center shadow-[0_25px_90px_rgba(0,0,0,0.45)]">
          <p className="text-xs font-semibold tracking-[0.18em] text-emerald-300 uppercase">Access Required</p>
          <h1 className="mt-3 text-3xl font-bold text-zinc-50">Connect Wallet To Enter Tribunal</h1>
          <p className="mt-4 text-zinc-400">
            The moderator dashboard is tied to your on-chain identity. Connect a wallet to register or participate.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(52,211,153,0.22),transparent_30%),radial-gradient(circle_at_85%_10%,rgba(16,185,129,0.2),transparent_25%),linear-gradient(180deg,rgba(9,12,10,0.98),rgba(5,8,7,1))]" />
      <div className="relative mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 rounded-2xl border border-zinc-800/80 bg-zinc-900/65 p-5 shadow-[0_18px_52px_rgba(0,0,0,0.22)]">
          <p className="text-xs font-semibold tracking-[0.16em] text-emerald-200 uppercase">Tribunal Console</p>
          <h1 className="mt-1 text-3xl font-semibold text-zinc-50">Schelling-Point Moderation Dashboard</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Commit in private, reveal on time, and let stake-weighted consensus settle moderation outcomes.
          </p>
          {txBusy ? <p className="mt-3 text-sm text-zinc-300">{txLabel || "Transaction in progress..."}</p> : null}
        </div>

        {!isModerator ? (
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-6 shadow-[0_18px_52px_rgba(0,0,0,0.22)]">
            <p className="text-xs font-semibold tracking-[0.16em] text-emerald-200 uppercase">Moderator Registry</p>
            <h2 className="mt-2 text-2xl font-semibold text-zinc-50">Deposit To Join The Tribunal</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-400">
              Becoming a moderator requires a one-time {moderatorDeposit} ETH deposit. That deposit stays locked until
              you resign, and resignation is blocked while you still have unresolved active cases.
            </p>
            {!isPhase6Contract ? (
              <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
                The configured Sepolia contract does not match the current tribunal ABI. Redeploy `Veritas.sol` and
                update `NEXT_PUBLIC_CONTRACT_ADDRESS` before registering.
                {hasContractConfigError ? " The deposit read failed, so registration is disabled." : ""}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void handleRegisterModerator()}
              disabled={txBusy || isModeratorLoading || !isPhase6Contract}
              className="mt-5 inline-flex items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-400/15 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/50 hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Deposit {moderatorDeposit} ETH To Register
            </button>
          </div>
        ) : (
          <>
            <div className="mb-6 grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-5">
                <p className="text-xs font-semibold tracking-[0.16em] text-zinc-400 uppercase">Registry Status</p>
                <p className="mt-3 text-2xl font-semibold text-zinc-50">Active Moderator</p>
                <p className="mt-2 text-sm text-zinc-400">Deposit locked: {moderatorStake} ETH</p>
              </div>
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-5">
                <p className="text-xs font-semibold tracking-[0.16em] text-zinc-400 uppercase">Active Cases</p>
                <p className="mt-3 text-2xl font-semibold text-zinc-50">{activeCaseCount}</p>
                <p className="mt-2 text-sm text-zinc-400">You must resolve or void them before exiting.</p>
              </div>
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/70 p-5">
                <p className="text-xs font-semibold tracking-[0.16em] text-zinc-400 uppercase">Exit Tribunal</p>
                <button
                  type="button"
                  onClick={() => void handleResign()}
                  disabled={txBusy || activeCaseCount > 0}
                  className="mt-3 inline-flex items-center justify-center rounded-xl border border-rose-400/35 bg-rose-500/10 px-4 py-2.5 text-sm font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Resign & Withdraw Deposit
                </button>
                {activeCaseCount > 0 ? (
                  <p className="mt-2 text-xs text-zinc-500">Exit is locked until every committed case is resolved.</p>
                ) : null}
              </div>
            </div>

            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold tracking-[0.16em] text-emerald-200 uppercase">Moderation Queue</p>
                <h2 className="mt-1 text-2xl font-semibold text-zinc-50">Posts Under Tribunal Review</h2>
              </div>
              <button
                type="button"
                onClick={() => void refetchQueue()}
                disabled={isQueueFetching || txBusy}
                className="rounded-xl border border-zinc-700/90 bg-zinc-800/80 px-3 py-2 text-sm text-zinc-200 transition hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isQueueFetching ? "Refreshing..." : "Refresh Queue"}
              </button>
            </div>

            {isQueueLoading ? (
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-8 text-zinc-300">
                Loading tribunal cases...
              </div>
            ) : null}

            {!isQueueLoading && (dashboard?.items.length ?? 0) === 0 ? (
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 p-8 text-center text-zinc-300">
                No posts are currently awaiting tribunal action.
              </div>
            ) : null}

            {!isQueueLoading && (dashboard?.items.length ?? 0) > 0 ? (
              <div className="grid gap-4 md:grid-cols-2">
                {dashboard?.items.map((item) => {
                  const storedReveal = storedReveals[item.postId];
                  const phase = getCasePhase(item, dashboard.currentTimestamp);
                  const phaseLabel = getPhaseLabel(item, dashboard.currentTimestamp);
                  const manualSecret = manualSecrets[item.postId] ?? "";
                  const manualRevealChoice = manualRevealChoices[item.postId] ?? "approve";

                  return (
                    <article
                      key={item.postId}
                      className="rounded-2xl border border-zinc-800/80 bg-zinc-900/80 p-5 shadow-[0_12px_42px_rgba(0,0,0,0.24)]"
                    >
                      <header className="mb-4 flex items-start justify-between gap-3">
                        <div>
                          <p className="text-base font-semibold text-zinc-100">Post #{item.postId}</p>
                          <p className="text-xs text-zinc-400">{formatTimestamp(item.timestamp)}</p>
                        </div>
                        <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-semibold tracking-[0.14em] text-amber-200">
                          {phaseLabel}
                        </span>
                      </header>

                      <p className="rounded-xl border border-zinc-800/80 bg-zinc-950/80 px-3 py-3 text-sm leading-6 text-zinc-100">
                        {item.content || "Content unavailable from IPFS gateway."}
                      </p>

                      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded-md border border-zinc-700/80 bg-zinc-800/80 px-2.5 py-1 text-zinc-200">
                          #{item.tag}
                        </span>
                        <span className="rounded-md border border-zinc-700/80 bg-zinc-800/80 px-2.5 py-1 text-zinc-300">
                          Author {truncateAddress(item.author)}
                        </span>
                        <span className="rounded-md border border-zinc-700/80 bg-zinc-800/80 px-2.5 py-1 text-zinc-300">
                          Approve {formatEther(BigInt(item.approveWeight))} ETH
                        </span>
                        <span className="rounded-md border border-zinc-700/80 bg-zinc-800/80 px-2.5 py-1 text-zinc-300">
                          Ban {formatEther(BigInt(item.banWeight))} ETH
                        </span>
                      </div>

                      <div className="mt-3 text-xs text-zinc-500">
                        Commits: {item.voterCount} | Reveals: {item.revealCount}
                        {item.hasCommitted ? ` | Your stake: ${formatEther(item.committedStakeWei)} ETH` : ""}
                      </div>

                      {phase === "awaiting-first-vote" || phase === "commit" ? (
                        item.hasCommitted ? (
                          <div className="mt-5 rounded-xl border border-zinc-800/80 bg-zinc-950/70 px-3 py-3 text-sm text-zinc-300">
                            Commitment recorded. Wait for reveal phase to disclose your vote.
                          </div>
                        ) : (
                          <form className="mt-5 space-y-3" onSubmit={(event) => void handleCommit(event, item)}>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <label className="space-y-2">
                                <span className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-400">Vote</span>
                                <select
                                  value={commitChoices[item.postId] ?? "approve"}
                                  onChange={(event) =>
                                    setCommitChoices((current) => ({
                                      ...current,
                                      [item.postId]: event.target.value as "approve" | "ban",
                                    }))
                                  }
                                  className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/60"
                                  disabled={txBusy}
                                >
                                  <option value="approve">Approve</option>
                                  <option value="ban">Ban</option>
                                </select>
                              </label>
                              <label className="space-y-2">
                                <span className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-400">Stake (ETH)</span>
                                <input
                                  value={stakeInputs[item.postId] ?? ""}
                                  onChange={(event) =>
                                    setStakeInputs((current) => ({
                                      ...current,
                                      [item.postId]: event.target.value,
                                    }))
                                  }
                                  placeholder="0.05"
                                  className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/60"
                                  disabled={txBusy}
                                />
                              </label>
                            </div>
                            <button
                              type="submit"
                              disabled={txBusy}
                              className="inline-flex items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-400/15 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/50 hover:bg-emerald-400/25 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Commit Vote
                            </button>
                          </form>
                        )
                      ) : null}

                      {phase === "reveal" ? (
                        item.hasRevealed ? (
                          <div className="mt-5 rounded-xl border border-zinc-800/80 bg-zinc-950/70 px-3 py-3 text-sm text-zinc-300">
                            Reveal recorded. Awaiting finalization after the reveal window closes.
                          </div>
                        ) : (
                          <div className="mt-5 space-y-3">
                            {storedReveal ? (
                              <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 px-3 py-3 text-sm text-zinc-300">
                                Stored reveal found for this wallet. Vote: {storedReveal.vote ? "Approve" : "Ban"}.
                              </div>
                            ) : (
                              <div className="grid gap-3 sm:grid-cols-2">
                                <label className="space-y-2">
                                  <span className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-400">
                                    Original Vote
                                  </span>
                                  <select
                                    value={manualRevealChoice}
                                    onChange={(event) =>
                                      setManualRevealChoices((current) => ({
                                        ...current,
                                        [item.postId]: event.target.value as "approve" | "ban",
                                      }))
                                    }
                                    className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/60"
                                    disabled={txBusy}
                                  >
                                    <option value="approve">Approve</option>
                                    <option value="ban">Ban</option>
                                  </select>
                                </label>
                                <label className="space-y-2">
                                  <span className="text-xs font-medium uppercase tracking-[0.12em] text-zinc-400">
                                    Manual Secret
                                  </span>
                                  <input
                                    value={manualSecret}
                                    onChange={(event) =>
                                      setManualSecrets((current) => ({
                                        ...current,
                                        [item.postId]: event.target.value,
                                      }))
                                    }
                                    placeholder="Paste the secret you saved earlier"
                                    className="w-full rounded-xl border border-zinc-700/80 bg-zinc-950/80 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/60"
                                    disabled={txBusy}
                                  />
                                </label>
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleReveal(item.postId, manualSecret, manualRevealChoice)}
                              disabled={txBusy || (!storedReveal && !manualSecret.trim())}
                              className="inline-flex items-center justify-center rounded-xl border border-sky-400/35 bg-sky-500/10 px-4 py-2.5 text-sm font-semibold text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Reveal Vote
                            </button>
                          </div>
                        )
                      ) : null}

                      {phase === "ready-finalization" ? (
                        <div className="mt-5">
                          <button
                            type="button"
                            onClick={() => void handleFinalize(item.postId)}
                            disabled={txBusy}
                            className="inline-flex items-center justify-center rounded-xl border border-amber-400/35 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-100 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Finalize Case
                          </button>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
