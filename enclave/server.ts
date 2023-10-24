import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import { ethers, utils } from "ethers";
import * as fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
import {
    ServerToClientEvents,
    ClientToServerEvents,
    InterServerEvents,
    SocketData,
} from "./socket";
import { Queue } from "queue-typescript";
import { Tile, Player, Board, Location, Utils } from "../game";
/*
 * poseidonPerm is a modified version of iden3's poseidonPerm.js.
 */
const poseidonPerm = require("../game/poseidonPerm");
import { TerrainUtils } from "../game/Terrain.js";
import worlds from "../contracts/worlds.json" assert { type: "json" };
import IWorld from "../contracts/out/IWorld.sol/IWorld.json" assert { type: "json" };
import IEnclaveEvents from "../contracts/out/IEnclaveEvents.sol/IEnclaveEvents.json" assert { type: "json" };

/*
 * Whether the enclave's global state should be blank or pull from DA.
 */
let inRecoveryMode = process.argv[2] == "1";

/*
 * Set game parameters and create dummy players.
 */
const BOARD_SIZE: number = parseInt(<string>process.env.BOARD_SIZE, 10);
const START_RESOURCES: number = parseInt(
    <string>process.env.START_RESOURCES,
    10
);

/*
 * Number of blocks that a claimed move is allowed to be pending without being
 * deleted.
 */
const CLAIMED_MOVE_LIFE_SPAN = parseInt(
    <string>process.env.CLAIMED_MOVE_LIFE_SPAN,
    10
);

/*
 * Using Socket.IO to manage communication to clients.
 */
const app = express();
const server = http.createServer(app);
const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
>(server);

/*
 * Boot up interface with Network States contract.
 */
const signer = new ethers.Wallet(
    <string>process.env.PRIVATE_KEY,
    new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
);

const abi = IWorld.abi.concat(IEnclaveEvents.abi);
const nStates = new ethers.Contract(worlds[31337].address, abi, signer);

type ClaimedSpawn = {
    prevTile: Tile;
    spawnTile: Tile;
};

type ClaimedMove = {
    uFrom: Tile;
    uTo: Tile;
    blockSubmitted: number;
    uFromEnc: EncryptedTile;
    uToEnc: EncryptedTile;
};

type EncryptedTile = {
    symbol: string;
    address: string;
    ciphertext: string;
    iv: string;
    tag: string;
};

/*
 * Enclave's internal belief on game state stored in Board object.
 */
let b: Board;

/*
 * City ID given to each spawning player. Increments by one each time.
 *
 * [TODO]: eventually, the client will sample their own cityId, and the contract
 * will check that the cityId is not in use.
 */
let cityId: number = 1;

/*
 * Bijection between player's public keys and their socket IDs.
 */
let idToAddress = new Map<string, string>();
let addressToId = new Map<string, string>();

/*
 * Moves claimed by players. A move is finalized whenever NewMove event is
 * emitted.
 */
let claimedMoves = new Map<string, ClaimedMove>();

/*
 * Spawn attempts players successfully commit. Player is spawned in whenever a
 * Spawn event is emitted.
 */
let claimedSpawns = new Map<string, ClaimedSpawn>();

/*
 * Current block height. Storing the value in a variable saves from
 * unnecessarily indexing twice.
 */
let currentBlockHeight: number;

/*
 * Latest block height players proposed a move.
 */
let playerLatestBlock = new Map<string, number>();

/*
 * Encryption key for global state sent to DA.
 */
let tileEncryptionKey: Buffer;

/*
 * Socket ID of DA node.
 */
let socketIdDA: string | undefined;

/*
 * Queue of claimed new tile states that have yet to be pushed to DA.
 */
let queuedTilesDA = new Queue<EncryptedTile>();

/*
 * Index for retrieving encrypted tiles from DA node.
 */
let recoveryModeIndex = 0;

/*
 * If player is already spawned, return visible tiles for decryption. If not,
 * tell player to initiate spawning.
 */
