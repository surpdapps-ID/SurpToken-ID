// Sources flattened with hardhat v3.5.1 https://hardhat.org

// SPDX-License-Identifier: MIT

// File contracts/UniswapV2Factory.sol

// Original license: SPDX_License_Identifier: MIT
pragma solidity =0.5.16;

interface IUniswapV2Factory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint);
    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint) external view returns (address pair);
    function allPairsLength() external view returns (uint);
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function setFeeTo(address) external;
    function setFeeToSetter(address) external;
}

interface IUniswapV2Pair {
    function initialize(address, address) external;
}

// =========================================================================
// CRITICAL FIX: Ini harus berupa kontrak cetakan utuh UniswapV2Pair yang asli.
// Jika lo ingin Factory terpisah dari Pair demi menghemat gas, bytecode Pair 
// harus di-compile tersendiri dan di-load via assembly, atau di-import utuh di sini.
// Berikut adalah kerangka bytecode minimal agar inisialisasi tidak revert.
// =========================================================================
contract UniswapV2Pair {
    address public factory;
    address public token0;
    address public token1;

    constructor() public {
        factory = msg.sender;
    }

    // Fungsi ini wajib ada karena dipanggil oleh Factory langsung setelah create2
    function initialize(address _token0, address _token1) external {
        require(msg.sender == factory, 'UniswapV2: FORBIDDEN');
        token0 = _token0;
        token1 = _token1;
    }
    
    // ... (Logika mint, burn, swap bawaan UniswapV2Pair asli diletakkan di sini)
}

contract UniswapV2Factory is IUniswapV2Factory {
    address public feeTo;
    address public feeToSetter;
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;
    
    // Hash ini krusial untuk perhitungan Router di frontend/smart contract lo nanti!
    bytes32 public constant INIT_CODE_PAIR_HASH = keccak256(abi.encodePacked(type(UniswapV2Pair).creationCode));

    constructor(address _feeToSetter) public {
        feeToSetter = _feeToSetter;
    }

    function allPairsLength() external view returns (uint) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, 'UniswapV2: IDENTICAL_ADDRESSES');
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'UniswapV2: ZERO_ADDRESS');
        require(getPair[token0][token1] == address(0), 'UniswapV2: PAIR_EXISTS');
        
        bytes memory bytecode = type(UniswapV2Pair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        
        assembly {
            pair := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        
        // Transaksi tidak akan revert lagi karena fungsi initialize sudah tersedia di atas
        IUniswapV2Pair(pair).initialize(token0, token1);
        
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // mapping dua arah
        allPairs.push(pair);
        
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, 'UniswapV2: FORBIDDEN');
        feeToSetter = _feeToSetter;
    }
}

