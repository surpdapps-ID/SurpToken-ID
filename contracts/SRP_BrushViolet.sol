// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SRP_NFTBase.sol";

contract SRP_BrushViolet is SRP_NFTBase {
    constructor(address paymentToken)
        SRP_NFTBase("Surp BrushMine", "ZBV", paymentToken, 5000, 5000, 100, 2 days, 12500e18)
    {}
}
