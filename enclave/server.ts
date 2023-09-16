import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import { ethers, utils } from "ethers";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" });
import {
    ServerToClientEvents,
    ClientToServerEvents,
    InterServerEvents,
    SocketData,
} from "./socket";
import { Tile, Player, Board, Location, Utils } from "../game";

/*
 * Set game parameters and create dummy players.
 */
const BOARD_SIZE: number = parseInt(<string>process.env.BOARD_SIZE, 10);
const START_RESOURCES: number = parseInt(
    <string>process.env.START_RESOURCES,
    10
);

const PRIVKEYS = JSON.parse(<string>process.env.ETH_PRIVKEYS);
const PLAYER_A: Player = new Player("A", BigInt(PRIVKEYS["A"]));
const PLAYER_B: Player = new Player("B", BigInt(PRIVKEYS["B"]));
const PLAYER_C: Player = new Player("C", BigInt(PRIVKEYS["C"]));

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
    <string>process.env.DEV_PRIV_KEY,
    new ethers.providers.JsonRpcProvider(process.env.RPC_URL)
);
const nStates = new ethers.Contract(
    <string>process.env.CONTRACT_ADDR,
    require(<string>process.env.CONTRACT_ABI).abi,
    signer
);

/*
 * Enclave's internal belief on game state stored in Board object.
 */
let b: Board;

/*
 * Adjust internal state based on claimed move & notifies all users to
 * update their local views.
 */
function move(tFrom: any, tTo: any, uFrom: any, uTo: any) {
    b.setTile(Tile.fromJSON(uFrom));
    b.setTile(Tile.fromJSON(uTo));
    io.sockets.emit("updateDisplay");
}

/*
 * Propose move to enclave. In order for the move to be solidified, the enclave
 * must respond to a leaf event.
 */
async function propose(socket: Socket, uFrom: any, uTo: any) {
    const uFromAsTile = Tile.fromJSON(uFrom);
    const hUFrom = uFromAsTile.hash();
    const uToAsTile = Tile.fromJSON(uTo);
    const hUTo = uToAsTile.hash();

    const digest = utils.solidityKeccak256(
        ["uint256", "uint256"],
        [hUFrom, hUTo]
    );
    const sig = await signer.signMessage(utils.arrayify(digest));

    socket.emit("proposeResponse", sig, uFrom, uTo);
}

/*
 * Alert enclave that solidity accepted new states into the global state.
 * Enclave should confirm by checking NewLeaf events and change it's own belief.
 *
 * [TODO]: automate this with an Alchemy node.
 */
async function ping(socket: Socket, uFrom: any, uTo: any) {
    const uFromAsTile = Tile.fromJSON(uFrom);
    const hUFrom = BigInt(uFromAsTile.hash());
    const uToAsTile = Tile.fromJSON(uTo);
    const hUTo = BigInt(uToAsTile.hash());

    const newLeafEvents = await nStates.queryFilter(nStates.filters.NewLeaf());
    const leaves: ethers.BigNumber[] = newLeafEvents.map((e) => e.args?.h);

    let hUFromFound,
        hUToFound = false;
    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i].toBigInt();
        if (leaf === hUFrom) {
            hUFromFound = true;
        }
        if (leaf === hUTo) {
            hUToFound = true;
        }
    }

    if (hUFromFound && hUToFound) {
        // Update enclave belief
        b.setTile(uFromAsTile);
        b.setTile(uToAsTile);
        socket.emit("pingResponse", true, uFrom, uTo);
        return;
    }
    socket.emit("pingResponse", false, uFrom, uTo);
}

/*
 * Exposes secrets at location l if a requesting player proves ownership of
 * neighboring tile.
 */
function decrypt(
    socket: Socket,
    l: Location,
    reqPlayer: Player,
    sigStr: string
) {
    const h = Player.hForDecrypt(l);
    const sig = Utils.unserializeSig(sigStr);
    if (sig && reqPlayer.verifySig(h, sig) && b.noFog(l, reqPlayer)) {
        socket.emit("decryptResponse", b.getTile(l).toJSON());
        return;
    }
    socket.emit("decryptResponse", Tile.mystery(l).toJSON());
}

/*
 * Dev function for spawning default players on the map. Player A isn't spawned
 * so we can test client spawn.
 */
async function spawnPlayers() {
    await b.spawn({ r: 0, c: 0 }, PLAYER_A, START_RESOURCES, nStates);
    await b.spawn(
        { r: 0, c: BOARD_SIZE - 1 },
        PLAYER_B,
        START_RESOURCES,
        nStates
    );
    await b.spawn(
        { r: BOARD_SIZE - 1, c: 0 },
        PLAYER_C,
        START_RESOURCES,
        nStates
    );
}

/*
 * Attach event handlers to a new connection.
 */
io.on("connection", (socket: Socket) => {
    console.log("Client connected: ", socket.id);

    socket.on("move", move);
    socket.on("propose", (uFrom: any, uTo: any) => {
        propose(socket, uFrom, uTo);
    });
    socket.on("ping", (uFrom: any, uTo: any) => {
        ping(socket, uFrom, uTo);
    });
    socket.on("decrypt", (l: Location, pubkey: string, sig: string) => {
        decrypt(socket, l, Player.fromPubString(pubkey), sig);
    });
});

/*
 * Start server & initialize game.
 */
server.listen(process.env.SERVER_PORT, async () => {
    b = new Board();
    await b.seed(BOARD_SIZE, true, nStates);
    await spawnPlayers();

    console.log(
        `Server running on http://localhost:${process.env.SERVER_PORT}`
    );
});
