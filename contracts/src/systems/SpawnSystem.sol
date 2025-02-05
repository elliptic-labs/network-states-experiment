// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {System} from "@latticexyz/world/src/System.sol";

import {IEnclaveEvents} from "common/IEnclaveEvents.sol";
import {Config, SpawnCommitment, TileCommitment} from "codegen/index.sol";
import {Groth16Proof} from "common/Groth16Proof.sol";
import {SpawnInputs} from "common/SpawnInputs.sol";
import {VirtualInputs} from "common/VirtualInputs.sol";
import {Signature} from "common/Signature.sol";
import {IEnclaveEvents} from "common/IEnclaveEvents.sol";
import {LibSpawn} from "libraries/LibSpawn.sol";
import {LibSpawnVerify} from "libraries/LibSpawnVerify.sol";
import {LibVirtualVerify} from "libraries/LibVirtualVerify.sol";

contract SpawnSystem is IEnclaveEvents, System {
    function commitToSpawn(uint256 h) public {
        require(
            SpawnCommitment.get(_msgSender()) == 0,
            "Already commited to spawn"
        );
        
        SpawnCommitment.set({id: _msgSender(), value: h});
    }

    function spawn(
        SpawnInputs memory spawnInputs,
        Groth16Proof memory spawnProof,
        VirtualInputs memory virtualInputs,
        Groth16Proof memory virtualProof,
        Signature memory sig
    ) public {
        LibSpawn.checkSpawnInputs(spawnInputs, sig);
        LibSpawnVerify.verifySpawnProof(spawnInputs, spawnProof);
        LibVirtualVerify.verifyVirtualProof(virtualInputs, virtualProof);

        if (spawnInputs.canSpawn) {
            LibSpawn.spawnPlayer(_msgSender(), spawnInputs);

            emit NewTile(spawnInputs.hSpawnTile);
            emit NewSpawnAttempt(_msgSender(), spawnInputs.hSpawnTile, true);
        } else {
            LibSpawn.resetPlayer(_msgSender());

            emit NewSpawnAttempt(_msgSender(), spawnInputs.hSpawnTile, false);
        }
    }

    function set(uint256 h) public {
        require(
            _msgSender() == Config.getEnclave(),
            "Only enclave can set commitments"
        );
        TileCommitment.set({id: h, value: true});
        emit NewTile(h);
    }

    function getSpawnCommitment(address player) public view returns (uint256) {
        return SpawnCommitment.getValue(player);
    }
}
