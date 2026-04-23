import { type Abi, type Address, isAddress } from "viem";

export const VERITAS_ABI = [
  {
    type: "function",
    name: "createPost",
    stateMutability: "nonpayable",
    inputs: [
      { name: "cid", type: "string" },
      { name: "tag", type: "string" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "flagPost",
    stateMutability: "nonpayable",
    inputs: [{ name: "postId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "registerModerator",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "resignAsModerator",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "commitVote",
    stateMutability: "payable",
    inputs: [
      { name: "postId", type: "uint256" },
      { name: "secretHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revealVote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "postId", type: "uint256" },
      { name: "vote", type: "bool" },
      { name: "secret", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeCase",
    stateMutability: "nonpayable",
    inputs: [{ name: "postId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getPost",
    stateMutability: "view",
    inputs: [{ name: "postId", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "author", type: "address" },
          { name: "timestamp", type: "uint256" },
          { name: "state", type: "uint8" },
          { name: "flagCount", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getPostCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getVoteCounts",
    stateMutability: "view",
    inputs: [{ name: "postId", type: "uint256" }],
    outputs: [
      { name: "approveWeight", type: "uint256" },
      { name: "banWeight", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getTribunalCase",
    stateMutability: "view",
    inputs: [{ name: "postId", type: "uint256" }],
    outputs: [
      { name: "commitDeadline", type: "uint256" },
      { name: "revealDeadline", type: "uint256" },
      { name: "totalApproveWeight", type: "uint256" },
      { name: "totalBanWeight", type: "uint256" },
      { name: "voterCount", type: "uint256" },
      { name: "revealCount", type: "uint256" },
      { name: "isFinalized", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getCaseParticipant",
    stateMutability: "view",
    inputs: [
      { name: "postId", type: "uint256" },
      { name: "moderator", type: "address" },
    ],
    outputs: [
      { name: "commitment", type: "bytes32" },
      { name: "stake", type: "uint256" },
      { name: "hasCommitted", type: "bool" },
      { name: "hasRevealed", type: "bool" },
      { name: "vote", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "isModerator",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "moderatorDeposits",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "activeCases",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "MODERATOR_DEPOSIT",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "FLAG_THRESHOLD",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "PostCreated",
    anonymous: false,
    inputs: [
      { name: "postId", type: "uint256", indexed: true },
      { name: "author", type: "address", indexed: true },
      { name: "cid", type: "string", indexed: false },
      { name: "tag", type: "string", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

export type PostState = "ACTIVE" | "UNDER_REVIEW" | "BANNED";

export const POST_STATE: Record<number, PostState> = {
  0: "ACTIVE",
  1: "UNDER_REVIEW",
  2: "BANNED",
};

export function normalizePostState(state: number | bigint | string): PostState {
  if (typeof state === "string") {
    const normalized = state.toUpperCase();
    if (normalized === "UNDER_REVIEW") return "UNDER_REVIEW";
    if (normalized === "BANNED") return "BANNED";
    return "ACTIVE";
  }

  const numericState = Number(state);
  return POST_STATE[numericState] ?? "ACTIVE";
}

export function getVeritasAddress(): Address {
  const address = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;
  if (!address) {
    throw new Error("Missing NEXT_PUBLIC_CONTRACT_ADDRESS in frontend/.env.local.");
  }

  if (!isAddress(address)) {
    throw new Error("NEXT_PUBLIC_CONTRACT_ADDRESS is not a valid EVM address.");
  }

  return address;
}

export function getFeedStartBlock(): bigint {
  const deploymentBlock = process.env.NEXT_PUBLIC_CONTRACT_DEPLOYMENT_BLOCK;
  if (!deploymentBlock) return BigInt(0);

  try {
    const parsed = BigInt(deploymentBlock);
    return parsed >= BigInt(0) ? parsed : BigInt(0);
  } catch {
    return BigInt(0);
  }
}

export function getIpfsGatewayBaseUrl(): string {
  const gateway = process.env.NEXT_PUBLIC_PINATA_GATEWAY ?? "https://gateway.pinata.cloud";
  return gateway.replace(/\/$/, "");
}