function login(socket: Socket, address: string, sigStr: string) {
    if (inRecoveryMode) {
        socket.disconnect();
        return;
    }

    if (addressToId.has(address)) {
        console.log("Address already logged on");
        socket.disconnect();
        return;
    }

    let sender: string | undefined;
    try {
        sender = ethers.utils.verifyMessage(socket.id, sigStr);
    } catch (error) {
        console.log("Malignant signature", sigStr);
        socket.disconnect();
        return;
    }

    if (!sender || address != sender) {
        console.log("Incorrect address given or bad signature");
        socket.disconnect();
        return;
    }

    idToAddress.set(socket.id, address);
    addressToId.set(address, socket.id);

    if (b.isSpawned(new Player("", address))) {
        idToAddress.set(socket.id, address);
        addressToId.set(address, socket.id);

        playerLatestBlock.set(address, 0);

        let visibleTiles = new Set<string>();
        b.playerCities.get(address)?.forEach((cityId: number) => {
            b.cityTiles.get(cityId)?.forEach((locString: string) => {
                const tl = JSON.parse(locString);
                if (tl) {
                    for (let loc of b.getNearbyLocations(tl)) {
                        visibleTiles.add(JSON.stringify(loc));
                    }
                }
            });
        });
        socket.emit("loginResponse", Array.from(visibleTiles));
    } else {
        socket.emit("trySpawn");
    }
}

/*
 * Propose to spawn at location l. Returns a signature of the old and new tiles
 * at location for contract to verify, or null value if player cannot spawn at
 * this location.
 */
async function getSpawnSignature(
    socket: Socket,
    symbol: string,
    address: string,
    sigStr: string,
    playerSecret: string
) {
    const sender = idToAddress.get(socket.id);
    if (inRecoveryMode || !sender) {
        socket.disconnect();
        return;
    }

    if (claimedSpawns.has(sender)) {
        console.log("Already committed to spawn");
        socket.disconnect();
        return;
    }

    if (claimedSpawns.has(address)) {
        console.log("Already committed to spawn");
        socket.disconnect();
        return;
    }

    let playerChallenge: BigInt | undefined;
    try {
        playerChallenge = BigInt(playerSecret);
    } catch (error) {
        console.log("Malignant secret: ", sigStr);
        socket.disconnect();
        return;
    }

    // Check if player has committed to spawning onchain
    const latestBlockCommited = Number(
        await nStates.getSpawnCommitment(address)
    );
    const hSecret = await nStates.getSpawnChallengeHash(address);

    if (
        latestBlockCommited == 0 ||
        hSecret != poseidonPerm([0, playerSecret])[0]
    ) {
        console.log(
            "Player already has enclave sig, or hSecret is inconsistent"
        );
        socket.disconnect();
        return;
    }

    // Pair the public key and the socket ID
    idToAddress.set(socket.id, sender);
    addressToId.set(sender, socket.id);

    // Compute location
    const commitBlockHash = await nStates.getBlockHash(latestBlockCommited);

    // [TODO]: determine formula for row/col
    const rawRow = poseidonPerm([0, playerChallenge, commitBlockHash, 0])[0];
    const rawCol = poseidonPerm([0, playerChallenge, commitBlockHash, 1])[0];
    const r = Number(rawRow % BigInt(b.t.length));
    const c = Number(rawCol % BigInt(b.t.length));
    const l = { r, c };

    const prevTile = b.getTile(l);
    const hPrevTile = prevTile.hash();
    const spawnTile = Tile.spawn(
        new Player(symbol, address),
        l,
        START_RESOURCES,
        cityId
    );
    cityId++;
    const hSpawnTile = spawnTile.hash();

    claimedSpawns.set(address, { prevTile, spawnTile });

    // Is this right???
    const digest = utils.solidityKeccak256(
        ["uint256", "uint256", "uint256"],
        [latestBlockCommited, hPrevTile, hSpawnTile]
    );
    const sig = await signer.signMessage(utils.arrayify(digest));

    socket.emit(
        "spawnSignatureResponse",
        sig,
        prevTile.toJSON(),
        spawnTile.toJSON()
    );
}

/*
 * Propose move to enclave. In order for the move to be solidified, the enclave
 * must respond to a leaf event.
 */
