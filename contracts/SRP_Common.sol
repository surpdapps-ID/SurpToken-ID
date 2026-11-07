// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SRP_NFTBase.sol";

contract SRP_Common is SRP_NFTBase {
    constructor(address paymentToken)
        SRP_NFTBase("Surp CommonMine", "ZCN", paymentToken, 50000, 10000, 50, 2 days, 10000e18)
    {}
}
