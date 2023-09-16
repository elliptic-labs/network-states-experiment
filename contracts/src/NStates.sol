// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {IncrementalMerkleTree} from "./IncrementalMerkleTree.sol";

/*
 * Interface for the solidity verifier generated by snarkjs
 */
interface IVerifier {
    function verifyProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[7] memory input
    ) external view returns (bool);
}

/*
 * Interface for poseidon hasher where t = 3.
 */
interface IHasherT3 {
    function poseidon(uint256[2] memory input) external pure returns (uint256);
}

contract NStates is IncrementalMerkleTree {
    IHasherT3 hasherT3 = IHasherT3(0x5FbDB2315678afecb367f032d93F642f64180aa3);
    IVerifier verifierContract =
        IVerifier(0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512);

    event NewLeaf(uint256 h);
    event NewNullifier(uint256 rho);

    address public owner;
    uint256 public numBlocksInTroopUpdate;
    uint256 public numBlocksInWaterUpdate;
    mapping(uint256 => bool) public nullifiers;

    constructor(
        uint8 treeDepth,
        uint256 nothingUpMySleeve,
        uint256 nBlocksInTroopUpdate,
        uint256 nBlocksInWaterUpdate
    ) IncrementalMerkleTree(treeDepth, nothingUpMySleeve) {
        owner = msg.sender;
        numBlocksInTroopUpdate = nBlocksInTroopUpdate;
        numBlocksInWaterUpdate = nBlocksInWaterUpdate;
    }

    /*
     * Functions with this modifier attached can only be called by the contract
     * deployer.
     */
    modifier onlyOwner() {
        require(msg.sender == owner, "Only the owner can call this function");
        _;
    }

    /*
     * Game deployer has the ability to add initial states (leaves) during board
     * initialization.
     */
    function set(uint256 h) public onlyOwner {
        emit NewLeaf(h);
        insertLeaf(h);
    }

    /*
     * Game deployer has the ability to initialize players onto the board.
     */
    function spawn(uint256 h, uint256 rho) public onlyOwner {
        set(h);
        nullifiers[rho] = true;
        emit NewNullifier(rho);
    }

    /*
     * Accepts new states for tiles involved in move. Nullifies old states.
     * Moves must operate on states that aren't nullified AND carry a ZKP
     * anchored to a historical merkle root to be accepted.
     */
    function move(
        uint256[7] memory pubSignals,
        uint256[8] memory formattedProof,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public {
        // root = pubSignals[0];
        // troopInterval = pubSignals[1];
        // waterInterval = pubSignals[2];
        // hUFrom = pubSignals[3];
        // hUTo = pubSignals[4];
        // rhoFrom = pubSignals[5];
        // rhoTo = pubSignals[6];
        require(rootHistory[pubSignals[0]], "Root must be in root history");
        require(
            currentTroopInterval() >= pubSignals[1],
            "Move is too far into the future, change currentTroopInterval value"
        );
        require(
            currentWaterInterval() >= pubSignals[2],
            "Move is too far into the future, change currentWaterInterval value"
        );
        require(
            !nullifiers[pubSignals[5]] && !nullifiers[pubSignals[6]],
            "Move has already been made"
        );
        require(
            getSigner(pubSignals[3], pubSignals[4], v, r, s) == owner,
            "Enclave signature is incorrect"
        );
        require(
            verifierContract.verifyProof(
                [formattedProof[0], formattedProof[1]],
                [
                    [formattedProof[2], formattedProof[3]],
                    [formattedProof[4], formattedProof[5]]
                ],
                [formattedProof[6], formattedProof[7]],
                pubSignals
            ),
            "Invalid move proof"
        );

        nullifiers[pubSignals[5]] = true;
        nullifiers[pubSignals[6]] = true;

        insertLeaf(pubSignals[3]);
        insertLeaf(pubSignals[4]);

        emit NewLeaf(pubSignals[3]);
        emit NewLeaf(pubSignals[4]);
        emit NewNullifier(pubSignals[5]);
        emit NewNullifier(pubSignals[6]);
    }

    /*
     * Number of leaves in the merkle tree. Value is roughly double the number
     * of historic accepted moves.
     */
    function getNumLeaves() public view returns (uint256) {
        return nextLeafIndex;
    }

    /*
     * Compute poseidon hash of two child hashes.
     */
    function _hashLeftRight(
        uint256 l,
        uint256 r
    ) internal view override returns (uint256) {
        return hasherT3.poseidon([l, r]);
    }

    /*
     * Troop updates are counted in intervals, where the current interval is
     * the current block height divided by interval length.
     */
    function currentTroopInterval() public view returns (uint256) {
        return block.number / numBlocksInTroopUpdate;
    }

    /*
     * Same as troop updates, but how when players lose troops on water tiles.
     */
    function currentWaterInterval() public view returns (uint256) {
        return block.number / numBlocksInWaterUpdate;
    }

    /*
     * From a signature obtain the address that signed. This should
     * be the enclave's address whenever a player submits a move.
     */
    function getSigner(
        uint256 hUFrom,
        uint256 hUTo,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public pure returns (address) {
        bytes32 hash = keccak256(abi.encode(hUFrom, hUTo));
        bytes32 prefixedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)
        );
        return ecrecover(prefixedHash, v, r, s);
    }
}