async function getMoveSignature(socket: Socket, uFrom: any, uTo: any) {
    const sender = idToAddress.get(socket.id);
    if (inRecoveryMode || !sender) {
        // Cut the connection
        socket.disconnect();
        return;
    }

    // Players cannot make more than one move per block
    const latestBlock = playerLatestBlock.get(sender);
    if (
        latestBlock != undefined &&
        latestBlock < currentBlockHeight &&
        uFrom.address == sender
    ) {
        const uFromAsTile = Tile.fromJSON(uFrom);
        const hUFrom = uFromAsTile.hash();
        const uToAsTile = Tile.fromJSON(uTo);
        const hUTo = uToAsTile.hash();

        // Push to DA
        const uFromEnc = enqueueTile(uFromAsTile);
        const uToEnc = enqueueTile(uToAsTile);

        claimedMoves.set(hUFrom.concat(hUTo), {
            uFrom: uFromAsTile,
            uTo: uToAsTile,
            blockSubmitted: currentBlockHeight,
            uFromEnc,
            uToEnc,
        });

        const digest = utils.solidityKeccak256(
            ["uint256", "uint256", "uint256"],
            [currentBlockHeight, hUFrom, hUTo]
        );
        const sig = await signer.signMessage(utils.arrayify(digest));

        socket.emit("moveSignatureResponse", sig, currentBlockHeight);
        playerLatestBlock.set(sender, currentBlockHeight);

        // Clear queue if DA node is online
        dequeueTileIfDAConnected();
    } else {
        // Cut the connection
        socket.disconnect();
    }
}

/*
 * Exposes secrets at location l if a requesting player proves ownership of
 * neighboring tile.
 */
function decrypt(socket: Socket, l: Location) {
    if (inRecoveryMode || !idToAddress.has(socket.id)) {
        socket.disconnect();
        return;
    }

    const owner = new Player("", idToAddress.get(socket.id)!);
    if (b.noFog(l, owner)) {
        socket.emit("decryptResponse", b.getTile(l).toJSON());
    } else {
        socket.emit("decryptResponse", Tile.mystery(l).toJSON());
    }
}

/*
 * When a player disconnects, we remove the relation between their socket ID and
 * their public key. This is so that no other player gains that ID and can play
 * on their behalf.
 */
function disconnect(socket: Socket) {
    const address = idToAddress.get(socket.id);
    if (address) {
        addressToId.delete(address);
        idToAddress.delete(socket.id);
    }
    if (socketIdDA == socket.id) {
        socketIdDA = undefined;
    }
    console.log("Disconnected:", socket.id);
}

/*
 * Callback function for when a NewSpawnAttempt event is emitted. Event is
 * emitted when a player tries to spawn in, whether or not they can. After
 * doing so, they should be allowed to try to spawn again.
 */
function onSpawnAttempt(player: string, success: boolean) {
    if (inRecoveryMode) {
        return;
    }

    const spawn = claimedSpawns.get(player);
    claimedSpawns.delete(player);
    const socketId = addressToId.get(player);

    if (success && spawn && socketId) {
        // Spawn in player
        b.setTile(spawn.spawnTile);

        playerLatestBlock.set(player, 0);

        enqueueTile(spawn.spawnTile);
        dequeueTileIfDAConnected();

        const visibleLocs = b
            .getNearbyLocations(spawn.spawnTile.loc)
            .map((loc) => JSON.stringify(loc));

        io.to(socketId).emit("loginResponse", visibleLocs);
    } else if (!success) {
        io.to(socketId).emit("trySpawn");
    } else if (socketId) {
        console.error(`Player ${player} spawned without a signature.`);
    }
}

/*
 * Callback function for when a NewMove event is emitted. Reads claimed move
 * into enclave's internal beliefs, and alerts players in range to decrypt.
 */
function onMoveFinalize(hUFrom: string, hUTo: string) {
    if (inRecoveryMode) {
        return;
    }
    const moveHash = hUFrom.concat(hUTo);
    const move = claimedMoves.get(moveHash);
    if (move) {
        // Move is no longer pending
        claimedMoves.delete(moveHash);

        // Before state is updated, we need the previous 'to' tile owner
        const tTo = b.getTile(move.uTo.loc);
        const newOwner = move.uTo.owner.address;
        const prevOwner = tTo.owner.address;
        const ownershipChanged = prevOwner !== newOwner;

        // Alert all nearby players that an updateDisplay is needed
        let updatedLocs = [move.uFrom.loc];
        if (ownershipChanged && tTo.isCapital()) {
            b.playerCities.get(prevOwner)?.forEach((cityId: number) => {
                b.cityTiles.get(cityId)?.forEach((locString: string) => {
                    const loc = JSON.parse(locString);
                    if (loc) {
                        updatedLocs.push(loc);
                    }
                });
            });
        } else if (ownershipChanged && tTo.isCityCenter()) {
            b.cityTiles.get(tTo.cityId)?.forEach((locString: string) => {
                const loc = JSON.parse(locString);
                if (loc) {
                    updatedLocs.push(loc);
                }
            });
        } else {
            updatedLocs.push(move.uTo.loc);
        }

        // Update state
        b.setTile(move.uFrom);
        b.setTile(move.uTo);

        // Add finalized states and try to send to DA
        enqueueTile(move.uFrom);
        enqueueTile(move.uTo);
        dequeueTileIfDAConnected();

        alertPlayers(newOwner, prevOwner, updatedLocs);
    } else {
        console.error(
            `Move: (${hUFrom}, ${hUTo}) was finalized without a signature.`
        );
    }
}

