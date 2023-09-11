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
        uint256[6] memory input
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
        uint256 root,
        uint256 troopInterval,
        uint256 hUFrom,
        uint256 hUTo,
        uint256 rhoFrom,
        uint256 rhoTo,
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c
    ) public {
        require(rootHistory[root], "Root must be in root history");
        require(
            currentTroopInterval() >= troopInterval,
            "Move is too far into the future, change currentTroopInterval value"
        );
        require(
            !nullifiers[rhoFrom] && !nullifiers[rhoTo],
            "Move has already been made"
        );
        require(
            verifierContract.verifyProof(
                a,
                b,
                c,
                [root, troopInterval, hUFrom, hUTo, rhoFrom, rhoTo]
            ),
            "Invalid move proof"
        );

        nullifiers[rhoFrom] = true;
        nullifiers[rhoTo] = true;

        insertLeaf(hUFrom);
        insertLeaf(hUTo);

        emit NewLeaf(hUFrom);
        emit NewLeaf(hUTo);
        emit NewNullifier(rhoFrom);
        emit NewNullifier(rhoTo);
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
}
