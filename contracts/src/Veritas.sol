// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Veritas is ReentrancyGuard {
    enum PostState {
        ACTIVE,
        UNDER_REVIEW,
        BANNED
    }

    struct Post {
        uint256 id;
        address author;
        uint256 timestamp;
        PostState state;
        uint256 flagCount;
    }

    struct VoteRecord {
        bytes32 commitment;
        uint256 stake;
        bool hasCommitted;
        bool hasRevealed;
        bool vote;
    }

    struct TribunalCase {
        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 totalApproveWeight;
        uint256 totalBanWeight;
        uint256 voterCount;
        uint256 revealCount;
        bool isFinalized;
        address[] participants;
        mapping(address => VoteRecord) voteRecords;
    }

    uint256 public constant FLAG_THRESHOLD = 5;
    uint256 public constant MODERATOR_DEPOSIT = 0.05 ether;
    uint256 public constant COMMIT_DURATION = 1 days;
    uint256 public constant REVEAL_DURATION = 1 days;
    uint256 private constant MINIMUM_QUORUM = 3;

    uint256 private _postCounter;

    mapping(uint256 => Post) public posts;
    mapping(uint256 => TribunalCase) private _tribunalCases;
    mapping(address => bool) public isModerator;
    mapping(address => uint256) public moderatorDeposits;
    mapping(address => uint256) public activeCases;
    mapping(uint256 => mapping(address => bool)) public hasUserFlagged;

    event PostCreated(
        uint256 indexed postId,
        address indexed author,
        string cid,
        string tag,
        uint256 timestamp
    );
    event PostFlagged(uint256 indexed postId, address indexed flagger, uint256 flagCount);
    event PostUnderReview(uint256 indexed postId);
    event ModeratorRegistered(address indexed moderator, uint256 depositAmount);
    event ModeratorResigned(address indexed moderator, uint256 refundedDeposit);
    event VoteCommitted(
        uint256 indexed postId,
        address indexed moderator,
        uint256 stake,
        uint256 commitDeadline,
        uint256 revealDeadline
    );
    event VoteRevealed(uint256 indexed postId, address indexed moderator, bool vote, uint256 stake);
    event CaseVoided(uint256 indexed postId);
    event CaseFinalized(
        uint256 indexed postId,
        bool approved,
        uint256 totalApproveWeight,
        uint256 totalBanWeight,
        uint256 slashedPool
    );

    modifier onlyModerator() {
        require(isModerator[msg.sender], "Not a registered moderator");
        _;
    }

    modifier postExists(uint256 postId) {
        require(postId > 0 && postId <= _postCounter, "Post does not exist");
        _;
    }

    function registerModerator() external payable nonReentrant {
        require(!isModerator[msg.sender], "Already a moderator");
        require(msg.value == MODERATOR_DEPOSIT, "Incorrect moderator deposit");

        isModerator[msg.sender] = true;
        moderatorDeposits[msg.sender] = msg.value;

        emit ModeratorRegistered(msg.sender, msg.value);
    }

    function resignAsModerator() external nonReentrant onlyModerator {
        require(
            activeCases[msg.sender] == 0,
            "Cannot exit with active unresolved cases"
        );

        uint256 depositAmount = moderatorDeposits[msg.sender];
        require(depositAmount == MODERATOR_DEPOSIT, "Deposit not available");

        moderatorDeposits[msg.sender] = 0;
        isModerator[msg.sender] = false;

        (bool success, ) = payable(msg.sender).call{value: depositAmount}("");
        require(success, "Deposit withdrawal failed");

        emit ModeratorResigned(msg.sender, depositAmount);
    }

    function createPost(string calldata cid, string calldata tag) external returns (uint256) {
        require(bytes(cid).length > 0, "CID cannot be empty");
        require(bytes(tag).length > 0, "Tag cannot be empty");

        _postCounter++;
        uint256 postId = _postCounter;

        posts[postId] = Post({
            id: postId,
            author: msg.sender,
            timestamp: block.timestamp,
            state: PostState.ACTIVE,
            flagCount: 0
        });

        emit PostCreated(postId, msg.sender, cid, tag, block.timestamp);
        return postId;
    }

    function flagPost(uint256 postId) external postExists(postId) {
        Post storage post = posts[postId];

        require(post.state == PostState.ACTIVE, "Post is not active");
        require(post.author != msg.sender, "Cannot flag your own post");
        require(!hasUserFlagged[postId][msg.sender], "Already flagged");

        hasUserFlagged[postId][msg.sender] = true;
        post.flagCount++;

        emit PostFlagged(postId, msg.sender, post.flagCount);

        if (post.flagCount == FLAG_THRESHOLD) {
            post.state = PostState.UNDER_REVIEW;
            emit PostUnderReview(postId);
        }
    }

    function commitVote(
        uint256 postId,
        bytes32 secretHash
    ) external payable onlyModerator postExists(postId) {
        Post storage post = posts[postId];
        require(post.state == PostState.UNDER_REVIEW, "Post not under review");
        require(secretHash != bytes32(0), "Commitment cannot be empty");
        require(msg.value > 0, "Stake required");

        TribunalCase storage tribunalCase = _tribunalCases[postId];
        VoteRecord storage record = tribunalCase.voteRecords[msg.sender];

        require(!tribunalCase.isFinalized, "Case already finalized");
        require(!record.hasCommitted, "Already committed");

        if (tribunalCase.commitDeadline == 0) {
            tribunalCase.commitDeadline = block.timestamp + COMMIT_DURATION;
            tribunalCase.revealDeadline = tribunalCase.commitDeadline + REVEAL_DURATION;
        } else {
            require(block.timestamp <= tribunalCase.commitDeadline, "Commit phase closed");
        }

        record.commitment = secretHash;
        record.stake = msg.value;
        record.hasCommitted = true;

        tribunalCase.voterCount++;
        tribunalCase.participants.push(msg.sender);
        activeCases[msg.sender]++;

        emit VoteCommitted(
            postId,
            msg.sender,
            msg.value,
            tribunalCase.commitDeadline,
            tribunalCase.revealDeadline
        );
    }

    function revealVote(
        uint256 postId,
        bool vote,
        string memory secret
    ) external onlyModerator postExists(postId) {
        TribunalCase storage tribunalCase = _tribunalCases[postId];
        VoteRecord storage record = tribunalCase.voteRecords[msg.sender];

        require(tribunalCase.commitDeadline != 0, "Case not opened");
        require(
            block.timestamp > tribunalCase.commitDeadline &&
                block.timestamp <= tribunalCase.revealDeadline,
            "Not in reveal phase"
        );
        require(record.hasCommitted, "No commitment found");
        require(!record.hasRevealed, "Already revealed");

        bytes32 reconstructedHash = keccak256(
            abi.encodePacked(vote, secret, msg.sender)
        );
        require(reconstructedHash == record.commitment, "Reveal does not match commitment");

        record.hasRevealed = true;
        record.vote = vote;
        tribunalCase.revealCount++;

        if (vote) {
            tribunalCase.totalApproveWeight += record.stake;
        } else {
            tribunalCase.totalBanWeight += record.stake;
        }

        emit VoteRevealed(postId, msg.sender, vote, record.stake);
    }

    function finalizeCase(uint256 postId) public postExists(postId) nonReentrant {
        TribunalCase storage tribunalCase = _tribunalCases[postId];
        require(tribunalCase.commitDeadline != 0, "Case not opened");
        require(block.timestamp > tribunalCase.revealDeadline, "Reveal phase not ended");
        require(!tribunalCase.isFinalized, "Case already finalized");

        address[] memory participants = _copyParticipants(postId);
        tribunalCase.isFinalized = true;

        if (
            tribunalCase.voterCount < MINIMUM_QUORUM ||
            tribunalCase.revealCount == 0 ||
            tribunalCase.totalApproveWeight == tribunalCase.totalBanWeight
        ) {
            uint256[] memory refunds = new uint256[](participants.length);

            for (uint256 i = 0; i < participants.length; i++) {
                address participant = participants[i];
                VoteRecord storage record = tribunalCase.voteRecords[participant];

                if (!record.hasCommitted) continue;

                if (activeCases[participant] > 0) {
                    activeCases[participant]--;
                }

                refunds[i] = record.stake;
            }

            _clearTribunalCase(postId, participants);
            emit CaseVoided(postId);
            _payout(participants, refunds);
            return;
        }

        bool approved = tribunalCase.totalApproveWeight > tribunalCase.totalBanWeight;
        uint256 majorityWeight = approved
            ? tribunalCase.totalApproveWeight
            : tribunalCase.totalBanWeight;
        uint256 slashedPool;
        address primaryWinner;

        for (uint256 i = 0; i < participants.length; i++) {
            VoteRecord storage record = tribunalCase.voteRecords[participants[i]];
            if (!record.hasCommitted) continue;

            // Unrevealed stakes are treated as forfeited to prevent strategic non-reveal griefing.
            if (!record.hasRevealed || record.vote != approved) {
                slashedPool += record.stake;
            } else if (primaryWinner == address(0)) {
                primaryWinner = participants[i];
            }
        }

        uint256[] memory payouts = new uint256[](participants.length);
        uint256 distributedRewards;
        uint256 primaryWinnerIndex;

        for (uint256 i = 0; i < participants.length; i++) {
            address participant = participants[i];
            VoteRecord storage record = tribunalCase.voteRecords[participant];
            if (!record.hasCommitted) continue;

            if (activeCases[participant] > 0) {
                activeCases[participant]--;
            }

            if (record.hasRevealed && record.vote == approved) {
                uint256 reward = (slashedPool * record.stake) / majorityWeight;
                payouts[i] = record.stake + reward;
                distributedRewards += reward;

                if (participant == primaryWinner) {
                    primaryWinnerIndex = i;
                }
            }
        }

        if (slashedPool > distributedRewards && primaryWinner != address(0)) {
            payouts[primaryWinnerIndex] += slashedPool - distributedRewards;
        }

        posts[postId].state = approved ? PostState.ACTIVE : PostState.BANNED;

        _clearTribunalCase(postId, participants);
        emit CaseFinalized(
            postId,
            approved,
            tribunalCase.totalApproveWeight,
            tribunalCase.totalBanWeight,
            slashedPool
        );
        _payout(participants, payouts);
    }

    function getPost(uint256 postId) external view postExists(postId) returns (Post memory) {
        return posts[postId];
    }

    function getPostCount() external view returns (uint256) {
        return _postCounter;
    }

    function getVoteCounts(
        uint256 postId
    ) external view postExists(postId) returns (uint256 approveWeight, uint256 banWeight) {
        TribunalCase storage tribunalCase = _tribunalCases[postId];
        return (tribunalCase.totalApproveWeight, tribunalCase.totalBanWeight);
    }

    function getTribunalCase(
        uint256 postId
    )
        external
        view
        postExists(postId)
        returns (
            uint256 commitDeadline,
            uint256 revealDeadline,
            uint256 totalApproveWeight,
            uint256 totalBanWeight,
            uint256 voterCount,
            uint256 revealCount,
            bool isFinalized
        )
    {
        TribunalCase storage tribunalCase = _tribunalCases[postId];
        return (
            tribunalCase.commitDeadline,
            tribunalCase.revealDeadline,
            tribunalCase.totalApproveWeight,
            tribunalCase.totalBanWeight,
            tribunalCase.voterCount,
            tribunalCase.revealCount,
            tribunalCase.isFinalized
        );
    }

    function getCaseParticipant(
        uint256 postId,
        address moderator
    )
        external
        view
        postExists(postId)
        returns (
            bytes32 commitment,
            uint256 stake,
            bool hasCommitted,
            bool hasRevealed,
            bool vote
        )
    {
        VoteRecord storage record = _tribunalCases[postId].voteRecords[moderator];
        return (
            record.commitment,
            record.stake,
            record.hasCommitted,
            record.hasRevealed,
            record.vote
        );
    }

    function _copyParticipants(uint256 postId) internal view returns (address[] memory) {
        TribunalCase storage tribunalCase = _tribunalCases[postId];
        uint256 participantCount = tribunalCase.participants.length;
        address[] memory participants = new address[](participantCount);

        for (uint256 i = 0; i < participantCount; i++) {
            participants[i] = tribunalCase.participants[i];
        }

        return participants;
    }

    function _clearTribunalCase(uint256 postId, address[] memory participants) internal {
        TribunalCase storage tribunalCase = _tribunalCases[postId];

        for (uint256 i = 0; i < participants.length; i++) {
            delete tribunalCase.voteRecords[participants[i]];
        }

        delete tribunalCase.participants;
        tribunalCase.commitDeadline = 0;
        tribunalCase.revealDeadline = 0;
        tribunalCase.totalApproveWeight = 0;
        tribunalCase.totalBanWeight = 0;
        tribunalCase.voterCount = 0;
        tribunalCase.revealCount = 0;
        tribunalCase.isFinalized = false;
    }

    function _payout(address[] memory recipients, uint256[] memory amounts) internal {
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 amount = amounts[i];
            if (amount == 0) continue;

            (bool success, ) = payable(recipients[i]).call{value: amount}("");
            require(success, "Payout failed");
        }
    }
}
