# Stablecoin Depeg AVS Example

This repo, forked from [hello-world-avs](https://github.com/Layr-Labs/hello-world-avs), uses the AVS to rapidly review stablecoin depeg claims. Once a depeg event is confirmed, any cover for that stablecoin, with an active duration encompassing it, can be immediatly eligible for a payout.

This demo simulates depeg tasks being created by generating a pair of random timestamps and passing them to `createNewTask()` inside `/operator/createNewTask.ts`. The operator script that is monitoring for new tasks will validate the input data and then check the average USD price during the reported depeg event. If the average price is below the `PRICE_THRESHOLD` value specified in `/operator/index.ts`, then the operator will respond to the task using the `DepegServiceManager`'s `respondToTask()`.

- Note that the current operator script uses the free [CoinGecko API key](https://support.coingecko.com/hc/en-us/articles/21880397454233-User-Guide-How-to-sign-up-for-CoinGecko-Demo-API-and-generate-an-API-key) and is restricted to data within the last 365 days.

### Example Flow

1. User buys a stablecoin Depeg cover and receives a sales policy NFT.
2. The stablecoin they hold depegs for **x** amount of time and decreases in value below **y** threshold.
3. Anyone interacts with the `DepegServiceManager` to create a task using relevant input data.
   - `createNewTask()`
   - Inputs a timestamp at which a stablecoin depegged, operators can define the exact timeframe in their responses.
4. An operator monitoring the contract's task events can perform computation to validate or invalidate the task by responding to it.
   - `respondToTask()`
   - This can be aggregated BLS signatures from multiple operators if we require **z** signatures for a response.

## Quick Start

To setup and run the code, you'll need to open three different terminals.

### Initial Setup + Starting Local Anvil Chain _(First Terminal)_

```sh
# Clone the repo:
git clone https://github.com/RohanNero/avs-depeg-demo

# Install the dependencies:
npm install

# Create `.env` files and populate them with a private key (default works) and CoinGecko API key:
cp .env.example .env
cp contracts/.env.example contracts/.env

# Start local anvil chain (Foundry):
anvil
```

### Deploy Contracts + Start Operator _(Second Terminal)_

```sh
# Compile the smart contracts:
npm run build

# Deploy the EigenLayer core contracts:
npm run deploy:core

# Deploy our Depeg AVS contracts:
npm run deploy:depeg

# Update ABIs (For off-chain scripts):
npm run extract:abis

# Start the Operator application (Monitors for new tasks):
npm run start:operator
```

### Start Creating New Tasks _(Third Terminal)_

```sh
# Create new Depeg-AVS Tasks:
npm run start:traffic
```

## Breakdown

To outline the main pieces of this example briefly:

- `/contracts/src/DepegServiceManager.sol` is our smart contract.
- `/operator/createNewTask.ts` is a script for creating tasks on the `DepegServiceManager` contract.
- `/operator/index.ts` is a script that actively monitors our contract for task creation events, and subsequently responds to them using the `DepegServiceManager` contract's `respondToTask()`.

### DepegServiceManager.sol

This contract does two main things:

1. Connects to the Eigenlayer core contracts and inherits the required functionality.
2. Contains a pair of core functions that are in charge of:
   - Creating new tasks with `createNewTask()`.
   - Responding to created tasks with `RespondToTask()`.

In the case of stablecoin depeg, the data can potentially be confirmed on-chain using historical price data from an on-chain oracle provider. This isn't the case for other types of cover such as **Smart Contract** and **Validator Slashing** cover. These aren't as easily verifiable and thus would be reliant on operator consensus, and potentially the opinion of an AI/LLM. To remain consistent with future integrations, such as these two mentioned, it may be better to exclude any additional on-chain verification and solely rely on the AVS operators (Or a mock AI/LLM response?).

#### Chainlink Integration

One solution, only applicable to stablecoin depegs, to verify the AVS response would be to use historical data from chainlink's USDC/USD pair. Their `getAnswer()` function takes a `uint256 roundId` as input, allowing you to view prices that were reported in the past. In order to easily verify that the `roundId` corresponds to a certain timeframe, we can make operators provide a timestamp which will then be compared against the return data from Chainlink's `getTimestamp(uint256 roundId)` function. As previously stated, since implementing additional validation checks would be specific to depeg cover, it may be in our best interest to exclude this part for the time being/demonstration purposes.

#### Task Object

The `struct Task` should always contain relevant data that can be used to prove task validity.

Currently, our `Task` contains the token address, two timestamps, defining the timeframe of the depeg event, and an array of strings that can be used to site sources for which the price data originated. Now when operators respond to the created tasks, they can directly compare the timeframe against the prices recorded at the `sources` URLs. It may be in our best interest to provide a list of acceptable price sources that are credible, this way malicious entities can't create their own `sources` with inaccurate price data.

```sol
struct Task {
        address token;
        uint40 startingTimestamp;
        uint40 endingTimestamp;
        string[] sources;
        uint32 taskCreatedBlock;
    }
```

We still must consider what happens if a task is created with a timeframe that doesn't accurately define the depeg event. Consider this example flow:

1. USDC depegs from 0 `startingTimestamp` - 100 `endingTimestamp`.
2. Task is created with `startingTimestamp` = 0 and `endingTimestamp` = 75.
3. Task is responded to and:
   - The task is marked valid because technically the data is correct (depeg event did occur at the timestamps).
   - The task is marked invalid because the timestamps don't accurately encompass the entire duration of the depeg.
   - The task is marked valid and updated to have `startingTimestamp` = 0 and `endingTimestamp` = 100.
4. If Valid, all `SalesPolicy` NFTs active during the depeg time are automatically eligible for a pay out.

On top of deciding how we handle responding to the tasks, we also need a method of preventing multiple tasks being created for the same depeg event.

- Off-chain operator logic can view previous task timestamps and compare to newly created timestamps, but this doesn't solve duplicate tasks being created, only responded to.
- On-chain logic inside `DepegServiceManager` could check to see if the timestamps fall within another task's, but this could get expensive to execute once multiple tasks are created.

Either way, the operators should probably contain logic marking all of the depeg event timestamps to prevent duplicate tasks (If the operators are the only ones allowed to create new tasks, this would solve the above issue).

- Create a standardized method/container for operators to keep track of all depeg events.

### CreateNewTasks.ts

This typescript script is in charge of creating the data for new tasks and calling the `DepegServiceManager.sol` contract's `createNewTask()` function.

In reality this would be any entity who wants to report a depeg event, they don't necessarily have to be someone holding a `SalesPolicy` NFT for depeg cover. The important thing is to standardize the form of the task input so that anyone can compile the same type of "data object" to be passed to the `DepegServiceManager.sol` contract. Depending on the finalized Uno Re stablecoin depeg cover terms and conditions, this value could be a stablecoin contract address and 2 timestamps that are `x` amount of time apart from one another (At which the price of the stablecoin was below an explicitly set minimum).

### Index.ts

This typescript script is in charge of:

1. Registering an AVS operator to the core Eigenlayer contracts that are deployed locally.
2. Monitoring the `DepegServiceManager.sol` contract for new tasks to be created, in which it will verify the task data and respond to the task.
   - If the task data contains 2 timestamps, the operator would then view the price at these times, and the time in between, to ensure the token really did depeg.
   - If the operator responds that the task is valid, the `DepegServiceManager.sol` could either wait for other operators to confirm the validity, or unique to stablecoin depegs, it could use historical data from an on-chain pricefeed to doublecheck that the stablecoin deviated from its pegged price during the inputted timeframe.
