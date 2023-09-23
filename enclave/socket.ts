import { Location, Player } from "../game";

interface ServerToClientEvents {
    decryptResponse: (t: any) => void;
    getSignatureResponse: (sig: string, uFrom: any, uTo: any) => void;
    updateDisplay: (l: Location) => void;
}

interface ClientToServerEvents {
    spawn: (l: Location, pubkey: string, sig: string) => void;
    decrypt: (l: Location, pubkey: string, sig: string) => void;
    getSignature: (uFrom: any, uTo: any) => void;
}

interface InterServerEvents {
    hello: () => void;
}

interface SocketData {
    name: string;
}

export {
    ServerToClientEvents,
    ClientToServerEvents,
    InterServerEvents,
    SocketData,
};
