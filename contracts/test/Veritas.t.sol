// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Veritas.sol";

contract VeritasTest is Test {
    Veritas public veritas;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address eve = makeAddr("eve");
    address frank = makeAddr("frank");

    address mod1 = makeAddr("mod1");
    address mod2 = makeAddr("mod2");
    address mod3 = makeAddr("mod3");
    address mod4 = makeAddr("mod4");

    string constant TEST_CID = "QmTestCID123456789";
    string constant TEST_TAG = "AI_Research";

    function setUp() public {
        veritas = new Veritas();

        vm.deal(mod1, 10 ether);
        vm.deal(mod2, 10 ether);
        vm.deal(mod3, 10 ether);
        vm.deal(mod4, 10 ether);
    }

    function test_CreatePost_Success() public {
        vm.prank(alice);
        uint256 postId = veritas.createPost(TEST_CID, TEST_TAG);

        assertEq(postId, 1);
        assertEq(veritas.getPostCount(), 1);

        Veritas.Post memory post = veritas.getPost(1);
        assertEq(post.author, alice);
        assertEq(post.flagCount, 0);
        assertEq(uint256(post.state), uint256(Veritas.PostState.ACTIVE));
    }

    function test_CreatePost_EmptyCID_Reverts() public {
        vm.prank(alice);
        vm.expectRevert("CID cannot be empty");
        veritas.createPost("", TEST_TAG);
    }

    function test_FlagPost_FirstFlagTriggersUnderReviewWithoutTimers() public {
        uint256 postId = _putPostUnderReview();

        Veritas.Post memory post = veritas.getPost(postId);
        assertEq(uint256(post.state), uint256(Veritas.PostState.UNDER_REVIEW));
        assertEq(post.flagCount, 1);

        (uint256 commitDeadline, uint256 revealDeadline, , , uint256 voterCount, , ) =
            veritas.getTribunalCase(postId);
        assertEq(commitDeadline, 0);
        assertEq(revealDeadline, 0);
        assertEq(voterCount, 0);
    }

    function test_RegisterAndResignModerator() public {
        _registerModerator(mod1);

        assertTrue(veritas.isModerator(mod1));
        assertEq(veritas.moderatorDeposits(mod1), veritas.MODERATOR_DEPOSIT());

        uint256 balanceBefore = mod1.balance;
        vm.prank(mod1);
        veritas.resignAsModerator();

        assertFalse(veritas.isModerator(mod1));
        assertEq(veritas.moderatorDeposits(mod1), 0);
        assertEq(mod1.balance, balanceBefore + veritas.MODERATOR_DEPOSIT());
    }

    function test_RegisterModerator_RequiresExactDeposit() public {
        vm.prank(mod1);
        vm.expectRevert("Incorrect moderator deposit");
        veritas.registerModerator{value: 0.005 ether}();
    }

    function test_CommitVote_FirstBloodStartsDeadlinesAndLocksActiveCase() public {
        uint256 postId = _putPostUnderReview();
        _registerModerator(mod1);

        uint256 start = block.timestamp;
        bytes32 commitment = _commitment(true, "secret-1", mod1);

        vm.prank(mod1);
        veritas.commitVote{value: 1 ether}(postId, commitment);

        (uint256 commitDeadline, uint256 revealDeadline, , , uint256 voterCount, , ) =
            veritas.getTribunalCase(postId);
        assertEq(commitDeadline, start + 5 minutes);
        assertEq(revealDeadline, start + 10 minutes);
        assertEq(voterCount, 1);
        assertEq(veritas.activeCases(mod1), 1);
    }

    function test_ResignWithActiveCase_Reverts() public {
        uint256 postId = _putPostUnderReview();
        _registerModerator(mod1);

        vm.prank(mod1);
        veritas.commitVote{value: 1 ether}(postId, _commitment(true, "secret-1", mod1));

        vm.prank(mod1);
        vm.expectRevert("Cannot exit with active unresolved cases");
        veritas.resignAsModerator();
    }

    function test_RevealVote_AddsStakeWeight() public {
        uint256 postId = _putPostUnderReview();
        _registerModerator(mod1);

        vm.prank(mod1);
        veritas.commitVote{value: 1 ether}(postId, _commitment(true, "secret-1", mod1));

        vm.warp(block.timestamp + 5 minutes + 1);
        vm.prank(mod1);
        veritas.revealVote(postId, true, "secret-1");

        (uint256 approveWeight, uint256 banWeight) = veritas.getVoteCounts(postId);
        assertEq(approveWeight, 1 ether);
        assertEq(banWeight, 0);
    }

    function test_RevealVote_BadSecretReverts() public {
        uint256 postId = _putPostUnderReview();
        _registerModerator(mod1);

        vm.prank(mod1);
        veritas.commitVote{value: 1 ether}(postId, _commitment(true, "secret-1", mod1));

        vm.warp(block.timestamp + 5 minutes + 1);
        vm.prank(mod1);
        vm.expectRevert("Reveal does not match commitment");
        veritas.revealVote(postId, true, "wrong-secret");
    }

    function test_FinalizeCase_MajorityWinsAndMinorityIsSlashed() public {
        uint256 postId = _putPostUnderReview();
        _registerModerator(mod1);
        _registerModerator(mod2);
        _registerModerator(mod3);

        uint256 mod1Start = mod1.balance;
        uint256 mod2Start = mod2.balance;
        uint256 mod3Start = mod3.balance;

        vm.prank(mod1);
        veritas.commitVote{value: 1 ether}(postId, _commitment(true, "secret-1", mod1));
        vm.prank(mod2);
        veritas.commitVote{value: 3 ether}(postId, _commitment(true, "secret-2", mod2));
        vm.prank(mod3);
        veritas.commitVote{value: 2 ether}(postId, _commitment(false, "secret-3", mod3));

        vm.warp(block.timestamp + 5 minutes + 1);
        vm.prank(mod1);
        veritas.revealVote(postId, true, "secret-1");
        vm.prank(mod2);
        veritas.revealVote(postId, true, "secret-2");
        vm.prank(mod3);
        veritas.revealVote(postId, false, "secret-3");

        vm.warp(block.timestamp + 5 minutes + 1);
        veritas.finalizeCase(postId);

        Veritas.Post memory post = veritas.getPost(postId);
        assertEq(uint256(post.state), uint256(Veritas.PostState.ACTIVE));
        assertEq(veritas.activeCases(mod1), 0);
        assertEq(veritas.activeCases(mod2), 0);
        assertEq(veritas.activeCases(mod3), 0);

        assertEq(mod1.balance, mod1Start + 0.5 ether);
        assertEq(mod2.balance, mod2Start + 1.5 ether);
        assertEq(mod3.balance, mod3Start - 2 ether);
    }

    function test_FinalizeCase_QuorumFailureVoidsAndCanReopen() public {
        uint256 postId = _putPostUnderReview();
        _registerModerator(mod1);
        _registerModerator(mod2);

        uint256 mod1Start = mod1.balance;
        uint256 mod2Start = mod2.balance;

        vm.prank(mod1);
        veritas.commitVote{value: 1 ether}(postId, _commitment(true, "secret-1", mod1));
        vm.prank(mod2);
        veritas.commitVote{value: 2 ether}(postId, _commitment(false, "secret-2", mod2));

        vm.warp(block.timestamp + 10 minutes + 1);
        veritas.finalizeCase(postId);

        assertEq(mod1.balance, mod1Start);
        assertEq(mod2.balance, mod2Start);
        assertEq(veritas.activeCases(mod1), 0);
        assertEq(veritas.activeCases(mod2), 0);

        Veritas.Post memory post = veritas.getPost(postId);
        assertEq(uint256(post.state), uint256(Veritas.PostState.UNDER_REVIEW));

        (uint256 commitDeadline, , , , uint256 voterCount, , ) = veritas.getTribunalCase(postId);
        assertEq(commitDeadline, 0);
        assertEq(voterCount, 0);

        _registerModerator(mod3);
        vm.prank(mod3);
        veritas.commitVote{value: 1 ether}(postId, _commitment(true, "secret-3", mod3));
        (uint256 reopenedDeadline, , , , uint256 reopenedVoterCount, , ) =
            veritas.getTribunalCase(postId);
        assertGt(reopenedDeadline, 0);
        assertEq(reopenedVoterCount, 1);
    }

    function test_FlagBannedPost_Reverts() public {
        uint256 postId = _putPostUnderReview();
        _registerModerator(mod1);
        _registerModerator(mod2);
        _registerModerator(mod3);

        vm.prank(mod1);
        veritas.commitVote{value: 2 ether}(postId, _commitment(false, "secret-1", mod1));
        vm.prank(mod2);
        veritas.commitVote{value: 2 ether}(postId, _commitment(false, "secret-2", mod2));
        vm.prank(mod3);
        veritas.commitVote{value: 1 ether}(postId, _commitment(true, "secret-3", mod3));

        vm.warp(block.timestamp + 5 minutes + 1);
        vm.prank(mod1);
        veritas.revealVote(postId, false, "secret-1");
        vm.prank(mod2);
        veritas.revealVote(postId, false, "secret-2");
        vm.prank(mod3);
        veritas.revealVote(postId, true, "secret-3");

        vm.warp(block.timestamp + 5 minutes + 1);
        veritas.finalizeCase(postId);

        vm.prank(frank);
        vm.expectRevert("Post is not active");
        veritas.flagPost(postId);
    }

    function _registerModerator(address moderator) internal {
        uint256 deposit = veritas.MODERATOR_DEPOSIT();
        vm.prank(moderator);
        veritas.registerModerator{value: deposit}();
    }

    function _putPostUnderReview() internal returns (uint256) {
        vm.prank(alice);
        uint256 postId = veritas.createPost(TEST_CID, TEST_TAG);

        vm.prank(bob);
        veritas.flagPost(postId);

        return postId;
    }

    function _commitment(
        bool vote,
        string memory secret,
        address moderator
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(vote, secret, moderator));
    }
}
