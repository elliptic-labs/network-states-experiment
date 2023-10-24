// SPDX-License-Identifier: MIT
pragma solidity >=0.8.21;

/* Autogenerated file. Do not edit manually. */

/**
 * @title IConfigSystem
 * @dev This interface is automatically generated from the corresponding system contract. Do not edit manually.
 */
interface IConfigSystem {
  function setSpawnVerifier(address spawnVerifier) external;

  function setMoveVerifier(address moveVerifier) external;

  function setNumStartingTroops(uint32 numStartingTroops) external;

  function setEnclave(address enclave) external;

  function setClaimedMoveLifeSpan(uint256 claimedMoveLifeSpan) external;

  function setNumBlocksInInterval(uint256 numBlocksInInterval) external;
}
