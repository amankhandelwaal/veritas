// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Veritas.sol";

contract VeritasTest is Test {

    Veritas public veritas;

    // Named test wallets — makes test output readable
    address owner     = makeAddr("owner");
    address alice     = makeAddr("alice");
    address bob       = makeAddr("bob");
    address carol     = makeAddr("carol");
    address dave      = makeAddr("dave");
    address eve       = makeAddr("eve");

    // 5 moderator wallets
    address mod1      = makeAddr("mod1");
    address mod2      = makeAddr("mod2");
    address mod3      = makeAddr("mod3");
    address mod4      = makeAddr("mod4");
    address mod5      = makeAddr("mod5");

    string constant TEST_CID = "QmTestCID123456789";
    string constant TEST_TAG = "AI_Research";

    // ─── Setup ───────────────────────────────────────────────

    function setUp() public {
        // Deploy as owner
        vm.prank(owner);
        veritas = new Veritas();

        // Register 5 moderators
        vm.startPrank(owner);
        veritas.addModerator(mod1);
        veritas.addModerator(mod2);
        veritas.addModerator(mod3);
        veritas.addModerator(mod4);
        veritas.addModerator(mod5);
        vm.stopPrank();
    }

    // ─── Post Creation ───────────────────────────────────────

    function test_CreatePost_Success() public {
        vm.prank(alice);
        uint256 postId = veritas.createPost(TEST_CID, TEST_TAG);

        assertEq(postId, 1);
        assertEq(veritas.getPostCount(), 1);

        Veritas.Post memory post = veritas.getPost(1);
        assertEq(post.author, alice);
        assertEq(post.flagCount, 0);
        assertEq(uint(post.state), uint(Veritas.PostState.ACTIVE));
    }

    function test_CreatePost_EmitEvent() public {
        // Tell forge to expect this exact event
        vm.expectEmit(true, true, false, false);
        emit Veritas.PostCreated(1, alice, TEST_CID, TEST_TAG, block.timestamp);

        vm.prank(alice);
        veritas.createPost(TEST_CID, TEST_TAG);
    }

    function test_CreatePost_EmptyCID_Reverts() public {
        vm.prank(alice);
        vm.expectRevert("CID cannot be empty");
        veritas.createPost("", TEST_TAG);
    }

    function test_CreatePost_EmptyTag_Reverts() public {
        vm.prank(alice);
        vm.expectRevert("Tag cannot be empty");
        veritas.createPost(TEST_CID, "");
    }

    function test_CreatePost_MultiplePostsIncrementId() public {
        vm.prank(alice);
        veritas.createPost(TEST_CID, TEST_TAG);

        vm.prank(bob);
        uint256 secondId = veritas.createPost(TEST_CID, TEST_TAG);

        assertEq(secondId, 2);
        assertEq(veritas.getPostCount(), 2);
    }

    // ─── Flagging ────────────────────────────────────────────

    function test_FlagPost_Success() public {
        vm.prank(alice);
        veritas.createPost(TEST_CID, TEST_TAG);

        vm.prank(bob);
        veritas.flagPost(1);

        Veritas.Post memory post = veritas.getPost(1);
        assertEq(post.flagCount, 1);
        assertEq(uint(post.state), uint(Veritas.PostState.ACTIVE));
    }

    function test_FlagPost_AuthorCannotFlagOwn_Reverts() public {
        vm.prank(alice);
        veritas.createPost(TEST_CID, TEST_TAG);

        vm.prank(alice);
        vm.expectRevert("Cannot flag your own post");
        veritas.flagPost(1);
    }

    function test_FlagPost_CannotFlagTwice_Reverts() public {
        vm.prank(alice);
        veritas.createPost(TEST_CID, TEST_TAG);

        vm.prank(bob);
        veritas.flagPost(1);

        vm.prank(bob);
        vm.expectRevert("Already flagged");
        veritas.flagPost(1);
    }

    function test_FlagPost_ThreeFlagsTriggersUnderReview() public {
        vm.prank(alice);
        veritas.createPost(TEST_CID, TEST_TAG);

        vm.prank(bob);   veritas.flagPost(1);
        vm.prank(carol); veritas.flagPost(1);
        vm.prank(dave);  veritas.flagPost(1);

        Veritas.Post memory post = veritas.getPost(1);
        assertEq(uint(post.state), uint(Veritas.PostState.UNDER_REVIEW));
        assertEq(post.flagCount, 3);
    }

    function test_FlagPost_NonExistent_Reverts() public {
        vm.prank(bob);
        vm.expectRevert("Post does not exist");
        veritas.flagPost(999);
    }

    // ─── Moderation Voting ───────────────────────────────────

    function _putPostUnderReview() internal returns (uint256) {
        vm.prank(alice);
        veritas.createPost(TEST_CID, TEST_TAG);

        vm.prank(bob);   veritas.flagPost(1);
        vm.prank(carol); veritas.flagPost(1);
        vm.prank(dave);  veritas.flagPost(1);

        return 1;
    }

    function test_ModeratorVote_BanPost() public {
        uint256 postId = _putPostUnderReview();

        vm.prank(mod1); veritas.moderatorVote(postId, false);
        vm.prank(mod2); veritas.moderatorVote(postId, false);
        vm.prank(mod3); veritas.moderatorVote(postId, false);

        Veritas.Post memory post = veritas.getPost(postId);
        assertEq(uint(post.state), uint(Veritas.PostState.BANNED));
    }

    function test_ModeratorVote_ApprovePost() public {
        uint256 postId = _putPostUnderReview();

        vm.prank(mod1); veritas.moderatorVote(postId, true);
        vm.prank(mod2); veritas.moderatorVote(postId, true);
        vm.prank(mod3); veritas.moderatorVote(postId, true);

        Veritas.Post memory post = veritas.getPost(postId);
        assertEq(uint(post.state), uint(Veritas.PostState.ACTIVE));
    }

    function test_ModeratorVote_NonModerator_Reverts() public {
        uint256 postId = _putPostUnderReview();

        vm.prank(eve);
        vm.expectRevert("Not a moderator");
        veritas.moderatorVote(postId, true);
    }

    function test_ModeratorVote_CannotVoteTwice_Reverts() public {
        uint256 postId = _putPostUnderReview();

        vm.prank(mod1);
        veritas.moderatorVote(postId, true);

        vm.prank(mod1);
        vm.expectRevert("Already voted");
        veritas.moderatorVote(postId, true);
    }

    function test_ModeratorVote_PostNotUnderReview_Reverts() public {
        vm.prank(alice);
        veritas.createPost(TEST_CID, TEST_TAG);

        vm.prank(mod1);
        vm.expectRevert("Post not under review");
        veritas.moderatorVote(1, true);
    }

    function test_ModeratorVote_CannotVoteAfterResolved_Reverts() public {
        uint256 postId = _putPostUnderReview();

        vm.prank(mod1); veritas.moderatorVote(postId, false);
        vm.prank(mod2); veritas.moderatorVote(postId, false);
        vm.prank(mod3); veritas.moderatorVote(postId, false);

        // Case resolved — mod4 tries to vote after
        vm.prank(mod4);
        vm.expectRevert("Post not under review");
        veritas.moderatorVote(postId, false);
    }

    function test_GetVoteCounts() public {
        uint256 postId = _putPostUnderReview();

        vm.prank(mod1); veritas.moderatorVote(postId, true);
        vm.prank(mod2); veritas.moderatorVote(postId, false);

        (uint256 approve, uint256 ban) = veritas.getVoteCounts(postId);
        assertEq(approve, 1);
        assertEq(ban, 1);
    }

    // ─── Moderator Management ────────────────────────────────

    function test_AddModerator_OnlyOwner_Reverts() public {
        address newMod = makeAddr("newMod");

        vm.prank(alice);
        vm.expectRevert();
        veritas.addModerator(newMod);
    }

    function test_AddModerator_MaxFive_Reverts() public {
        // Already have 5 from setUp
        address sixthMod = makeAddr("sixthMod");

        vm.prank(owner);
        vm.expectRevert("Maximum 5 moderators");
        veritas.addModerator(sixthMod);
    }

    function test_RemoveModerator_Success() public {
        vm.prank(owner);
        veritas.removeModerator(mod5);

        assertFalse(veritas.isModerator(mod5));
        assertEq(veritas.getModerators().length, 4);
    }

    function test_RemoveModerator_NotModerator_Reverts() public {
        vm.prank(owner);
        vm.expectRevert("Not a moderator");
        veritas.removeModerator(alice);
    }

    function test_GetModerators_ReturnsAll() public view {
        address[] memory mods = veritas.getModerators();
        assertEq(mods.length, 5);
    }

    // ─── Cannot Flag Banned Post ─────────────────────────────

    function test_FlagBannedPost_Reverts() public {
        uint256 postId = _putPostUnderReview();

        vm.prank(mod1); veritas.moderatorVote(postId, false);
        vm.prank(mod2); veritas.moderatorVote(postId, false);
        vm.prank(mod3); veritas.moderatorVote(postId, false);

        // Post is now BANNED — eve tries to flag it
        vm.prank(eve);
        vm.expectRevert("Post is not active");
        veritas.flagPost(postId);
    }
}