// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockInvestorEligibility {
    mapping(address => bool) public hasInvested;

    function setInvestor(address investor, bool eligible) external {
        hasInvested[investor] = eligible;
    }
}
