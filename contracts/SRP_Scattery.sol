// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SRP_NFTBase.sol";

contract SRP_Scattery is SRP_NFTBase {
    constructor(address paymentToken)
        SRP_NFTBase("Surp ScaterryMine", "ZSY", paymentToken, 10000, 10000, 90, 2 days, 12000e18)
    {}
}
