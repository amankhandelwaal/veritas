// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Veritas is Ownable {

    // ─── Enums ───────────────────────────────────────────────
    enum PostState { ACTIVE, UNDER_REVIEW, BANNED }

    // ─── Structs ─────────────────────────────────────────────
    struct Post {
        uint256   id;
        address   author;
        uint256   timestamp;
        PostState state;
        uint256   flagCount;
    }

    struct ModerationCase {
        uint256 postId;
        uint256 votesApprove;
        uint256 votesBan;
        bool    resolved;
        mapping(address => bool) hasVoted;
    }

    // ─── Constants ───────────────────────────────────────────
    uint256 public constant FLAG_THRESHOLD = 3;
    uint256 public constant VOTE_THRESHOLD = 3;

    // ─── State ───────────────────────────────────────────────
    uint256 private _postCounter;

    mapping(uint256 => Post) public posts;
    mapping(uint256 => ModerationCase) public moderationCases;
    mapping(address => bool) public isModerator;
    mapping(uint256 => mapping(address => bool)) public hasUserFlagged;

    address[] public moderatorList;

    // ─── Events ──────────────────────────────────────────────
    event PostCreated(
        uint256 indexed postId,
        address indexed author,
        string  cid,
        string  tag,
        uint256 timestamp
    );

    event PostFlagged(
        uint256 indexed postId,
        address indexed flagger,
        uint256 flagCount
    );

    event PostUnderReview(uint256 indexed postId);

    event ModerationVoteCast(
        uint256 indexed postId,
        address indexed moderator,
        bool    approve
    );

    event PostBanned(uint256 indexed postId);
    event PostApproved(uint256 indexed postId);
    event ModeratorAdded(address indexed moderator);
    event ModeratorRemoved(address indexed moderator);

    // ─── Modifiers ───────────────────────────────────────────
    modifier onlyModerator() {
        require(isModerator[msg.sender], "Not a moderator");
        _;
    }

    modifier postExists(uint256 postId) {
        require(postId > 0 && postId <= _postCounter, "Post does not exist");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────
    constructor() Ownable(msg.sender) {}

    // ─── Post Functions ──────────────────────────────────────

    function createPost(string calldata cid, string calldata tag)
        external
        returns (uint256)
    {
        require(bytes(cid).length > 0, "CID cannot be empty");
        require(bytes(tag).length > 0, "Tag cannot be empty");

        _postCounter++;
        uint256 postId = _postCounter;

        posts[postId] = Post({
            id:        postId,
            author:    msg.sender,
            timestamp: block.timestamp,
            state:     PostState.ACTIVE,
            flagCount: 0
        });

        emit PostCreated(postId, msg.sender, cid, tag, block.timestamp);
        return postId;
    }

    function flagPost(uint256 postId)
        external
        postExists(postId)
    {
        Post storage post = posts[postId];

        require(post.state == PostState.ACTIVE, "Post is not active");
        require(post.author != msg.sender, "Cannot flag your own post");
        require(!hasUserFlagged[postId][msg.sender], "Already flagged");

        hasUserFlagged[postId][msg.sender] = true;
        post.flagCount++;

        emit PostFlagged(postId, msg.sender, post.flagCount);

        if (post.flagCount >= FLAG_THRESHOLD) {
            post.state = PostState.UNDER_REVIEW;
            emit PostUnderReview(postId);
        }
    }

    // ─── Moderation Functions ────────────────────────────────

    function moderatorVote(uint256 postId, bool approve)
        external
        onlyModerator
        postExists(postId)
    {
        Post storage post = posts[postId];
        require(post.state == PostState.UNDER_REVIEW, "Post not under review");

        ModerationCase storage modCase = moderationCases[postId];
        require(!modCase.resolved, "Case already resolved");
        require(!modCase.hasVoted[msg.sender], "Already voted");

        modCase.hasVoted[msg.sender] = true;
        modCase.postId = postId;

        emit ModerationVoteCast(postId, msg.sender, approve);

        if (approve) {
            modCase.votesApprove++;
        } else {
            modCase.votesBan++;
        }

        if (modCase.votesBan >= VOTE_THRESHOLD) {
            modCase.resolved = true;
            post.state = PostState.BANNED;
            emit PostBanned(postId);
        } else if (modCase.votesApprove >= VOTE_THRESHOLD) {
            modCase.resolved = true;
            post.state = PostState.ACTIVE;
            emit PostApproved(postId);
        }
    }

    // ─── Moderator Management ────────────────────────────────

    function addModerator(address wallet) external onlyOwner {
        require(!isModerator[wallet], "Already a moderator");
        require(moderatorList.length < 5, "Maximum 5 moderators");
        isModerator[wallet] = true;
        moderatorList.push(wallet);
        emit ModeratorAdded(wallet);
    }

    function removeModerator(address wallet) external onlyOwner {
        require(isModerator[wallet], "Not a moderator");
        isModerator[wallet] = false;
        for (uint256 i = 0; i < moderatorList.length; i++) {
            if (moderatorList[i] == wallet) {
                moderatorList[i] = moderatorList[moderatorList.length - 1];
                moderatorList.pop();
                break;
            }
        }
        emit ModeratorRemoved(wallet);
    }

    // ─── View Functions ──────────────────────────────────────

    function getPost(uint256 postId)
        external
        view
        postExists(postId)
        returns (Post memory)
    {
        return posts[postId];
    }

    function getPostCount() external view returns (uint256) {
        return _postCounter;
    }

    function getModerators() external view returns (address[] memory) {
        return moderatorList;
    }

    function getVoteCounts(uint256 postId)
        external
        view
        postExists(postId)
        returns (uint256 votesApprove, uint256 votesBan)
    {
        ModerationCase storage modCase = moderationCases[postId];
        return (modCase.votesApprove, modCase.votesBan);
    }
}