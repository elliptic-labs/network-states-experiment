# Set env variables 
source ../../.env

# Deploy contract to local chain
forge create src/NStates.sol:NStates \
    --rpc-url $RPC_URL \
    --private-key $DEV_PRIV_KEY \
    --constructor-args $DEV_CONTRACT_OWNER $TREE_DEPTH $NOTHING_UP_MY_SLEEVE \
        $TROOP_UPDATE_INTERVAL $WATER_UPDATE_INTERVAL