/*
 * Helper function for onMoveFinalize. Pings players when locations should be
 * decrypted. For each location in updatedLocs, the previous and new owner
 * decrypt all tiles in the 3x3 region, and nearby players decrypt the tile in
 * updatedLocs.
 */
function alertPlayers(
    newOwner: string,
    prevOwner: string,
    updatedLocs: Location[]
) {
    let alertPlayerMap = new Map<string, Set<string>>();

    for (let loc of updatedLocs) {
        const locString = JSON.stringify(loc);
        for (let l of b.getNearbyLocations(loc)) {
            const tileOwner = b.getTile(l).owner.address;
            const lString = JSON.stringify(l);

            if (!alertPlayerMap.has(tileOwner)) {
                alertPlayerMap.set(tileOwner, new Set<string>());
            }
            alertPlayerMap.get(tileOwner)?.add(locString);
            alertPlayerMap.get(newOwner)?.add(lString);
            alertPlayerMap.get(prevOwner)?.add(lString);
        }
    }

    alertPlayerMap.forEach((tiles: Set<string>, pubkey: string) => {
        const socketId = addressToId.get(pubkey);
        if (socketId) {
            io.to(socketId).emit("updateDisplay", Array.from(tiles));
        }
    });
}

/*
 * Sets the socket ID of the DA node, if not already set. Sends back
 * inRecoveryMode variable.
 */
function handshakeDA(socket: Socket) {
    if (socketIdDA == undefined) {
        socketIdDA = socket.id;
        io.to(socketIdDA).emit("handshakeDAResponse", inRecoveryMode);
    } else {
        // If DA socket ID is already set, then do nothing and break connection
        socket.disconnect();
    }
}

/*
 * Read from DA node for recovery process.
 */
async function sendRecoveredTileResponse(socket: Socket, encTile: any) {
    if (socketIdDA == undefined || socket.id != socketIdDA) {
        socket.disconnect();
        return;
    }

    const ciphertext = encTile.ciphertext;
    const iv = encTile.iv;
    const tag = encTile.tag;

    if (!ciphertext || !iv || !tag) {
        return;
    }

    const tile = Utils.decryptTile(tileEncryptionKey, ciphertext, iv, tag);

    // Push tile into state if it's hash has been emitted
    const newTileEvents: ethers.Event[] = await nStates.queryFilter(
        nStates.filters.NewTile()
    );
    let hashHistory = new Set<string>();
    newTileEvents.forEach((e) => {
        hashHistory.add(e.args?.hTile.toString());
    });

    if (tile && hashHistory.has(tile.hash())) {
        if (!b.isSpawned(tile.owner)) {
            b.spawn(
                tile.loc,
                tile.owner,
                START_RESOURCES,
                tile.cityId,
                undefined
            );
            cityId++;
        } else {
            b.setTile(tile);
        }

        console.log(`Tile ${recoveryModeIndex}: success`);
    } else {
        console.error(`Tile ${recoveryModeIndex}: failure`);
    }

    // Request next tile
    recoveryModeIndex++;
    io.to(socketIdDA).emit("sendRecoveredTile", recoveryModeIndex);
}

/*
 * Continue to push encrypted tiles to DA node.
 */
function saveToDatabaseResponse(socket: Socket) {
    if (socketIdDA == undefined || socket.id != socketIdDA) {
        socket.disconnect();
        return;
    }
    dequeueTileIfDAConnected();
}

/*
 * Wrap-up function when DA reports a finished recovery.
 */
function finishRecovery(socket: Socket) {
    if (socketIdDA == undefined || socket.id != socketIdDA) {
        socket.disconnect();
        return;
    }
    console.log("Recovery finished");
    b.printView();

    // Enable play
    inRecoveryMode = false;
}

