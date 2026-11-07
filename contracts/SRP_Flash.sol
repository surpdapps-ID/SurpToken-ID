// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SRP_NFTBase.sol";

contract SRP_Flash is SRP_NFTBase {
    constructor(address paymentToken)
        SRP_NFTBase("Surp FlashMine", "ZFH", paymentToken, 20000, 10000, 80, 2 days, 11500e18)
    {}
}
