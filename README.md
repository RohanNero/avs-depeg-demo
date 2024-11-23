# Stablecoin Depeg AVS Example

This repo, forked from [hello-world-avs](https://github.com/Layr-Labs/hello-world-avs), uses the AVS to rapidly review stablecoin depeg claims. Once a depeg event is confirmed, any cover for that stablecoin, with an active duration encompassing it, can be immediatly eligible for a payout.

### Example Flow

1. User buys a stablecoin Depeg cover and receives sales policy NFT.
2. The stablecoin they hold depegs for x amount of time and decreases in value below y threshold.
3. The user, or anyone, can interact with the `DepegServiceManager` to create a task using relevant input data.
4. An AVS monitoring the contract events can perform computation to validate or invalidate the task by responding to it.

## Quick Start

To setup and run the code, you'll need to open three different terminals.

### First Terminal

Clone the repo:

```sh
git clone
```

Install the dependencies:

```sh
npm install
```

Start local anvil chain (Foundry):

```sh
anvil
```

### Second Terminal

Create `.env` files and populate them with a private key (default works):

```sh
cp .env.example .env
cp contracts/.env.example contracts/.env
```

Compile the smart contracts:

```sh
npm run build
```

Deploy the EigenLayer core contracts:

```sh
npm run deploy:core
```

Deploy our Depeg AVS contracts:

```sh
npm run deploy:depeg
```

Update ABIs (Optional):

```sh
npm run extract:abis
```

Start the Operator application (Monitor for new tasks):

```sh
npm run start:operator
```

### Third Terminal

Create new Depeg-AVS Tasks:

```sh
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

### CreateNewTasks.ts

This typescript script is in charge of creating the data for new tasks and calling the `DepegServiceManager.sol` contract's `createNewTask()` function.

In reality this would be any entity who wants to report a depeg event, they don't necessarily have to be someone holding a `SalesPolicy` NFT for depeg cover. The important thing is to standardize the form of the task input so that anyone can compile the same type of "data object" to be passed to the `DepegServiceManager.sol` contract. Depending on the finalized Uno Re stablecoin depeg cover terms and conditions, this value could be a stablecoin contract address and 2 timestamps that are `x` amount of time apart from one another (At which the price of the stablecoin was below an explicitly set minimum).

### Index.ts

This typescript script is in charge of:

1. Registering an AVS operator to the core Eigenlayer contracts that are deployed locally.
2. Monitoring the `DepegServiceManager.sol` contract for new tasks to be created, in which it will verify the task data and respond to the task.
   - If the task data contains 2 timestamps, the operator would then view the price at these times, and the time in between, to ensure the token really did depeg.
   - If the operator responds that the task is valid, the `DepegServiceManager.sol` could either wait for other operators to confirm the validity, or unique to stablecoin depegs, it could use historical data from an on-chain pricefeed to doublecheck that the stablecoin deviated from its pegged price during the inputted timeframe.