/*
 * Encrypt and enqueue tile.
 */
function enqueueTile(tile: Tile): EncryptedTile {
    const { ciphertext, iv, tag } = Utils.encryptTile(tileEncryptionKey, tile);
    const enc = {
        symbol: tile.owner.symbol,
        address: tile.owner.address,
        ciphertext,
        iv,
        tag,
    };
    queuedTilesDA.enqueue(enc);
    return enc;
}

/*
 * Submit encrypted tile to DA node to push into database.
 */
function dequeueTileIfDAConnected() {
    if (socketIdDA != undefined && queuedTilesDA.length > 0) {
        let encTile = queuedTilesDA.dequeue();
        io.to(socketIdDA).emit("saveToDatabase", encTile);
    }
}

/*
>>>>>>> 12af9f3a1b393e19fd072d8eadcae8bdd96e4629
 * Callback function called on new block events. Deletes claimed moves that
 * are unresolved for too long.
 */
function upkeepClaimedMoves() {
    for (let [h, c] of claimedMoves.entries()) {
        if (currentBlockHeight > c.blockSubmitted + CLAIMED_MOVE_LIFE_SPAN) {
            claimedMoves.delete(h);
        }
    }
}

/*
 * Attach event handlers to a new connection.
 */
io.on("connection", (socket: Socket) => {
    console.log("Connected: ", socket.id);

    socket.on("login", (address: string, sig: string) => {
        login(socket, address, sig);
    });
    socket.on(
        "getSpawnSignature",
        async (symb: string, address: string, sig: string, s: string) => {
            getSpawnSignature(socket, symb, address, sig, s);
        }
    );
    socket.on("handshakeDA", () => {
        handshakeDA(socket);
    });
    socket.on("getMoveSignature", async (uFrom: any, uTo: any) => {
        getMoveSignature(socket, uFrom, uTo);
    });
    socket.on("decrypt", (l: Location) => {
        decrypt(socket, l);
    });
    socket.on("sendRecoveredTileResponse", (encTile: any) => {
        sendRecoveredTileResponse(socket, encTile);
    });
    socket.on("recoveryFinished", () => {
        finishRecovery(socket);
    });
    socket.on("saveToDatabaseResponse", () => {
        saveToDatabaseResponse(socket);
    });
    socket.on("disconnecting", () => {
        disconnect(socket);
    });
});

nStates.on(nStates.filters.NewSpawnAttempt(), (player, success) => {
    onSpawnAttempt(player, success);
});

/*
 * Event handler for NewMove event. io is passed in so that we can ping players.
 */
nStates.on(nStates.filters.NewMove(), (hUFrom, hUTo) => {
    onMoveFinalize(hUFrom.toString(), hUTo.toString());
});

/*
 * Event handler for new blocks. Claimed moves that have been stored for too
 * long should be deleted.
 */
nStates.provider.on("block", async (n) => {
    currentBlockHeight = n;
    upkeepClaimedMoves();
});

/*
 * Start server & initialize game.
 */
server.listen(process.env.ENCLAVE_SERVER_PORT, async () => {
    b = new Board();

    const terrainUtils = new TerrainUtils();
    await terrainUtils.setup();

    if (inRecoveryMode) {
        // Get previous encryption key
        tileEncryptionKey = Buffer.from(
            fs.readFileSync(process.env.ENCRYPTION_KEY_PATH!, {
                encoding: "utf8",
            }),
            "hex"
        );

        // Seed board, but do not update global state
        await b.seed(BOARD_SIZE, true, undefined, terrainUtils.getTerrainAtLoc);

        // Cannot recover until DA node connects
        console.log("In recovery mode, waiting for DA node to connect");
    } else {
        // [TODO] wait for sufficient time post start up to get from PRNG

        // Generate and save encryption key
        tileEncryptionKey = Utils.genAESEncKey();
        fs.writeFileSync(
            process.env.ENCRYPTION_KEY_PATH!,
            tileEncryptionKey.toString("hex")
        );

        await b.seed(BOARD_SIZE, true, nStates, terrainUtils.getTerrainAtLoc);

        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                enqueueTile(b.t[r][c]);
            }
        }
    }

    console.log(
        `Server running on http://localhost:${process.env.ENCLAVE_SERVER_PORT}`
    );
});
