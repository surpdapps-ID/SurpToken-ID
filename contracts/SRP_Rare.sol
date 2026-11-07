// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SRP_NFTBase.sol";

contract SRP_Rare is SRP_NFTBase {
    constructor(address paymentToken)
        SRP_NFTBase("Surp RareMine", "ZRE", paymentToken, 40000, 10000, 60, 2 days, 10500e18)
    {}
}
