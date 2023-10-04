// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

/*
 * Interface for the solidity verifier generated by snarkjs
 */
interface IVerifier {
    function verifyProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[14] memory input
    ) external view returns (bool);
}

struct MoveInputs {
    uint256 currentInterval;
    uint256 fromPkHash;
    uint256 fromCityId;
    uint256 toCityId;
    uint256 ontoSelfOrUnowned;
    uint256 numTroopsMoved;
    uint256 enemyLoss;
    uint256 capturedTile;
    uint256 takingCity;
    uint256 takingCapital;
    uint256 hTFrom;
    uint256 hTTo;
    uint256 hUFrom;
    uint256 hUTo;
}

struct ProofInputs {
    uint256[2] a;
    uint256[2][2] b;
    uint256[2] c;
}

struct SignatureInputs {
    uint8 v;
    bytes32 r;
    bytes32 s;
}

contract NStates {
    IVerifier verifierContract =
        IVerifier(0x5FbDB2315678afecb367f032d93F642f64180aa3);

    event NewMove(uint256 hUFrom, uint256 hUTo);

    address public owner;
    uint256 public numBlocksInInterval;
    uint256 public numStartingResources;

    mapping(uint256 => uint256) public citiesToPlayer;
    mapping(uint256 => uint256[]) public playerToCities;
    mapping(uint256 => uint256) public playerToCapital;
    mapping(uint256 => uint256) public capitalToPlayer;

    // A city's index in player's list of cities. Maintained for O(1) deletion
    mapping(uint256 => uint256) public indexOfCity;

    mapping(uint256 => uint256) public cityArea;
    mapping(uint256 => uint256) public cityResources;

    mapping(uint256 => bool) public tileCommitments;

    constructor(
        address contractOwner,
        uint256 nBlocksInInterval,
        uint256 nStartingResources
    ) {
        owner = contractOwner;
        numBlocksInInterval = nBlocksInInterval;
        numStartingResources = nStartingResources;
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
        tileCommitments[h] = true;
    }

    /*
     * Game deployer has the ability to initialize players onto the board.
     */
    function spawn(uint256 pkHash, uint256 cityId, uint256 h) public onlyOwner {
        require(cityId != 0, "City ID must be a non-zero value");
        require(citiesToPlayer[cityId] == 0, "City is already in game");

        set(h);

        playerToCapital[pkHash] = cityId;
        capitalToPlayer[cityId] = pkHash;

        citiesToPlayer[cityId] = pkHash;
        playerToCities[pkHash] = [cityId];
        indexOfCity[cityId] = 0;

        cityArea[cityId] = 1;
        cityResources[cityId] = numStartingResources;
    }

    /*
     * Accepts new states for tiles involved in move. Moves must operate on
     * states whoe commitments are on-chain, AND carry a ZKP anchored to a
     * commited state, AND carry a signature from the enclave.
     */
    function move(
        MoveInputs memory moveInputs,
        ProofInputs memory moveProof,
        SignatureInputs memory sig
    ) public {
        require(
            tileCommitments[moveInputs.hTFrom] && tileCommitments[moveInputs.hTTo],
            "Old tile states must be valid"
        );
        require(
            currentInterval() >= moveInputs.currentInterval,
            "Move is too far into the future, change currentInterval value"
        );
        require(
            moveInputs.fromPkHash == citiesToPlayer[moveInputs.fromCityId],
            "Must move from a city that you own"
        );
        require(
            checkOntoSelfOrUnowned(
                moveInputs.fromPkHash,
                moveInputs.toCityId,
                moveInputs.ontoSelfOrUnowned
            ),
            "Value of ontoSelfOrUnowned is incorrect"
        );
        require(
            getSigner(moveInputs.hUFrom, moveInputs.hUTo, sig) == owner,
            "Enclave signature is incorrect"
        );
        require(
            verifierContract.verifyProof(
                moveProof.a,
                moveProof.b,
                moveProof.c,
                toArray(moveInputs)
            ),
            "Invalid move proof"
        );

        delete tileCommitments[moveInputs.hTFrom];
        delete tileCommitments[moveInputs.hTTo];

        tileCommitments[moveInputs.hUFrom] = true;
        tileCommitments[moveInputs.hUTo] = true;

        if (moveInputs.capturedTile == 1) {
            if (moveInputs.ontoSelfOrUnowned == 1) {
                // Moving onto an unowned tile
                ++cityArea[moveInputs.fromCityId];
            } else {
                // Moving onto enemy with less resources
                if (moveInputs.takingCity == 1) {
                    cityResources[moveInputs.fromCityId] -= moveInputs
                        .numTroopsMoved;
                    cityResources[moveInputs.toCityId] +=
                        moveInputs.numTroopsMoved -
                        moveInputs.enemyLoss;

                    transferCityOwnership(
                        moveInputs.fromPkHash,
                        moveInputs.toCityId,
                        moveInputs.ontoSelfOrUnowned
                    );
                } else if (moveInputs.takingCapital == 1) {
                    cityResources[moveInputs.fromCityId] -= moveInputs
                        .numTroopsMoved;
                    cityResources[moveInputs.toCityId] +=
                        moveInputs.numTroopsMoved -
                        moveInputs.enemyLoss;

                    uint256 enemy = capitalToPlayer[moveInputs.toCityId];

                    while (playerToCities[enemy].length > 0) {
                        uint256 lastIndex = playerToCities[enemy].length - 1;
                        transferCityOwnership(
                            moveInputs.fromPkHash,
                            playerToCities[enemy][lastIndex],
                            0
                        );
                    }

                    playerToCapital[enemy] = 0;
                    capitalToPlayer[moveInputs.toCityId] = 0;
                } else {
                    cityResources[moveInputs.fromCityId] -= moveInputs
                        .enemyLoss;
                    ++cityArea[moveInputs.fromCityId];
                    cityResources[moveInputs.toCityId] -= moveInputs.enemyLoss;
                    --cityArea[moveInputs.toCityId];
                }
            }
        } else {
            if (moveInputs.ontoSelfOrUnowned == 1) {
                // Moving onto one of player's own cities
                cityResources[moveInputs.fromCityId] -= moveInputs
                    .numTroopsMoved;
                cityResources[moveInputs.toCityId] += moveInputs.numTroopsMoved;
            } else {
                // Moving onto enemy with more/eq. resources
                cityResources[moveInputs.fromCityId] -= moveInputs.enemyLoss;
                cityResources[moveInputs.toCityId] -= moveInputs.enemyLoss;
            }
        }

        emit NewMove(moveInputs.hUFrom, moveInputs.hUTo);
    }

    /*
     * Helper function for move(). Checks if public signal ontoSelfOrUnowned is
     * set correctly. ontoSelfOrUnowned is used in the ZKP, but must be
     * checked onchain.
     */
    function checkOntoSelfOrUnowned(
        uint256 fromPkHash,
        uint256 toCityId,
        uint256 ontoSelfOrUnowned
    ) internal view returns (bool) {
        uint256 toCityOwner = citiesToPlayer[toCityId];
        if (toCityOwner == fromPkHash || toCityOwner == 0) {
            return ontoSelfOrUnowned == 1;
        }
        return ontoSelfOrUnowned == 0;
    }

    /*
     * Transfers ownership of one city to its new owner.
     */
    function transferCityOwnership(
        uint256 newOwner,
        uint256 toCityId,
        uint256 ontoSelfOrUnowned
    ) internal {
        // If player is moving onto an enemy's city
        if (ontoSelfOrUnowned == 0) {
            uint256 enemy = citiesToPlayer[toCityId];

            // Pop toCityId from enemyCityList
            uint256 lastIndex = playerToCities[enemy].length - 1;
            uint256 lastElement = playerToCities[enemy][lastIndex];
            playerToCities[enemy][indexOfCity[toCityId]] = lastElement;
            playerToCities[enemy].pop();

            // The new index of lastElement is where toCityId was
            indexOfCity[lastElement] = indexOfCity[toCityId];
        }

        uint256[] storage cityList = playerToCities[newOwner];
        indexOfCity[toCityId] = cityList.length;
        cityList.push(toCityId);
        playerToCities[newOwner] = cityList;
        citiesToPlayer[toCityId] = newOwner;
    }

    /*
     * Troop/water updates are counted in intervals, where the current interval is
     * the current block height divided by interval length.
     */
    function currentInterval() public view returns (uint256) {
        return block.number / numBlocksInInterval;
    }

    /*
     * From a signature obtain the address that signed. This should
     * be the enclave's address whenever a player submits a move.
     */
    function getSigner(
        uint256 hUFrom,
        uint256 hUTo,
        SignatureInputs memory sig
    ) public pure returns (address) {
        bytes32 hash = keccak256(abi.encode(hUFrom, hUTo));
        bytes32 prefixedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)
        );
        return ecrecover(prefixedHash, sig.v, sig.r, sig.s);
    }

    function toArray(
        MoveInputs memory moveInputs
    ) internal pure returns (uint256[14] memory) {
        return [
            moveInputs.currentInterval,
            moveInputs.fromPkHash,
            moveInputs.fromCityId,
            moveInputs.toCityId,
            moveInputs.ontoSelfOrUnowned,
            moveInputs.numTroopsMoved,
            moveInputs.enemyLoss,
            moveInputs.capturedTile,
            moveInputs.takingCity,
            moveInputs.takingCapital,
            moveInputs.hTFrom,
            moveInputs.hTTo,
            moveInputs.hUFrom,
            moveInputs.hUTo
        ];
    }
}
