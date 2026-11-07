// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SRP_NFTBase.sol";

contract SRP_Epic is SRP_NFTBase {
    constructor(address paymentToken)
        SRP_NFTBase("Surp EpicMine", "ZEC", paymentToken, 30000, 10000, 70, 2 days, 11000e18)
    {}
}
