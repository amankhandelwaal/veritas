import { type Address } from "viem";

import { normalizePostState, type PostState } from "@/lib/contract";

type PostTuple = readonly [bigint, Address, bigint, number, bigint];

type PostStructLike = {
  id: bigint;
  author: Address;
  timestamp: bigint;
  state: number;
  flagCount: bigint;
};

export type ParsedPostState = {
  id: number;
  author: Address;
  timestamp: number;
  state: PostState;
  flagCount: number;
};

function isPostTuple(post: PostTuple | PostStructLike): post is PostTuple {
  return Array.isArray(post);
}

export function parseContractPost(post: PostTuple | PostStructLike): ParsedPostState {
  if (isPostTuple(post)) {
    const [id, author, timestamp, state, flagCount] = post;
    return {
      id: Number(id),
      author,
      timestamp: Number(timestamp),
      state: normalizePostState(state),
      flagCount: Number(flagCount),
    };
  }

  return {
    id: Number(post.id),
    author: post.author,
    timestamp: Number(post.timestamp),
    state: normalizePostState(post.state),
    flagCount: Number(post.flagCount),
  };
}
