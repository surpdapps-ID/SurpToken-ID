// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.7.6;
pragma abicoder v2;

import '../libraries/SurpSwapNFTDescriptor.sol';
import '../libraries/SurpSwapNFTSVG.sol';
import '../libraries/HexStrings.sol';

contract SurpSwapNFTDescriptorTest {
    using HexStrings for uint256;

    function constructTokenURI(SurpSwapNFTDescriptor.ConstructTokenURIParams calldata params)
        public
        pure
        returns (string memory)
    {
        return SurpSwapNFTDescriptor.constructTokenURI(params);
    }

    function getGasCostOfConstructTokenURI(SurpSwapNFTDescriptor.ConstructTokenURIParams calldata params)
        public
        view
        returns (uint256)
    {
        uint256 gasBefore = gasleft();
        SurpSwapNFTDescriptor.constructTokenURI(params);
        return gasBefore - gasleft();
    }

    function tickToDecimalString(
        int24 tick,
        int24 tickSpacing,
        uint8 token0Decimals,
        uint8 token1Decimals,
        bool flipRatio
    ) public pure returns (string memory) {
        return SurpSwapNFTDescriptor.tickToDecimalString(tick, tickSpacing, token0Decimals, token1Decimals, flipRatio);
    }

    function fixedPointToDecimalString(
        uint160 sqrtRatioX96,
        uint8 token0Decimals,
        uint8 token1Decimals
    ) public pure returns (string memory) {
        return SurpSwapNFTDescriptor.fixedPointToDecimalString(sqrtRatioX96, token0Decimals, token1Decimals);
    }

    function feeToPercentString(uint24 fee) public pure returns (string memory) {
        return SurpSwapNFTDescriptor.feeToPercentString(fee);
    }

    function addressToString(address _address) public pure returns (string memory) {
        return SurpSwapNFTDescriptor.addressToString(_address);
    }

    function generateSVGImage(SurpSwapNFTDescriptor.ConstructTokenURIParams memory params) public pure returns (string memory) {
        return SurpSwapNFTDescriptor.generateSVGImage(params);
    }

    function tokenToColorHex(address token, uint256 offset) public pure returns (string memory) {
        return SurpSwapNFTDescriptor.tokenToColorHex(uint256(token), offset);
    }

    function sliceTokenHex(address token, uint256 offset) public pure returns (uint256) {
        return SurpSwapNFTDescriptor.sliceTokenHex(uint256(token), offset);
    }

    function rangeLocation(int24 tickLower, int24 tickUpper) public pure returns (string memory, string memory) {
        return SurpSwapNFTSVG.rangeLocation(tickLower, tickUpper);
    }

    function isRare(uint256 tokenId, address poolAddress) public pure returns (bool) {
        return SurpSwapNFTSVG.isRare(tokenId, poolAddress);
    }
}
